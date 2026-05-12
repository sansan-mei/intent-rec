import {
  expandLexiconPriceTermsForLlmMessage,
  extractHeuristicPriceFromSegments,
} from "./priceHeuristic";

type DifyInput = {
  arg1: string;
};

function toText(v: unknown): string {
  if (Array.isArray(v)) {
    const last = v.length > 0 ? v[v.length - 1] : "";
    return toText(last);
  }
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
  ) {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSegPrefix(hit: string): string {
  return hit.replace(/^seg\d+:/u, "");
}

function lastLexiconPatternFromHits(hits: string[]): string | null {
  const cleaned = hits.map(stripSegPrefix);
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const m = /^lexicon:(.+?)→/u.exec(cleaned[i]);
    if (m) return m[1].trim();
  }
  return null;
}

function lastKaiSpanFromHits(hits: string[]): string | null {
  const cleaned = hits.map(stripSegPrefix);
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const m = /^kai:(.+?)→/u.exec(cleaned[i]);
    if (m) return m[1].trim();
  }
  return null;
}

function lastAroundCenterFromHits(hits: string[]): number | null {
  const cleaned = hits.map(stripSegPrefix);
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const m = /^around:(\d+)/u.exec(cleaned[i]);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** 行话词后若紧跟「左右」类，一并作为锚点（如 中千左右）。 */
function extendLexiconWithAround(raw: string, pattern: string): string {
  const i = raw.indexOf(pattern);
  if (i < 0) return pattern;
  const tail = raw.slice(i + pattern.length);
  const m = tail.match(/^\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u);
  if (m) return `${pattern}${m[1]}`;
  return pattern;
}

/**
 * 从用户原句抽与句面一致的预算口语，用于 `（5000左右->4000-6000）` 左侧。
 */
function colloquialBudgetAnchorFromRaw(
  raw: string,
  hits: string[]
): string | null {
  const s = raw.trim();
  if (!s) return null;

  const arAround =
    /([\d,]+(?:\.\d+)?)\s*(万|w|W|千|k|K)?\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u.exec(
      s
    );
  if (arAround) {
    const num = arAround[1].replace(/,/g, "");
    const u = arAround[2] ?? "";
    const mod = arAround[3] ?? "";
    return `${num}${u}${mod}`;
  }

  const cnQianBaiAround =
    /([一二三四五六七八九十两]+)\s*(千|百)\s*(?:元|块钱|块)?\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u.exec(
      s
    );
  if (cnQianBaiAround) {
    return `${cnQianBaiAround[1]}${cnQianBaiAround[2]}${cnQianBaiAround[3]}`;
  }

  const cnWanAround =
    /([\d,]+(?:\.\d+)?|[一二三四五六七八九两十百千]{1,12})\s*万\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u.exec(
      s
    );
  if (cnWanAround) {
    const left = cnWanAround[1].replace(/,/g, "");
    return `${left}万${cnWanAround[2]}`;
  }

  const bare4Around =
    /([\d]{4,})\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?/u.exec(s);
  if (bare4Around) {
    return `${bare4Around[1]}${bare4Around[2]}`;
  }

  const lex = lastLexiconPatternFromHits(hits);
  if (lex && s.includes(lex)) {
    return extendLexiconWithAround(s, lex);
  }

  const kai = lastKaiSpanFromHits(hits);
  if (kai && s.includes(kai)) {
    return kai;
  }

  const center = lastAroundCenterFromHits(hits);
  if (center !== null) {
    const compact = String(center);
    const withAround = new RegExp(
      `${escapeRegExp(
        compact
      )}\\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?`,
      "u"
    ).exec(s);
    if (withAround) {
      return `${compact}${withAround[1]}`;
    }
  }

  return null;
}

/**
 * Dify 代码节点入口：
 * - 输入：当前用户对话字符串（优先 query，其次 arg1）
 * - 输出：仅返回 query 字符串对象（供下游节点继续使用）
 */
function main(input: DifyInput) {
  const raw = toText(input.arg1).trim();
  const expanded = expandLexiconPriceTermsForLlmMessage(raw);
  const heuristic = extractHeuristicPriceFromSegments(raw);

  let query = expanded;
  if (heuristic.price_min !== null && heuristic.price_max !== null) {
    const range = `${heuristic.price_min}-${heuristic.price_max}`;
    const anchor =
      colloquialBudgetAnchorFromRaw(raw, heuristic.meta.hits) ?? "价位";
    const surface = expanded.trim() || raw.trim();
    query = `${surface}（${anchor}->${range}）`;
  }

  return {
    query,
  };
}
