import {
  expandLexiconPriceTermsForLlmMessage,
  extractHeuristicPriceFromSegments,
  stripPriceSlangFromSearchQ,
} from "./priceHeuristic";

type DifyInput = {
  query?: string;
  arg1?: string;
};

function stripBudgetText(s: string): string {
  return s
    .replace(
      /(?:不超过|不高于|至多|最多|至少|不低于|不少于)?\s*(?:[\d,]+(?:\.\d+)?|[一二三四五六七八九十百千万两〇零]+)\s*(?:万|w|W|千|k|K|元|块)?\s*(?:左右|上下|大概|差不多|以内|以下|之内|内|以上|起|往上)?/gu,
      " "
    )
    .replace(/\s*[-~到至]+\s*/g, " ")
    .replace(/[，,、；;\s]+/g, " ")
    .trim();
}

function toText(v: unknown): string {
  if (Array.isArray(v)) {
    const last = v.length > 0 ? v[v.length - 1] : "";
    return toText(last);
  }
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function lexiconHitToken(hits: string[]): string | null {
  const hit = hits.find((h) => h.startsWith("lexicon:"));
  if (!hit) return null;
  const m = /^lexicon:(.+?)→/u.exec(hit);
  return m?.[1]?.trim() || null;
}

/**
 * Dify 代码节点入口：
 * - 输入：当前用户对话字符串（优先 query，其次 arg1）
 * - 输出：仅返回 query 字符串对象（供下游节点继续使用）
 */
function main(input: DifyInput) {
  const raw = toText(
    (input as Record<string, unknown>).query ??
      (input as Record<string, unknown>).arg1
  ).trim();
  const expanded = expandLexiconPriceTermsForLlmMessage(raw);
  const heuristic = extractHeuristicPriceFromSegments(raw);

  let query = expanded;
  if (heuristic.price_min !== null && heuristic.price_max !== null) {
    const range = `${heuristic.price_min}-${heuristic.price_max}`;
    const token = lexiconHitToken(heuristic.meta.hits);
    if (token && raw.includes(token)) {
      query = `${raw}（${token}->${range}元）`;
    } else {
      const base = stripPriceSlangFromSearchQ(stripBudgetText(expanded));
      query = base ? `${base}，${range}元` : `${range}元`;
    }
  }

  return {
    query,
  };
}

