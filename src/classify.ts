import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel, modelName, timeoutMs } from "./llm";
import { INTENT_SYSTEM_PROMPT } from "./prompt";
import type { Intent } from "./schema";
import { IntentSchema } from "./schema";

const MAX_ATTEMPTS = 3;

export type LlmAttemptTiming = {
  attempt: number;
  llm_invoke_ms: number;
  success: boolean;
  error?: string;
};

export type ClassifyTimings = {
  classify_wall_ms: number;
  attempts: LlmAttemptTiming[];
  fallback: boolean;
};

export async function classifyIntent(
  userMessage: string,
  opts?: { model?: string; enable_thinking?: boolean }
): Promise<{
  intent: Intent;
  timings: ClassifyTimings;
}> {
  const llm = createChatModel({
    temperature: 0.2,
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.enable_thinking === true ? { enableThinking: true } : {}),
  });
  const structured = llm.withStructuredOutput(IntentSchema, {
    name: "intent_classification",
  });

  const classifyWallStart = performance.now();
  const attempts: LlmAttemptTiming[] = [];
  let lastErr: unknown;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const attempt = i + 1;
    const invokeStart = performance.now();
    try {
      console.log("[intent-demo] 意图识别路由 → LLM request", {
        attempt,
        model: opts?.model ?? modelName(),
        enable_thinking: opts?.enable_thinking === true,
        system_prompt: "INTENT_SYSTEM_PROMPT",
        user_message: userMessage.trim(),
      });

      const result = await structured.invoke(
        [
          new SystemMessage(INTENT_SYSTEM_PROMPT),
          new HumanMessage(userMessage.trim()),
        ],
        { signal: AbortSignal.timeout(timeoutMs()) }
      );

      const llm_invoke_ms = Math.round(performance.now() - invokeStart);
      attempts.push({ attempt, llm_invoke_ms, success: true });

      const classify_wall_ms = Math.round(
        performance.now() - classifyWallStart
      );

      return {
        intent: result.intent,
        timings: {
          classify_wall_ms,
          attempts,
          fallback: false,
        },
      };
    } catch (e) {
      const llm_invoke_ms = Math.round(performance.now() - invokeStart);
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({
        attempt,
        llm_invoke_ms,
        success: false,
        error: msg,
      });
      lastErr = e;
    }
  }

  const classify_wall_ms = Math.round(performance.now() - classifyWallStart);

  return {
    intent: "CHAT",
    timings: {
      classify_wall_ms,
      attempts,
      fallback: true,
    },
  };
}
