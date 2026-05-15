import {
  messageSuggestsUserStatedBudget,
  type PriceHeuristic,
} from "./priceHeuristic";
import { sanitizeCategoryAgainstUserText } from "./categoryAttitude";
import type { SearchParams } from "./searchSchema";

/** 围观/出价/热度等：未在句中出现明确热度约束则 heat 须为 null */
const HEAT_HINT_RE =
  /围观|竞拍人|竞拍\s*人数|热度|围观量|围观数|出价数|出价人次|人次上限|人数上限|出价最多|出价人数|拍的人少|零出价|没人出价|\d+\s*(?:人)?\s*出价|出价\s*(?:\d+|少于|低于|不超过|最多|最少)/i;
const INNER_CIRCLE_HINT_RE =
  /圈口|戒圈|内径|港码|手寸|直径|\d{1,3}(?:\.\d+)?\s*(?:mm|毫米)\b/i;
const STANDALONE_CIRCLE_RE = /^\s*(\d{2}(?:\.\d+)?)\s*$/;
const FREE_GUARANTEE_RE =
  /免\s*(?:保证金|保证|押金)|不需要\s*(?:保证金|押金)|无需\s*(?:保证金|押金)|零\s*(?:保证金|押金)|免保/u;
const DISCOUNT_RE = /折扣|优惠|打折|有券|券后/u;
const EARLY_CLOSE_RE =
  /即将\s*(?:结拍|截拍)|快\s*(?:结拍|截拍|结束)|结拍时间最近|截拍|临近结拍|剩余时间.{0,8}(?:内|少于|不到)/u;

function textLooksLikeStandaloneCircle(text: string): boolean {
  const m = STANDALONE_CIRCLE_RE.exec(text);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 45 && n <= 75;
}

function collectNonNullNumbers(
  ...values: Array<number | null | undefined>
): Set<number> {
  const out = new Set<number>();
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) out.add(v);
  }
  return out;
}

function equalsAnyPriceValue(
  candidate: number | null,
  priceValues: Set<number>
): boolean {
  return typeof candidate === "number" && priceValues.has(candidate);
}

function applyDeterministicFlags(out: SearchParams, text: string): void {
  if (FREE_GUARANTEE_RE.test(text)) out.is_free_guarantee = true;
  if (DISCOUNT_RE.test(text)) out.has_discount = true;
  if (EARLY_CLOSE_RE.test(text)) out.is_early_close = true;
}

/**
 * 按用户原文强制对齐硬规则，抹掉模型常犯的默认数（如 heat=20、臆测价、core_word）。
 * 价位：启发式抽到价则与模型合并；未抽到但句面仍像有预算/口语价位时保留模型结果；二者皆无则清空，防「无预算场景」脑补价。
 */
export function sanitizeSearchParamsAgainstUserText(
  sp: SearchParams,
  rawUserMessage: string,
  heuristic: PriceHeuristic,
): SearchParams {
  const text = rawUserMessage.trim();
  const out: SearchParams = { ...sp, core_word: null };

  const heuristicHasPrice =
    heuristic.price_min !== null || heuristic.price_max !== null;
  const sentenceMentionsBudget = messageSuggestsUserStatedBudget(text);

  if (
    !heuristicHasPrice &&
    !sentenceMentionsBudget &&
    (sp.price_min !== null || sp.price_max !== null)
  ) {
    out.price_min = null;
    out.price_max = null;
  }

  if (!HEAT_HINT_RE.test(text)) {
    out.heat_min = null;
    out.heat_max = null;
  }

  const standaloneCircle = textLooksLikeStandaloneCircle(text);
  if (!INNER_CIRCLE_HINT_RE.test(text) && !standaloneCircle) {
    out.inner_circle_size_min = null;
    out.inner_circle_size_max = null;
  }

  const priceValues = collectNonNullNumbers(
    out.price_min,
    out.price_max,
    heuristic.price_min,
    heuristic.price_max
  );
  const hasHeatEvidence = HEAT_HINT_RE.test(text);

  // 二次兜底：价格数字串味到 heat，且句面无热度证据时强制清空。
  if (
    (equalsAnyPriceValue(out.heat_min, priceValues) ||
      equalsAnyPriceValue(out.heat_max, priceValues)) &&
    !hasHeatEvidence
  ) {
    out.heat_min = null;
    out.heat_max = null;
  }

  applyDeterministicFlags(out, text);

  return sanitizeCategoryAgainstUserText(out, text);
}
