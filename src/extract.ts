import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ATTRIBUTE_EXTRACTION_SYSTEM_PROMPT } from "./extractPrompt";
import {
  parseDeterministicNumericSlots,
  type DeterministicNumericSlots,
} from "./deterministicSlots";
import { createAttributeChatModel, modelName, timeoutMs } from "./llm";
import {
  extractHeuristicPriceFromSegments,
  finalizeSearchParamsQ,
  mergeHeuristicPriceIntoSearchParams,
  type PriceHeuristic,
} from "./priceHeuristic";
import { sanitizeSearchParamsAgainstUserText } from "./sanitizeSearchParams";
import type { SearchParams } from "./searchSchema";
import { SearchParamsSchema } from "./searchSchema";

const MAX_ATTEMPTS = 3;

export type ExtractHistoryMessage = {
  role: "user" | "assistant";
  text: string;
};

function splitIntoUserTurns(message: string): string[] {
  const text = message.trim();
  if (!text) return [];
  const segments = text
    .split(/\r?\n\s*\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments : [text];
}

/** 仅属性提取：主模型（默认 MODEL_NAME）不打下面这批调试 log；对照模型仍输出 */
function verboseExtractLog(opts?: { model?: string }): boolean {
  return (opts?.model ?? modelName()) !== modelName();
}

export type LlmAttemptTiming = {
  attempt: number;
  llm_invoke_ms: number;
  success: boolean;
  error?: string;
};

export type ExtractTimings = {
  extract_wall_ms: number;
  attempts: LlmAttemptTiming[];
  fallback: boolean;
};

function applyDeterministicPriceFallback(
  heuristic: PriceHeuristic,
  slots: DeterministicNumericSlots
): PriceHeuristic {
  const hasDeterministicPrice =
    slots.price.min !== null || slots.price.max !== null;
  if (!hasDeterministicPrice || slots.price.confidence < 0.75) {
    return heuristic;
  }
  const heuristicEmpty =
    heuristic.price_min === null && heuristic.price_max === null;
  const heuristicConflictDropped = heuristic.meta.hits.some((h) =>
    h.includes("drop_heuristic")
  );
  if (!heuristicEmpty && !heuristicConflictDropped) return heuristic;
  return {
    price_min: slots.price.min,
    price_max: slots.price.max,
    meta: {
      hits: [
        ...heuristic.meta.hits,
        `deterministic:${slots.price.evidence_span?.rule ?? "price_fallback"}`,
      ],
    },
  };
}

function extractJsonCandidate(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1).trim();
  return raw.trim();
}

/**
 * 对齐 Dify「属性提取」→「属性赋值」前置结构化结果：第二次 LLM，仅 FIND_ITEM 后调用。
 */
export async function extractSearchParams(
  userMessage: string,
  opts?: {
    model?: string;
    history?: ExtractHistoryMessage[];
    enable_thinking?: boolean;
  }
): Promise<{
  search_params: SearchParams;
  timings: ExtractTimings;
  price_heuristic: PriceHeuristic;
  deterministic_slots: DeterministicNumericSlots;
}> {
  const effectiveThinking = opts?.enable_thinking === true;

  const llm = createAttributeChatModel({
    model: opts?.model ?? modelName(),
    enableThinking: effectiveThinking,
  });
  const structured = llm.withStructuredOutput(SearchParamsSchema, {
    name: "attribute_extraction",
  });

  const wallStart = performance.now();
  const attempts: LlmAttemptTiming[] = [];
  let lastErr: unknown;

  const trimmed = userMessage.trim();
  const deterministic_slots = parseDeterministicNumericSlots(trimmed);
  const price_heuristic = applyDeterministicPriceFallback(
    extractHeuristicPriceFromSegments(trimmed),
    deterministic_slots
  );
  const logExtract = verboseExtractLog(opts);
  if (logExtract) {
    console.log("[intent-demo] 行话平衡价格抽取", price_heuristic);
    console.log("[intent-demo] 确定性槽位解析", deterministic_slots);
  }
  const userTurns = splitIntoUserTurns(trimmed);
  const interleavedTurns = userTurns.flatMap((seg, idx) =>
    idx < userTurns.length - 1
      ? [new HumanMessage(seg), new AIMessage("ai回复了json")]
      : [new HumanMessage(seg)]
  );
  const invokeMessages = [
    new SystemMessage(ATTRIBUTE_EXTRACTION_SYSTEM_PROMPT),
    ...interleavedTurns,
  ];

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const attempt = i + 1;
    const invokeStart = performance.now();
    try {
      if (logExtract) {
        console.log(
          "[intent-demo] 属性提取 → LLM request",
          invokeMessages
            .filter((m) => m._getType() === "human" || m._getType() === "ai")
            .map((m) => (m as HumanMessage).content)
            .slice(0, 6)
        );
      }

      const result = effectiveThinking
        ? await (async () => {
            let streamed = "";
            const stream = await llm.stream(invokeMessages, {
              signal: AbortSignal.timeout(timeoutMs()),
            });
            for await (const chunk of stream) {
              streamed += typeof chunk.content === "string" ? chunk.content : "";
            }
            const candidate = extractJsonCandidate(streamed);
            const parsed = JSON.parse(candidate);
            return SearchParamsSchema.parse(parsed);
          })()
        : await structured.invoke(invokeMessages, {
            signal: AbortSignal.timeout(timeoutMs()),
          });

      if (logExtract) {
        console.log("[intent-demo] llm输出结果", result);
      }

      const llm_invoke_ms = Math.round(performance.now() - invokeStart);
      attempts.push({ attempt, llm_invoke_ms, success: true });

      const extract_wall_ms = Math.round(performance.now() - wallStart);

      const merged = mergeHeuristicPriceIntoSearchParams(
        result,
        price_heuristic
      );
      if (logExtract) {
        console.log("[intent-demo] 行话平衡价格合并", merged);
      }
      const cleaned = sanitizeSearchParamsAgainstUserText(
        merged,
        trimmed,
        price_heuristic
      );
      if (logExtract) {
        console.log("[intent-demo] 行话平衡价格清洗", cleaned);
      }

      const search_params = finalizeSearchParamsQ(cleaned, trimmed);
      if (logExtract) {
        console.log("[intent-demo] 搜索参数清洗最终", search_params);
      }
      return {
        search_params,
        timings: {
          extract_wall_ms,
          attempts,
          fallback: false,
        },
        price_heuristic,
        deterministic_slots,
      };
    } catch (e) {
      const llm_invoke_ms = Math.round(performance.now() - invokeStart);
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[intent-demo] 属性提取 LLM error", {
        attempt,
        model: opts?.model ?? modelName(),
        enable_thinking: effectiveThinking,
        llm_invoke_ms,
        error: msg,
      });
      attempts.push({
        attempt,
        llm_invoke_ms,
        success: false,
        error: msg,
      });
      lastErr = e;
    }
  }

  const extract_wall_ms = Math.round(performance.now() - wallStart);

  const rawFallback: SearchParams = {
    q: trimmed.slice(0, 200) || "用户未提供可检索描述",
    price_min: null,
    price_max: null,
    heat_min: null,
    heat_max: null,
    is_uncertain: true,
    is_free_guarantee: null,
    is_searchable: false,
    has_discount: null,
    category_id: null,
    core_word: null,
    is_early_close: null,
    inner_circle_size_min: null,
    inner_circle_size_max: null,
    negative_filters: null,
  };

  const mergedFb = mergeHeuristicPriceIntoSearchParams(
    rawFallback,
    price_heuristic
  );
  const cleanedFb = sanitizeSearchParamsAgainstUserText(
    mergedFb,
    trimmed,
    price_heuristic
  );

  return {
    search_params: finalizeSearchParamsQ(cleanedFb, trimmed),
    timings: {
      extract_wall_ms,
      attempts,
      fallback: true,
    },
    price_heuristic,
    deterministic_slots,
  };
}
