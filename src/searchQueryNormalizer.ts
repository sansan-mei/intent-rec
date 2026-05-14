import type { SearchParams } from "./searchSchema";

type SearchParamsWithCircle = SearchParams & {
  inner_circle_size_min?: number | null;
  inner_circle_size_max?: number | null;
};

type CircleRange = {
  min: number | null;
  max: number | null;
};

const RAW_TRIM_RE = /^[\s，,。.!！?？、；;：:"'“”‘’（）()【】\[\]{}]+|[\s，,。.!！?？、；;：:"'“”‘’（）()【】\[\]{}]+$/gu;
const RING_ITEM_RE = /手镯|贵妃镯|圆条|正圈|镯|戒指|戒圈|指环|扳指/u;
const INNER_CIRCLE_LABEL_RE = /圈口|戒圈|内径|港码|手寸|直径/u;

const EXACT_Q_NORMALIZATIONS: Record<string, string> = {
  挂件: "玉石挂件",
  吊坠: "玉石吊坠",
  手镯: "玉石手镯",
  手串: "玉石手串",
  珠链: "玉石珠链",
  戒指: "玉石戒指",
  戒圈: "玉石戒圈",
  耳饰: "珠宝耳饰",
  耳环: "珠宝耳环",
  手链: "玉石手链",
  佛公: "玉石佛公挂件",
  观音: "玉石观音挂件",
  貔貅: "玉石貔貅挂件",
  葫芦: "玉石葫芦挂件",
  福豆: "玉石福豆挂件",
  无事牌: "玉石无事牌挂件",
  平安扣: "玉石平安扣挂件",
  如意: "玉石如意挂件",
  叶子: "玉石叶子挂件",
  龙牌: "玉石龙牌挂件",
  黑色: "黑色玉石饰品",
  白色: "白色玉石饰品",
  粉色: "粉色玉石饰品",
  紫色: "紫色玉石饰品",
  绿色: "绿色玉石饰品",
  苹果绿: "苹果绿玉石饰品",
  果绿: "果绿玉石饰品",
  晴水: "晴水玉石饰品",
  青花: "青花和田玉饰品",
  藕粉: "藕粉色和田玉饰品",
  糖料: "糖料和田玉饰品",
  乌鸡: "乌鸡翡翠饰品",
  危料: "危料翡翠饰品",
  绿松: "绿松石饰品",
  海水: "海水珍珠饰品",
  "18k": "18k金首饰",
  "18K": "18k金首饰",
  "18k金": "18k金首饰",
  K金: "K金首饰",
};

function cleanSurface(text: string): string {
  return text.replace(RAW_TRIM_RE, "").replace(/\s+/g, "").trim();
}

function looksLikeStandaloneCircle(text: string): number | null {
  const m = /^(\d{2}(?:\.\d+)?)$/u.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n >= 45 && n <= 75 ? n : null;
}

function normalizeShortSearchQ(q: string, userMessage: string): string {
  const original = q.trim();
  const raw = cleanSurface(userMessage);
  const compactQ = cleanSurface(original);
  const exactFromQ = EXACT_Q_NORMALIZATIONS[compactQ];
  if (exactFromQ) return exactFromQ;

  const shouldTrustRawShortWord =
    compactQ.length === 0 || compactQ === raw || [...compactQ].length <= 4;
  const exact = shouldTrustRawShortWord ? EXACT_Q_NORMALIZATIONS[raw] : undefined;
  if (exact) return exact;

  const rawCircle = looksLikeStandaloneCircle(raw);
  const qCircle = looksLikeStandaloneCircle(compactQ);
  const shouldTreatRawAsCircle =
    compactQ.length === 0 || compactQ === raw || !RING_ITEM_RE.test(compactQ);
  const circle = (shouldTreatRawAsCircle ? rawCircle : null) ?? qCircle;
  if (circle !== null) return `${circle}圈口玉石手镯`;

  if (/^(?:\d{1,2}|[一二三四五六七八九十])\s*[kK](?:金)?$/u.test(raw)) {
    return `${raw.toLowerCase()}金首饰`;
  }

  return original;
}

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function validCircle(n: number | null): n is number {
  return n !== null && n >= 1 && n < 200;
}

function rangeFromMatch(a: number | null, b: number | null): CircleRange | null {
  if (!validCircle(a) || !validCircle(b)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function pointFromMatch(n: number | null): CircleRange | null {
  if (!validCircle(n)) return null;
  return { min: n, max: null };
}

export function extractInnerCircleRange(text: string): CircleRange {
  const s = text.trim();
  if (!s) return { min: null, max: null };

  const rangeAfterLabel =
    /(?:圈口|戒圈|内径|港码|手寸|直径)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:-|—|~|到|至)\s*(\d{1,3}(?:\.\d+)?)/iu.exec(s);
  const range1 = rangeFromMatch(
    toNumber(rangeAfterLabel?.[1]),
    toNumber(rangeAfterLabel?.[2])
  );
  if (range1) return range1;

  const rangeBeforeLabel =
    /(\d{1,3}(?:\.\d+)?)\s*(?:-|—|~|到|至)\s*(\d{1,3}(?:\.\d+)?)\s*(?:圈口|戒圈|内径|港码|手寸|直径)/iu.exec(s);
  const range2 = rangeFromMatch(
    toNumber(rangeBeforeLabel?.[1]),
    toNumber(rangeBeforeLabel?.[2])
  );
  if (range2) return range2;

  const pointAfterLabel =
    /(?:圈口|戒圈|内径|港码|手寸|直径)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)/iu.exec(s);
  const point1 = pointFromMatch(toNumber(pointAfterLabel?.[1]));
  if (point1) return point1;

  const pointBeforeLabel =
    /(\d{1,3}(?:\.\d+)?)\s*(?:圈口|戒圈)/iu.exec(s);
  const point2 = pointFromMatch(toNumber(pointBeforeLabel?.[1]));
  if (point2) return point2;

  const mmPoint = /(\d{1,3}(?:\.\d+)?)\s*(?:mm|毫米)\b/iu.exec(s);
  const point3 = pointFromMatch(toNumber(mmPoint?.[1]));
  if (point3) return point3;

  const standalone = looksLikeStandaloneCircle(cleanSurface(s));
  const point4 = pointFromMatch(standalone);
  return point4 ?? { min: null, max: null };
}

function equalsAnyPriceValue(
  candidate: number | null,
  priceValues: Set<number>
): boolean {
  return candidate !== null && priceValues.has(candidate);
}

function collectPriceValues(sp: SearchParamsWithCircle): Set<number> {
  const out = new Set<number>();
  for (const v of [sp.price_min, sp.price_max]) {
    if (typeof v === "number" && Number.isFinite(v)) out.add(v);
  }
  return out;
}

export function normalizeSearchParamsForSearch(
  sp: SearchParamsWithCircle,
  userMessage: string
): SearchParamsWithCircle {
  const q = normalizeShortSearchQ(sp.q || "", userMessage);
  const out: SearchParamsWithCircle = { ...sp, q };
  const evidence = `${userMessage}\n${q}`.trim();
  const hasRingContext =
    RING_ITEM_RE.test(evidence) ||
    INNER_CIRCLE_LABEL_RE.test(evidence) ||
    looksLikeStandaloneCircle(cleanSurface(userMessage)) !== null;
  if (!hasRingContext) return out;

  const priceValues = collectPriceValues(out);
  const range = extractInnerCircleRange(evidence);
  if (
    equalsAnyPriceValue(range.min, priceValues) ||
    equalsAnyPriceValue(range.max, priceValues)
  ) {
    out.inner_circle_size_min = null;
    out.inner_circle_size_max = null;
    return out;
  }

  if (range.min !== null || range.max !== null) {
    out.inner_circle_size_min = range.min;
    out.inner_circle_size_max = range.max;
  }

  return out;
}
