import {
  extractHeuristicPriceFromSegments,
  messageSuggestsUserStatedBudget,
  mergeHeuristicPriceIntoSearchParams,
  type PriceHeuristic,
} from "./priceHeuristic";
import { sanitizeSearchParamsAgainstUserText } from "./sanitizeSearchParams";
import { parseDeterministicNumericSlots } from "./deterministicSlots";
import { normalizeSearchParamsForSearch } from "./searchQueryNormalizer";
import type { SearchParams } from "./searchSchema";

type DifyInput = {
  query?: unknown;
  after_list?: unknown;
  query_list?: unknown;
  new_attributes_other?: unknown;
};

type DifySearchParams = SearchParams & {
  inner_circle_size_min?: number | null;
  inner_circle_size_max?: number | null;
  [key: string]: unknown;
};

const TURN_RESET_RE =
  /重新|重来|换成|改成|改到|换个|重找|重新找|不看了|算了|别看|不要这个/u;
const HEAT_HINT_RE =
  /围观|竞拍人|竞拍\s*人数|热度|围观量|围观数|出价数|出价人次|人次上限|人数上限|出价最多|出价人数|拍的人少|零出价|没人出价|\d+\s*(?:人)?\s*出价|出价\s*(?:\d+|少于|低于|不超过|最多|最少)/u;

/**
 * 将 Dify 代码节点传入的任意值稳定转成字符串。
 * 约定：数组取最后一项，null/undefined 转空串，其它基础类型直接 String 化。
 */
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

/**
 * 将任意输入归一化为 number|null。
 * 主要用于清洗 LLM 输出里可能混入的字符串数字、逗号分隔数字和空串。
 */
function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 将任意输入归一化为 boolean|null。
 * 兼容 Dify 节点里常见的 true/false、1/0、on/off、yes/no 字符串。
 */
function toNullableBoolean(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 0 ? false : v === 1 ? true : null;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (!t) return null;
    if (["true", "1", "yes", "y", "on"].includes(t)) return true;
    if (["false", "0", "no", "n", "off"].includes(t)) return false;
  }
  return null;
}

/**
 * 将任意输入归一化为非空字符串或 null。
 */
function toNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = toText(v).trim();
  return t ? t : null;
}

/**
 * 将任意输入归一化为字符串数组。
 * 兼容原生数组、JSON 字符串数组、单个字符串三种输入形式。
 */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((item) => toText(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return toStringArray(parsed);
    } catch {}
    return [t];
  }
  return [];
}

/**
 * 将任意输入归一化为字符串数组或 null。
 * 用于 negative_filters 等字段。
 */
function toNullableStringArray(v: unknown): string[] | null {
  const out = toStringArray(v);
  return out.length > 0 ? out : null;
}

/**
 * 从一段可能带 fenced code 的文本中提取 JSON 主体。
 */
function extractJsonCandidate(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1).trim();
  return raw.trim();
}

/**
 * 将 Dify 输入解析成普通对象。
 * 兼容直接传对象、传数组包裹对象、以及传 JSON 字符串三种情况。
 */
function toObjectRecord(v: unknown): Record<string, unknown> {
  if (Array.isArray(v)) {
    const last = v.length > 0 ? v[v.length - 1] : null;
    return toObjectRecord(last);
  }
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(extractJsonCandidate(t));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 取数组中最后一个非空字符串。
 */
function lastNonEmpty(items: string[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i].trim();
    if (t) return t;
  }
  return "";
}

/**
 * 取数组中倒数第二个非空字符串。
 */
function previousNonEmpty(items: string[]): string {
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i].trim();
    if (!t) continue;
    seen += 1;
    if (seen === 2) return t;
  }
  return "";
}

/**
 * 将上游属性抽取结果归一化为统一的 SearchParams 形状。
 * 这里只做类型清洗，不做业务纠错；业务纠错留给后置规则阶段。
 */
function normalizeSearchParams(
  rawInput: Record<string, unknown>,
  fallbackQuery: string
): DifySearchParams {
  return {
    ...rawInput,
    q: toNullableString(rawInput.q) ?? fallbackQuery,
    price_min: toNullableNumber(rawInput.price_min),
    price_max: toNullableNumber(rawInput.price_max),
    heat_min: toNullableNumber(rawInput.heat_min),
    heat_max: toNullableNumber(rawInput.heat_max),
    is_uncertain: toNullableBoolean(rawInput.is_uncertain),
    is_free_guarantee: toNullableBoolean(rawInput.is_free_guarantee),
    is_searchable: toNullableBoolean(rawInput.is_searchable),
    has_discount: toNullableBoolean(rawInput.has_discount),
    category_id: toNullableNumber(rawInput.category_id),
    core_word: toNullableString(rawInput.core_word),
    is_early_close: toNullableBoolean(rawInput.is_early_close),
    negative_filters: toNullableStringArray(rawInput.negative_filters),
    inner_circle_size_min: toNullableNumber(rawInput.inner_circle_size_min),
    inner_circle_size_max: toNullableNumber(rawInput.inner_circle_size_max),
  };
}

/**
 * 判断当前轮是否像“重新发起找货/改口覆盖”而不是“补充上一轮条件”。
 */
function isResetTurn(currentQuery: string): boolean {
  const text = currentQuery.trim();
  return !!text && TURN_RESET_RE.test(text);
}

/**
 * 判断这轮是否可能在继承上一轮条件。
 * 当当前轮没明确说预算/热度，但结构化结果里已经有这些字段，且没有改口词时，
 * 允许把上一轮原话拼进证据文本，避免误清空历史约束。
 */
function shouldUseHistoryEvidence(
  currentQuery: string,
  sp: DifySearchParams,
  queryList: string[]
): boolean {
  if (!currentQuery.trim() || queryList.length < 2) return false;
  if (isResetTurn(currentQuery)) return false;

  const hasInheritedPrice =
    !messageSuggestsUserStatedBudget(currentQuery) &&
    (sp.price_min !== null || sp.price_max !== null);
  const hasInheritedHeat =
    !HEAT_HINT_RE.test(currentQuery) &&
    (sp.heat_min !== null || sp.heat_max !== null);

  return hasInheritedPrice || hasInheritedHeat;
}

/**
 * 构造后置规则的句面证据文本。
 * 默认只看当前轮；若判断为“补充条件”，则把上一轮原话拼进来，用于保留历史约束。
 */
function buildEvidenceText(
  currentQuery: string,
  queryList: string[],
  sp: DifySearchParams
): string {
  const current = currentQuery.trim();
  if (!shouldUseHistoryEvidence(current, sp, queryList)) return current;
  const prev = previousNonEmpty(queryList);
  return prev ? `${prev}\n${current}` : current;
}

/**
 * 构造价位启发式的文本来源。
 * 优先复用前置节点已产出的 `after_list`；当前轮像补充条件时，拼上一轮 after 文本一起算。
 * 由于 `after_list` 只是文本而不是结构化 heuristic，仍需在这里再解析一次。
 */
function buildHeuristicSourceText(
  currentQuery: string,
  afterList: string[],
  sp: DifySearchParams
): string {
  const currentAfter = lastNonEmpty(afterList);
  const currentSource = currentAfter || currentQuery.trim();
  if (!shouldUseHistoryEvidence(currentQuery, sp, afterList)) return currentSource;
  const prevAfter = previousNonEmpty(afterList);
  return prevAfter ? `${prevAfter}\n${currentSource}` : currentSource;
}

/**
 * 在启发式价格为空或已被冲突规则丢弃时，用确定性价格槽位回填价格。
 * 目的是把“明确数字预算但启发式漏掉”的场景补回来。
 */
function applyDeterministicPriceFallback(
  heuristic: PriceHeuristic,
  sourceText: string
): PriceHeuristic {
  const deterministic_slots = parseDeterministicNumericSlots(sourceText);
  const hasDeterministicPrice =
    deterministic_slots.price.min !== null ||
    deterministic_slots.price.max !== null;
  if (!hasDeterministicPrice || deterministic_slots.price.confidence < 0.75) {
    return heuristic;
  }

  const heuristicEmpty =
    heuristic.price_min === null && heuristic.price_max === null;
  const heuristicConflictDropped = heuristic.meta.hits.some((hit) =>
    hit.includes("drop_heuristic")
  );
  if (!heuristicEmpty && !heuristicConflictDropped) {
    return heuristic;
  }

  return {
    price_min: deterministic_slots.price.min,
    price_max: deterministic_slots.price.max,
    meta: {
      hits: [
        ...heuristic.meta.hits,
        `deterministic:${
          deterministic_slots.price.evidence_span?.rule ?? "price_fallback"
        }`,
      ],
    },
  };
}

/**
 * Dify 代码节点入口。
 *
 * 这层后置规则引擎主要负责：
 * 1. 归一化 LLM 抽取结果中的字段类型
 * 2. 优先复用 `after_list` 构造价格启发式来源，再纠正 `price_*`
 * 3. 用 `query` 做当前轮证据，用 `query_list` 决定是否允许继承上一轮约束
 * 4. 无句面证据时清空误填的 `price_*`、`heat_*`
 * 5. 对极短搜索词做确定性 `q` 扩写，并提取 `inner_circle_size_min/max`
 * 6. 强制 `core_word=null`
 *
 * 输入建议传入：
 * - `query`：当前轮用户原话
 * - `after_list`：前置启发式后的多轮数组
 * - `query_list`：原始多轮数组
 * - `new_attributes_other`：属性提取节点输出的对象或 JSON 字符串
 *
 * 输出仅保留 `merged_attributes`，用于直接替换原 Dify「属性赋值」节点。
 */
function main(input: DifyInput) {
  const query = toText(input.query).trim();
  const afterList = toStringArray(input.after_list);
  const queryList = toStringArray(input.query_list);
  const rawSearchParams = toObjectRecord(input.new_attributes_other);
  const fallbackQuery =
    query ||
    toNullableString(rawSearchParams.q) ||
    lastNonEmpty(queryList) ||
    lastNonEmpty(afterList);

  const normalized = normalizeSearchParams(
    rawSearchParams,
    fallbackQuery
  );

  const evidenceText = buildEvidenceText(fallbackQuery, queryList, normalized);
  const heuristicSource = buildHeuristicSourceText(
    fallbackQuery,
    afterList,
    normalized
  );

  const heuristic = applyDeterministicPriceFallback(
    extractHeuristicPriceFromSegments(heuristicSource),
    heuristicSource
  );

  const merged = mergeHeuristicPriceIntoSearchParams(normalized, heuristic);
  const sanitizedCore = sanitizeSearchParamsAgainstUserText(
    merged,
    evidenceText,
    heuristic
  );
  const finalized = normalizeSearchParamsForSearch(
    { ...normalized, ...sanitizedCore, core_word: null },
    evidenceText
  );

  return {
    merged_attributes: finalized,
  };
}
