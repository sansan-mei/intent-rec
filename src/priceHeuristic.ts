/**
 * 确定性价位推断：行话映射 + 中文/阿拉伯数字与「左右」「不超过」等口径。
 * 与 LLM 结果合并：**本模块在某侧给出非空值时覆盖模型同侧**。
 */

import { KAI_DIGIT, rangeForKaiOpen } from "./priceKaiOpen";
import { preprocessUserPriceTerms } from "./preprocessPriceTerms";
import { PRICE_SLANG_LEXICON } from "./priceSlangLexicon";
import type { SearchParams } from "./searchSchema";

/** 「左右」类表述：中心价浮动（可与产品对齐） */
const AROUND_LOW = 0.8;
const AROUND_HIGH = 1.2;

export type PriceHeuristicMeta = {
  hits: string[];
};

export type PriceHeuristic = {
  price_min: number | null;
  price_max: number | null;
  meta: PriceHeuristicMeta;
};

type LexEntry = { patterns: string[]; min: number; max: number };

const LEXICON: LexEntry[] = PRICE_SLANG_LEXICON;

/**
 * 判断行话词是否只是「小/中/大五六七 N 开」结构的一部分，避免重复命中较短行话。
 */
function lexiconPatternShadowedByKai(text: string, p: string): boolean {
  let from = 0;
  while (true) {
    const i = text.indexOf(p, from);
    if (i < 0) return false;
    const rest = text.slice(i + p.length);
    if (/^[一二三四五六七八九]开/.test(rest)) return true;
    from = i + 1;
  }
}

/**
 * 判断「中五价位」这类词是否只是更长「价位」短语的一部分，避免误命中「中五价」。
 */
function lexiconJiaFollowedByWei(text: string, p: string): boolean {
  if (!p.endsWith("价")) return false;
  let from = 0;
  while (true) {
    const i = text.indexOf(p, from);
    if (i < 0) return false;
    if (text.slice(i + p.length, i + p.length + 1) === "位") return true;
    from = i + 1;
  }
}

/**
 * 展平价位行话词典，并按词长倒序排列，供长词优先匹配使用。
 */
function lexiconExpandPairs(): { pattern: string; min: number; max: number }[] {
  return LEXICON.flatMap((e) =>
    e.patterns.map((pattern) => ({
      pattern: pattern.trim(),
      min: e.min,
      max: e.max,
    }))
  ).sort((a, b) => b.pattern.length - a.pattern.length);
}

/**
 * 把行话价位词换成「min-max」数字区间（长词先替换）。
 * {@link extractHeuristicPrice} 仍使用**用户原句**，不因本函数改变。
 */
export function expandLexiconPriceTermsForLlmMessage(message: string): string {
  return preprocessUserPriceTerms(message).text;
}

/**
 * 与 {@link extractHeuristicPriceFromSegments} 相同：按换行切分。
 * 每一段对应用户连续发送的一条描述（一条 HumanMessage）；单行无换行则整段一条。
 */
export function splitUserMessageLineSegments(message: string): string[] {
  const text = message.trim();
  if (!text) return [];
  const parts = text
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [text];
}

const CN_UNIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 解析一到两位中文小数字，如「十」「十三」「三十六」。
 */
function smallChineseSection(s: string): number | null {
  if (!s || s === "十") return 10;
  const m = s.match(/^十([一二三四五六七八九])?$/);
  if (m) return 10 + (m[1] ? CN_UNIT[m[1]] ?? 0 : 0);
  const m2 = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/);
  if (m2) {
    const a = CN_UNIT[m2[1]] ?? 0;
    const b = m2[2] ? CN_UNIT[m2[2]] ?? 0 : 0;
    return a * 10 + b;
  }
  if (s.length === 1 && CN_UNIT[s] !== undefined) return CN_UNIT[s];
  return null;
}

/**
 * 解析 0 到 999 范围内的中文数字片段，支持「百」位。
 */
function sectionTo999(s: string): number | null {
  if (!s) return 0;
  const baiIdx = s.indexOf("百");
  if (baiIdx >= 0) {
    const h = s.slice(0, baiIdx);
    const head = h ? CN_UNIT[h] ?? smallChineseSection(h) : 1;
    if (head === null) return null;
    const tail = s.slice(baiIdx + 1);
    const rest = tail ? CN_UNIT[tail] ?? smallChineseSection(tail) : 0;
    if (rest === null) return null;
    return head * 100 + rest;
  }
  return smallChineseSection(s) ?? CN_UNIT[s] ?? null;
}

/**
 * 解析 0 到 9999 范围内的中文数字片段，支持「千」位。
 */
function sectionTo9999(s: string): number | null {
  if (!s) return 0;
  const qIdx = s.indexOf("千");
  if (qIdx >= 0) {
    const headStr = s.slice(0, qIdx);
    const h =
      headStr.length === 0
        ? 1
        : CN_UNIT[headStr] ?? smallChineseSection(headStr);
    if (h === null) return null;
    const tail = s.slice(qIdx + 1);
    const t = tail ? sectionTo999(tail) : 0;
    if (t === null) return null;
    return h * 1000 + t;
  }
  return sectionTo999(s);
}

/**
 * 如「三万五」= 3.5 万；「三万一千」= 31000。
 */
export function parseChineseMoneyLoose(raw: string): number | null {
  const s = raw.replace(/\s+/g, "").trim();
  if (!s) return null;

  const arab = s.match(/^([\d,]+(?:\.\d+)?)$/);
  if (arab) return Number.parseFloat(arab[1].replace(/,/g, ""));

  const wanIdx = s.indexOf("万");
  if (wanIdx >= 0) {
    const left = s.slice(0, wanIdx);
    const right = s.slice(wanIdx + 1);
    const leftN = sectionTo9999(left);
    if (leftN === null) return null;
    let total = leftN * 10_000;
    if (right) {
      if (/^[一二三四五六七八九]$/.test(right)) {
        total += (CN_UNIT[right] ?? 0) * 1000;
      } else {
        const r = sectionTo9999(right);
        if (r !== null) total += r;
      }
    }
    return total;
  }

  const qIdx = s.indexOf("千");
  if (qIdx >= 0) {
    const headStr = s.slice(0, qIdx);
    const h =
      headStr.length === 0
        ? 1
        : CN_UNIT[headStr] ?? smallChineseSection(headStr);
    if (h === null) return null;
    let v = h * 1000;
    const rest = s.slice(qIdx + 1);
    if (rest) {
      const tail = sectionTo999(rest);
      if (tail === null) return null;
      v += tail;
    }
    return v;
  }

  return sectionTo9999(s);
}

/**
 * 将阿拉伯数字字符串标准化为 number，支持逗号分隔。
 */
function normArab(tok: string): number | null {
  const t = tok.replace(/,/g, "").trim();
  if (!t) return null;
  const a = Number.parseFloat(t);
  return Number.isFinite(a) ? a : null;
}

/**
 * 根据单位后缀把数字缩放为元；支持万/w、千/k，缺省时直接四舍五入。
 */
function scale(n: number, suf: string | undefined): number {
  if (!suf) return Math.round(n);
  const u = suf.toLowerCase();
  if (u === "万" || u === "w") return Math.round(n * 10_000);
  if (u === "千" || u === "k") return Math.round(n * 1000);
  return Math.round(n);
}

/**
 * 判断相邻文本是否包含预算/价格语境，用于降低裸数字误判为金额的概率。
 */
function hasPriceContext(near: string): boolean {
  return /预算|价位|价格|多少钱|成交|元|块|不超过|封顶|上限|以内|以下|至少|不低于|不少于|开价|给价|行话|价位段|心理价|承受|千元左右|万左右|块钱|捡漏|超值/u.test(
    near
  );
}

/**
 * 判断 `18k`、`24K` 这类 token 是否更像金饰纯度，而不是预算金额。
 */
function isLikelyGoldPurityK(
  rawNum: string,
  text: string,
  start: number,
  end: number
): boolean {
  const n = normArab(rawNum);
  if (n === null) return false;
  const near = text.slice(Math.max(0, start - 8), Math.min(text.length, end + 8));
  const hasJewelryContext =
    /金|k金|黄金|白金|铂金|pt|au750|镶嵌|珍珠|吊坠|耳饰|戒指|项链|手链|和田玉/u.test(
      near
    );
  const noPriceContext = !hasPriceContext(near);
  const looksLikePurityValue = Number.isInteger(n) && n >= 8 && n <= 24;
  if (looksLikePurityValue && hasJewelryContext && noPriceContext) return true;

  const onlyToken = text.trim().match(/^([\d,]+(?:\.\d+)?)\s*[kK]$/u);
  if (onlyToken && (n === 14 || n === 18 || n === 22 || n === 24)) return true;

  return false;
}

type Acc = { min: number | null; max: number | null };

/**
 * 用新的闭区间收紧累计价格范围，并记录命中来源。
 */
function tightenRange(
  acc: Acc,
  lo: number,
  hi: number,
  hit: string,
  hits: string[]
) {
  hits.push(hit);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  acc.min = acc.min === null ? a : Math.max(acc.min, a);
  acc.max = acc.max === null ? b : Math.min(acc.max, b);
}

/**
 * 应用价格上限约束，并记录命中来源。
 */
function applyCap(acc: Acc, cap: number, hit: string, hits: string[]) {
  hits.push(hit);
  acc.max = acc.max === null ? cap : Math.min(acc.max, cap);
}

/**
 * 应用价格下限约束，并记录命中来源。
 */
function applyFloor(acc: Acc, floor: number, hit: string, hits: string[]) {
  hits.push(hit);
  acc.min = acc.min === null ? floor : Math.max(acc.min, floor);
}

/**
 * 将「左右/上下」类中心价转换为浮动区间，并合并到累计价格范围。
 */
function applyAround(acc: Acc, center: number, hits: string[]) {
  hits.push(`around:${center}×${AROUND_LOW}~${AROUND_HIGH}`);
  const lo = Math.max(0, Math.round(center * AROUND_LOW));
  const hi = Math.max(0, Math.round(center * AROUND_HIGH));
  acc.min = acc.min === null ? lo : Math.max(acc.min, lo);
  acc.max = acc.max === null ? hi : Math.min(acc.max, hi);
}

/**
 * 从用户原句抽取价位区间（若无命中则为 null）。
 */
export function extractHeuristicPrice(message: string): PriceHeuristic {
  const text = message.trim();
  const hits: string[] = [];
  if (!text) {
    return { price_min: null, price_max: null, meta: { hits } };
  }

  const acc: Acc = { min: null, max: null };

  const flatLex = LEXICON.flatMap((e) =>
    e.patterns.map((p) => ({ p, lo: e.min, hi: e.max }))
  ).sort((a, b) => b.p.length - a.p.length);

  for (const { p, lo, hi } of flatLex) {
    if (!text.includes(p)) continue;
    if (lexiconPatternShadowedByKai(text, p)) continue;
    if (lexiconJiaFollowedByWei(text, p)) continue;
    tightenRange(acc, lo, hi, `lexicon:${p}→${lo}-${hi}`, hits);
    break;
  }

  const kaiRe = /(小|中|大)(五|六|七)([一二三四五六七八九])开/g;
  let kaiM: RegExpExecArray | null;
  while ((kaiM = kaiRe.exec(text)) !== null) {
    const digit = KAI_DIGIT[kaiM[3] ?? ""];
    if (digit === undefined) continue;
    const r = rangeForKaiOpen(kaiM[1] ?? "", kaiM[2] ?? "", digit);
    if (r) {
      tightenRange(acc, r.lo, r.hi, `kai:${kaiM[0]}→${r.lo}-${r.hi}`, hits);
    }
  }

  const roughWanCouple: Array<{ re: RegExp; center: number }> = [
    { re: /(?:^|[^\d])万八(?:块|元|左右)?|一万八/u, center: 18_000 },
    { re: /万五六|一万五六/u, center: 15_500 },
    { re: /(?:大概|大约|也就)?一两万|一二万/u, center: 15_000 },
    { re: /(?:大概|大约|也就)?两三万/u, center: 25_000 },
    { re: /(?:大概|大约|也就)?三五万|三四万/u, center: 38_000 },
    { re: /(?:大概|大约|也就)?五六万|六七万/u, center: 58_000 },
    { re: /(?:大概|大约|也就)?七八万/u, center: 75_000 },
    { re: /(?:大概|大约|也就)?一两千|一二千/u, center: 1500 },
    { re: /(?:大概|大约|也就)?两三千|二三千/u, center: 2500 },
    { re: /(?:大概|大约|也就)?三五千|三四千/u, center: 3800 },
    { re: /(?:大概|大约|也就)?五六千|六七千/u, center: 5800 },
    { re: /(?:大概|大约|也就)?七八千/u, center: 7500 },
    { re: /三五千块钱|三四千块|五六千块/u, center: 4500 },
  ];
  for (const { re, center } of roughWanCouple) {
    if (re.test(text)) {
      applyAround(acc, center, hits);
      break;
    }
  }

  const rangeK = text.match(
    /([\d,]+(?:\.\d+)?)\s*[kK]\s*[-~到至]\s*([\d,]+(?:\.\d+)?)\s*[kK]/u
  );
  if (rangeK) {
    const a = normArab(rangeK[1]);
    const b = normArab(rangeK[2]);
    if (a !== null && b !== null) {
      const lo = a * 1000;
      const hi = b * 1000;
      tightenRange(
        acc,
        lo,
        hi,
        `range_k:${Math.min(lo, hi)}-${Math.max(lo, hi)}`,
        hits
      );
    }
  }

  const rangeM = text.match(
    /([\d,]+(?:\.\d+)?)\s*[-~到至]\s*([\d,]+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/u
  );
  if (rangeM) {
    let a = normArab(rangeM[1]);
    let b = normArab(rangeM[2]);
    const suf = rangeM[3]?.toLowerCase();
    if (a !== null && b !== null) {
      if (!suf) {
        const start = rangeM.index ?? 0;
        const end = start + rangeM[0].length;
        const near = text.slice(Math.max(0, start - 8), Math.min(text.length, end + 8));
        const tinyRange = Math.max(a, b) < 1000;
        const sizeLike = /圈口|内径|直径|mm|毫米|尺寸|珠子|颗|cm/u.test(near);
        if (tinyRange && (!hasPriceContext(near) || sizeLike)) {
          a = null;
          b = null;
        }
      }
    }
    if (a !== null && b !== null) {
      a = scale(a, suf);
      b = scale(b, suf);
      tightenRange(
        acc,
        a,
        b,
        `range:${Math.min(a, b)}-${Math.max(a, b)}`,
        hits
      );
    }
  }

  const upperNum = text.match(
    /(?:不超过|不高于|至多|最多)\s*([\d,]+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/u
  );
  if (upperNum) {
    const n = normArab(upperNum[1]);
    if (n !== null) {
      const cap = scale(n, upperNum[2]?.toLowerCase());
      applyCap(acc, cap, `cap_num:${cap}`, hits);
    }
  }

  /** 金额口吻的「X块/元以内」 */
  const upperArabUnderMoney = text.match(
    /([\d,]+(?:\.\d+)?)\s*(?:块|元)\s*(?:以内|以下|之内)/u
  );
  if (upperArabUnderMoney) {
    const n = normArab(upperArabUnderMoney[1]);
    if (n !== null) applyCap(acc, n, `cap_under_money:${n}`, hits);
  }

  /**
   * 口语「3000以内」；裸数字+以内时略抬高下限，减少「10以内发货」误伤成 10 元封顶。
   */
  const upperArabUnderBare = text.match(
    /([\d,]+(?:\.\d+)?)\s*(?:以内|以下|之内)(?!\s*[天个件条次页])/u
  );
  if (upperArabUnderBare) {
    const n = normArab(upperArabUnderBare[1]);
    if (n !== null && n >= 50) {
      applyCap(acc, n, `cap_under_bare:${n}`, hits);
    }
  }

  /**
   * 口语「3000内 / 5000内的吧」：「的」可插在「内」与语气词之间，
   *  lookahead 不能只认「内」紧接 吧/标点。
   */
  const upperArabNei = text.match(
    /([\d,]+(?:\.\d+)?)\s*内(?:的)?(?=[，,。！？…\s]|不|行|吧|呢|啊|哈|$)/u
  );
  if (upperArabNei) {
    const n = normArab(upperArabNei[1]);
    if (n !== null && n >= 50) {
      applyCap(acc, n, `cap_nei:${n}`, hits);
    }
  }

  if (/(?:价格|价位|预算)?\s*千元以内|千元以下/u.test(text)) {
    applyCap(acc, 1000, `cap_qian_yuan:${1000}`, hits);
  }
  if (/(?:价格|价位|预算)?\s*万元以内|万元以下/u.test(text)) {
    applyCap(acc, 10_000, `cap_wan_yuan:${10_000}`, hits);
  }

  /** 「一千以内」「一百元以内」「十万以内」；排除「三年以内」等（解析不出有效金额或过小） */
  const upperCnWithin = text.match(
    /([一二三四五六七八九十百千万两〇零]+(?:百|千|万)?)\s*(?:元|块钱|块)?\s*(?:以内|以下|之内)(?![年月日号周天])/u
  );
  if (upperCnWithin) {
    const raw = upperCnWithin[1].replace(/(?:元|块钱|块)$/u, "");
    const v = parseChineseMoneyLoose(raw);
    if (v !== null && v >= 50 && v < 50_000_000) {
      applyCap(acc, v, `cap_cn_within:${v}`, hits);
    }
  }

  /** 「一百以内」无「元」时仍可能是价格（如「一百以内品质」） */
  const upperCnBareNumWithin = text.match(
    /([一二三四五六七八九十两]+)\s*(?:以内|以下|之内)(?![年月日号周天])/u
  );
  if (upperCnBareNumWithin) {
    const raw = upperCnBareNumWithin[1];
    const v = parseChineseMoneyLoose(raw);
    if (v !== null && v >= 50 && v <= 999 && hasPriceContext(text)) {
      applyCap(acc, v, `cap_cn_bare_within:${v}`, hits);
    }
  }

  /** 「百元内」「几百元内」 */
  if (/百元内|百元以内|一百元内|一百以内(?![个只条])/u.test(text)) {
    applyCap(acc, 100, `cap_bai_yuan:${100}`, hits);
  } else if (/几百元内|几百块以内|数百元内/u.test(text)) {
    applyCap(acc, 800, `cap_ji_bai:${800}`, hits);
  }

  const upperCnWan = text.match(
    /(?:不超过|不高于|至多|最多)\s*([一二三四五六七八九两十百千万]+)\s*万/u
  );
  if (upperCnWan) {
    const v = parseChineseMoneyLoose(`${upperCnWan[1]}万`);
    if (v !== null) {
      applyCap(acc, v, `cap_cn:${v}`, hits);
    }
  }

  const wanCapPhrase = text.match(
    /([\d,]+(?:\.\d+)?|[一二三四五六七八九两十百千万]+)\s*万\s*(?:以内|以下)/u
  );
  if (wanCapPhrase) {
    const v =
      normArab(wanCapPhrase[1]) !== null
        ? scale(normArab(wanCapPhrase[1])!, "万")
        : parseChineseMoneyLoose(`${wanCapPhrase[1]}万`);
    if (v !== null) {
      applyCap(acc, v, `wan_cap:${v}`, hits);
    }
  }

  const lowerNum = text.match(
    /(?:至少|不低于|不少于)(?:[^\d]*?)([\d,]+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/u
  );
  if (lowerNum) {
    const n = normArab(lowerNum[1]);
    if (n !== null) {
      const fl = scale(n, lowerNum[2]?.toLowerCase());
      applyFloor(acc, fl, `floor:${fl}`, hits);
    }
  }

  /** 「至少一万」「不少于五千」：中文 + 万 */
  const lowerCnWan = text.match(
    /(?:至少|不低于|不少于)\s*([一二三四五六七八九两十百千万]{1,12})\s*万/u
  );
  if (lowerCnWan) {
    const v = parseChineseMoneyLoose(`${lowerCnWan[1]}万`);
    if (v !== null) applyFloor(acc, v, `floor_cn_wan:${v}`, hits);
  }

  /** 「一万以上」「10万以上」「三万起」→ 预算下限 */
  const lowerWanYiShang = text.match(
    /([一二三四五六七八九两十百千万]{1,12}|[\d,]+(?:\.\d+)?)\s*万\s*(?:元|块钱)?\s*(以上|起|往上)/u
  );
  if (lowerWanYiShang) {
    const raw = lowerWanYiShang[1];
    const v =
      normArab(raw) !== null
        ? scale(normArab(raw)!, "万")
        : parseChineseMoneyLoose(`${raw}万`);
    if (v !== null) applyFloor(acc, v, `floor_wan_shang:${v}`, hits);
  }

  const around1Re =
    /([\d,]+(?:\.\d+)?)\s*(万|w|W|千|k|K)?\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u;
  const around1 = around1Re.exec(text);
  if (around1) {
    let c = normArab(around1[1]);
    if (c !== null) {
      const unit = around1[2]?.toLowerCase();
      const start = around1.index;
      const end = start + around1[0].length;
      const prefix = text.slice(Math.max(0, start - 6), start);
      const sizeContext = /卡|圈口|内径|直径|港码|美码|欧码|手寸|mm|毫米/u.test(prefix);
      if (sizeContext) {
        c = null;
      }
      if (c !== null && unit === "k") {
        if (isLikelyGoldPurityK(around1[1], text, start, end)) {
          c = null;
        }
      }
      if (!unit && c !== null && c < 1000) {
        const near = text.slice(Math.max(0, start - 8), Math.min(text.length, end + 8));
        if (!hasPriceContext(near)) {
          c = null;
        }
      }
      if (c === null) {
        // no-op
      } else {
        c = scale(c, unit);
        applyAround(acc, c, hits);
      }
    }
  }

  /** 中文「一万左右吧」；左边界须包含逗号顿号等，否则「翡翠挂件，一万左右」无法匹配 */
  const aroundCn = text.match(
    /(?:^|[，,、；;（(\s]|[^0-9一二三四五六七八九两十百千万，,\s])([一二三四五六七八九两十百千]{1,10}|[\d,]+(?:\.\d+)?)\s*万\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u
  );
  if (aroundCn) {
    const rawLeft = aroundCn[1];
    const v =
      normArab(rawLeft) !== null
        ? scale(normArab(rawLeft)!, "万")
        : parseChineseMoneyLoose(`${rawLeft}万`);
    if (v !== null) {
      applyAround(acc, v, hits);
    }
  }

  /** 「一千左右」「五千上下」等：中文数字 + 千/百 + 左右类 */
  const aroundCnQianBai = text.match(
    /(?:^|[，,、；;（(\s]|[^0-9一二三四五六七八九两十百千，,\s])([一二三四五六七八九十两]+)\s*(千|百)\s*(?:元|块钱|块)?\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u
  );
  if (aroundCnQianBai) {
    const n = parseChineseMoneyLoose(`${aroundCnQianBai[1]}${aroundCnQianBai[2]}`);
    if (n !== null) {
      applyAround(acc, n, hits);
    }
  }

  if (acc.min === null && acc.max === null) {
    const bareWan = text.match(
      /(?:^|[^\d.])([\d,]+(?:\.\d+)?)\s*万(?=\s|，|,|$|[^\d.]|[^万])/u
    );
    if (bareWan) {
      const c = normArab(bareWan[1]);
      if (c !== null) {
        applyAround(acc, Math.round(c * 10_000), hits);
      }
    }
  }

  if (acc.min === null && acc.max === null) {
    const bareAround = text.match(
      /(?:^|[^\d.])([\d]{4,})\s*(左右|上下|大概|差不多)/u
    );
    if (bareAround) {
      const c = normArab(bareAround[1]);
      if (c !== null) {
        applyAround(acc, c, hits);
      }
    }
  }

  if (acc.min === null && acc.max === null) {
    const bareK = /([\d,]+(?:\.\d+)?)\s*[kK](?=\s|，|,|$)/u.exec(text);
    if (bareK) {
      const c = normArab(bareK[1]);
      if (c !== null) {
        const start = bareK.index ?? 0;
        const end = start + bareK[0].length;
        if (!isLikelyGoldPurityK(bareK[1], text, start, end)) {
          applyAround(acc, c * 1000, hits);
        } else {
          hits.push("skip:k_purity_context");
        }
      }
    }
  }

  if (acc.min === null && acc.max === null) {
    return { price_min: null, price_max: null, meta: { hits } };
  }

  if (acc.min !== null && acc.max !== null && acc.min > acc.max) {
    hits.push("conflict:drop_heuristic");
    return { price_min: null, price_max: null, meta: { hits } };
  }

  return {
    price_min: acc.min,
    price_max: acc.max,
    meta: { hits },
  };
}

/**
 * 多段合并时给 meta.hits 打上 `segN:` 前缀，便于日志对齐换行分条。
 */
function withSegPrefixedHits(h: PriceHeuristic, seg1Based: number): PriceHeuristic {
  return {
    price_min: h.price_min,
    price_max: h.price_max,
    meta: {
      hits: h.meta.hits.map((x) => `seg${seg1Based}:${x}`),
    },
  };
}

/**
 * 两段价位合并：先按「同时成立」做交集；退化单点且右段为单边约束时以右段为准（续写修正链）。
 * 用于 {@link mergeSegmentPriceHeuristics} 逐条折叠，优于一次性全局交集。
 */
function mergePairPriceHeuristics(
  left: PriceHeuristic,
  right: PriceHeuristic,
): PriceHeuristic {
  const flatHits = [...left.meta.hits, ...right.meta.hits];

  let min: number | null = null;
  let max: number | null = null;

  if (left.price_min !== null) min = left.price_min;
  if (right.price_min !== null) {
    min = min === null ? right.price_min : Math.max(min, right.price_min);
  }
  if (left.price_max !== null) max = left.price_max;
  if (right.price_max !== null) {
    max = max === null ? right.price_max : Math.min(max, right.price_max);
  }

  const lastOneSided =
    (right.price_min === null && right.price_max !== null) ||
    (right.price_min !== null && right.price_max === null);

  if (
    min !== null &&
    max !== null &&
    min === max &&
    lastOneSided &&
    (right.price_min !== null || right.price_max !== null)
  ) {
    flatHits.push("segment_merge:degenerate_intersection_use_last");
    return {
      price_min: right.price_min,
      price_max: right.price_max,
      meta: { hits: flatHits },
    };
  }

  if (min !== null && max !== null && min > max) {
    flatHits.push("segment_merge:conflict_use_last");
    return {
      price_min: right.price_min,
      price_max: right.price_max,
      meta: { hits: flatHits },
    };
  }

  return { price_min: min, price_max: max, meta: { hits: flatHits } };
}

/**
 * 多轮换行分条场景下，从左到右折叠合并每段价格区间。
 */
function mergeSegmentPriceHeuristics(parts: PriceHeuristic[]): PriceHeuristic {
  if (parts.length === 0) {
    return { price_min: null, price_max: null, meta: { hits: [] } };
  }
  if (parts.length === 1) return parts[0];

  let acc = withSegPrefixedHits(parts[0], 1);
  for (let i = 1; i < parts.length; i++) {
    acc = mergePairPriceHeuristics(acc, withSegPrefixedHits(parts[i], i + 1));
  }
  return acc;
}

/**
 * 对用户输入按 **换行** 切成多段，**每段单独**跑 {@link extractHeuristicPrice} 后再**从左到右折叠**合并：
 * - 每步将「此前累积区间」与「本条」做交集式收紧；
 * - 交集退化为单点且本条为单边（仅上限或仅下限）时，以本条为准（避免「一万以内」+「一万以上」被压成 10k～10k）；
 * - 交集为空（min > max）时以**本条**价位为准，表示用户改口覆盖前文预算。
 */
export function extractHeuristicPriceFromSegments(message: string): PriceHeuristic {
  const segments = splitUserMessageLineSegments(message);
  if (segments.length === 0) {
    return { price_min: null, price_max: null, meta: { hits: [] } };
  }
  if (segments.length === 1) {
    return extractHeuristicPrice(segments[0]);
  }

  const perSeg = segments.map((s) => extractHeuristicPrice(s));
  return mergeSegmentPriceHeuristics(perSeg);
}

/**
 * 写给属性抽取模型：程序已算好的价位，要求 **原样写入 JSON**，避免与句面重复推理打架。
 */
export function formatPriceHeuristicForLlmHint(h: PriceHeuristic): string {
  if (h.price_min === null && h.price_max === null) {
    return (
      `【价位（元）】程序未从用户原话中算出明确数字区间。` +
      `请仅根据下方「用户描述」判断 price_min / price_max；句子里没有预算则两项都填 null，勿臆测。`
    );
  }

  const lo = h.price_min === null ? "null" : String(h.price_min);
  const hi = h.price_max === null ? "null" : String(h.price_max);
  const note =
    h.price_min === null && h.price_max !== null
      ? "（未写下限表示用户未限定最低价）"
      : h.price_min !== null && h.price_max === null
        ? "（未写上限表示用户未限定最高价）"
        : "";

  return [
    `【价位（元）】已按规则算好（含多行续写时的合并），请在输出的 JSON 里直接使用下面两数，勿用句面重算：`,
    `price_min：${lo}；price_max：${hi}`,
    note,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * 转义正则表达式中的特殊字符，用于安全构造动态匹配表达式。
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 与价位行话表不重但必须从 q 去掉的常见片语（可自行追加） */
const EXTRA_Q_PRICE_SLANG = [
  "小价位",
  "大价位",
  "行情价",
  "心理价位",
  "心里价位",
  "喝茶价",
  "行内价",
  "同行价",
  "捡漏价",
  "漏价",
  "对庄价",
  "点头价",
];

let cachedStripPatterns: string[] | null = null;

/**
 * 从检索串 q 中剔除价位行话子串；长词优先，短词只在非汉字边界命中。
 */
export function stripPriceSlangFromSearchQ(q: string): string {
  if (!q.trim()) return "";
  if (!cachedStripPatterns) {
    cachedStripPatterns = [
      ...new Set(LEXICON.flatMap((e) => e.patterns)),
      ...EXTRA_Q_PRICE_SLANG,
    ].sort((a, b) => b.length - a.length);
  }
  let s = q;
  for (const p of cachedStripPatterns) {
    if (!p) continue;
    if (p.length >= 3) {
      s = s.split(p).join(" ");
    } else {
      const re = new RegExp(
        `(?<![\\u4e00-\\u9fff])${escapeRegExp(p)}(?![\\u4e00-\\u9fff])`,
        "gu"
      );
      s = s.replace(re, " ");
    }
  }
  return s
    .replace(/[ ，,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 合并价位后整理 q：去掉黑话价位词，避免进向量检索；若删空则回退为对用户句的剥离结果。
 */
export function finalizeSearchParamsQ(
  sp: SearchParams,
  userMessageTrimmed: string
): SearchParams {
  let q = stripPriceSlangFromSearchQ(sp.q || "");
  if (!q) {
    q = stripPriceSlangFromSearchQ(userMessageTrimmed).slice(0, 240).trim();
  }
  if (!q) {
    q = (sp.q || "").trim() || "用户未提供可检索描述";
  }
  return { ...sp, q };
}

/**
 * 将启发式价格结果合并进搜索参数；只要启发式生效，价格两侧都以启发式为准。
 */
export function mergeHeuristicPriceIntoSearchParams(
  sp: SearchParams,
  heuristic: PriceHeuristic
): SearchParams {
  const { price_min: hm, price_max: hx, meta } = heuristic;

  /** 有命中或任一侧算出值 → 价位两侧完全以启发式为准；null 表示该侧无边界，须覆盖模型误填 */
  const heuristicActive = meta.hits.length > 0 || hm !== null || hx !== null;

  if (!heuristicActive) return sp;

  let price_min = hm;
  let price_max = hx;

  if (price_min !== null && price_max !== null && price_min > price_max) {
    const mid = Math.round((price_min + price_max) / 2);
    price_min = mid;
    price_max = mid;
  }

  return { ...sp, price_min, price_max };
}

/**
 * 句子里是否「像」提到了预算/价位（含口语、行话）。用于清洗：**启发式没抓到数字时**，仍不因-regex 死角误删模型合法填价。
 * 宁可少量误留模型价，也由 merge 与业务侧兜底；纯品类无预算句应多为 false。
 */
export function messageSuggestsUserStatedBudget(message: string): boolean {
  const t = message.trim();
  if (!t) return false;

  for (const e of LEXICON) {
    for (const p of e.patterns) {
      if (p && t.includes(p)) return true;
    }
  }

  if (/[小中大][五六七][一二三四五六七八九]开/u.test(t)) return true;

  if (/\d[\d,]*(?:\.\d+)?\s*(?:万|千)\b/u.test(t)) return true;
  if (/\d[\d,]*(?:\.\d+)?\s*(?:块|元)(?!\s*气)/u.test(t)) return true;
  if (/\d[\d,]*(?:\.\d+)?\s*(?:以内|以下|之内)/u.test(t)) return true;
  if (
    /\d[\d,]*(?:\.\d+)?\s*内(?:的)?(?=[，,。！？…\s]|不|行|吧|呢|啊|哈|$)/u.test(
      t
    )
  ) {
    return true;
  }
  if (/(?:以内|以下|之内)\s*\d/u.test(t)) return true;

  if (
    /预算|价位|多少钱|什么价|心理价|封顶|上限|别超|不超|不超过|不高于|至多|最多|至少|不低于|便宜|太贵|贵点|承受|花\s*多少|带\s*多少|准备\s*多少|就\s*这(?:点|些)|只(?:能|有|好)\s*(?:出|花)|别过|不要超过/u.test(
      t
    )
  ) {
    if (/\d|[一二三四五六七八九十百千万两〇零]{2,}/u.test(t)) return true;
    if (/点五|个点|来万|来千|出头|冒头|来块钱/u.test(t)) return true;
  }

  if (/[一二三四五六七八九十百千万两〇零]{1,12}\s*(?:元|块|万|千)/u.test(t)) {
    return true;
  }
  if (/(?:两三|三五|七八|十来)\s*千|[一二三四五六七八九十]\s*万/u.test(t)) {
    return true;
  }

  return false;
}
