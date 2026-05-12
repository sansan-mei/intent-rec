import {
  messageSuggestsUserStatedBudget,
  type PriceHeuristic,
} from "./priceHeuristic";
import type { SearchParams } from "./searchSchema";

/** 围观/出价/热度等：未在句中出现则 heat 须为 null */
const HEAT_HINT_RE =
  /围观|出价|竞拍人|竞拍\s*人数|热度|围观量|围观数|出价数|出价人次|人次上限|人数上限/i;

/** 句中是否出现可解析的圈口/手寸/mm（与品类无关，仅表示用户嘴里说了数字） */
const CIRCLE_SIZE_RE =
  /圈口\s*[:：]?\s*[\d.]+|[\d.]{2,3}\s*圈口|手寸\s*[:：]?\s*[\d.]+|戒圈\s*[:：]?\s*[\d.]+|(?:港码|美码|欧码)\s*[\d.]{1,2}\s*号|[\d.]{1,2}\s*号圈|[\d.]{1,2}\s*号(?!\s*店)|内径\s*[:：]?\s*[\d.]+|直径\s*[:：]?\s*[\d.]+|[\d.]+\s*(?:mm|毫米)(?![²2])/i;

/**
 * 行业上「圈口」主要指手镯/戒指内径；手串/手链多用手围或珠径，不宜占用 inner_circle。
 * 仅当句面同时具备「镯戒类」与「尺寸表述」时才保留模型输出的 inner，否则清空（防手串口语错填、或无句面臆测 20）。
 */
const INNER_CIRCLE_PRODUCT_CONTEXT =
  /手镯|镯子|玉镯|翡翠镯|和田玉镯|戒指|指环|对戒|婚戒|戒圈|手寸|手环|板指|扳指/i;

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

  const explicitCircleSize = CIRCLE_SIZE_RE.test(text);
  const innerCircleProductMentioned = INNER_CIRCLE_PRODUCT_CONTEXT.test(text);
  if (!explicitCircleSize || !innerCircleProductMentioned) {
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
  const hasInnerEvidence = explicitCircleSize && innerCircleProductMentioned;

  // 二次兜底：价格数字串味到 heat，且句面无热度证据时强制清空。
  if (
    (equalsAnyPriceValue(out.heat_min, priceValues) ||
      equalsAnyPriceValue(out.heat_max, priceValues)) &&
    !hasHeatEvidence
  ) {
    out.heat_min = null;
    out.heat_max = null;
  }

  // 二次兜底：价格数字串味到 inner，且句面无尺寸证据时强制清空。
  if (
    (equalsAnyPriceValue(out.inner_circle_size_min, priceValues) ||
      equalsAnyPriceValue(out.inner_circle_size_max, priceValues)) &&
    !hasInnerEvidence
  ) {
    out.inner_circle_size_min = null;
    out.inner_circle_size_max = null;
  }

  return out;
}
