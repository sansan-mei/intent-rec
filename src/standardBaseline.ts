import { extractSearchParams } from "./extract";
import type { ExtractHistoryMessage } from "./extract";
import { standardModelName } from "./llm";
import type { PriceHeuristic } from "./priceHeuristic";
import type { SearchParams } from "./searchSchema";
import type { ExtractTimings } from "./extract";
import type { ClassifyTimings } from "./classify";

export type StandardLlmBaseline = {
  model: string;
  intent: "FIND_ITEM";
  search_params: SearchParams;
  price_heuristic: PriceHeuristic;
  intent_recognition_ms: 0;
  intent_llm_invoke_ms: null;
  attribute_extraction_ms: number | null;
  attribute_llm_invoke_ms: number | null;
  extract_await_ms: number | null;
  /** 意图识别已关闭，恒为 null */
  classify: ClassifyTimings | null;
  extract: ExtractTimings;
  baseline_wall_ms: number;
};

/**
 * 对照：仅用标准档模型做属性抽取（与主链路相同输入），意图固定 FIND_ITEM。
 */
export async function runStandardLlmBaseline(
  message: string,
  history?: ExtractHistoryMessage[],
  enable_thinking?: boolean
): Promise<StandardLlmBaseline> {
  const model = standardModelName();
  const wallStart = performance.now();

  const exStart = performance.now();
  const ex = await extractSearchParams(message, {
    model,
    history,
    enable_thinking,
  });
  const extract_await_ms = Math.round(performance.now() - exStart);

  const baseline_wall_ms = Math.round(performance.now() - wallStart);

  const attributeLlmInvokeMs =
    ex.timings.attempts.find((a) => a.success)?.llm_invoke_ms ?? null;

  return {
    model,
    intent: "FIND_ITEM",
    search_params: ex.search_params,
    price_heuristic: ex.price_heuristic,
    intent_recognition_ms: 0,
    intent_llm_invoke_ms: null,
    attribute_extraction_ms: ex.timings.extract_wall_ms,
    attribute_llm_invoke_ms: attributeLlmInvokeMs,
    extract_await_ms,
    classify: null,
    extract: ex.timings,
    baseline_wall_ms,
  };
}
