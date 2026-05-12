import { Hono } from "hono";
import path from "node:path";
import { z } from "zod";
import { classifyIntent } from "./classify";
import { extractSearchParams } from "./extract";
import type { ExtractHistoryMessage } from "./extract";
import { modelName, standardModelName } from "./llm";
import {
  matchSearchDictionaryFuzzy,
  searchDictionaryEnabled,
  tryVerbFindRemainder,
} from "./searchDictionary";
import {
  runStandardLlmBaseline,
  type StandardLlmBaseline,
} from "./standardBaseline";

/** 默认开启，与 AI助手.yml 四类意图一致；设为 0/false/off 则走固定找货（仅属性抽取）。 */
function intentClassificationEnabled(): boolean {
  const v = process.env.INTENT_CLASSIFICATION_ENABLED?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

const RequestSchema = z.object({
  message: z.string().min(1, "message is required"),
  compare_standard: z.boolean().optional(),
  /** DashScope 千问：兼容 API 体 `enable_thinking`，开启深度思考（think） */
  enable_thinking: z.boolean().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
      })
    )
    .optional(),
});

const app = new Hono();

async function maybeAttachStandardLlm(
  enabled: boolean | undefined,
  baselinePromise: Promise<StandardLlmBaseline> | null,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!enabled || !baselinePromise) return payload;
  try {
    const standard_llm = await baselinePromise;
    return { ...payload, standard_llm };
  } catch (e) {
    return {
      ...payload,
      standard_llm: {
        error: e instanceof Error ? e.message : String(e),
        model: standardModelName(),
      },
    };
  }
}

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
  const file = Bun.file(
    path.join(import.meta.dir, "..", "public", "index.html")
  );
  if (!(await file.exists())) {
    return c.text("missing public/index.html", 404);
  }
  return new Response(await file.text(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

app.post("/intent", async (c) => {
  const handlerStart = performance.now();

  const jsonStart = performance.now();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const json_parse_ms = Math.round(performance.now() - jsonStart);

  const validationStart = performance.now();
  const parsed = RequestSchema.safeParse(body);
  const validation_ms = Math.round(performance.now() - validationStart);

  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        detail: parsed.error.flatten(),
        timings: {
          json_parse_ms,
          validation_ms,
          handler_total_ms: Math.round(performance.now() - handlerStart),
        },
      },
      400
    );
  }

  const { message, compare_standard, history, enable_thinking } = parsed.data;
  const normalizedHistory: ExtractHistoryMessage[] = (history ?? [])
    .map((h) => ({
      role: h.role,
      text: h.text.trim(),
    }))
    .filter((h) => h.text.length > 0);

  // 仅属性提取链路开启 think；意图识别与标准对照保持关闭，避免响应变慢或卡住。
  const thinkOn = enable_thinking === true;
  const extractRequestOpts = {
    history: normalizedHistory,
    ...(thinkOn ? { enable_thinking: true as const } : {}),
  };

  let standardBaselinePromise: Promise<StandardLlmBaseline> | null = null;

  try {
    let dictionary_lookup_ms: number | null = null;

    const verbRemainder = searchDictionaryEnabled()
      ? tryVerbFindRemainder(message)
      : null;

    let dictHit = null as ReturnType<typeof matchSearchDictionaryFuzzy>;

    if (searchDictionaryEnabled()) {
      const dictLookupStart = performance.now();
      const lookupSource =
        verbRemainder !== null ? verbRemainder : message.trim();
      dictHit = matchSearchDictionaryFuzzy(lookupSource);
      dictionary_lookup_ms = Math.round(performance.now() - dictLookupStart);
    }

    if (dictHit) {
      const intent_skip_reason =
        verbRemainder !== null ? "verb_find_prefix" : "hot_keyword_match";

      standardBaselinePromise = compare_standard
        ? runStandardLlmBaseline(message, normalizedHistory, thinkOn)
        : null;

      const beforeExtract = performance.now();
      const ex = await extractSearchParams(message, extractRequestOpts);
      const extract_await_ms = Math.round(performance.now() - beforeExtract);

      const handler_total_ms = Math.round(performance.now() - handlerStart);

      const attributeLlmInvokeMs =
        ex.timings.attempts.find((a) => a.success)?.llm_invoke_ms ?? null;

      console.log(
        `[intent-demo] 词典热词匹配 → 属性提取 tag_id=${dictHit.tag_id} pattern=${dictHit.matched_pattern} extract_wall_ms=${ex.timings.extract_wall_ms} skip=${intent_skip_reason}`
      );

      return c.json(
        await maybeAttachStandardLlm(
          compare_standard,
          standardBaselinePromise,
          {
            intent: "FIND_ITEM",
            routing: "dictionary_es_with_extract",
            intent_skip_reason,
            verb_remainder: verbRemainder,
            dictionary: {
              tag_id: dictHit.tag_id,
              matched_pattern: dictHit.matched_pattern,
              es_text_query: dictHit.es_text_query,
            },
            intent_recognition_ms: 0,
            intent_llm_invoke_ms: null,
            primary_model: modelName(),
            enable_thinking: thinkOn,
            search_params: ex.search_params,
            price_heuristic: ex.price_heuristic,
            deterministic_slots: ex.deterministic_slots,
            attribute_extraction_ms: ex.timings.extract_wall_ms,
            attribute_llm_invoke_ms: attributeLlmInvokeMs,
            timings: {
              json_parse_ms,
              validation_ms,
              dictionary_lookup_ms,
              classify_skipped: true,
              extract_skipped: false,
              classify_await_ms: 0,
              classify: null,
              extract_await_ms,
              extract: ex.timings,
              handler_total_ms,
            },
          }
        )
      );
    }

    if (verbRemainder !== null) {
      standardBaselinePromise = compare_standard
        ? runStandardLlmBaseline(message, normalizedHistory, thinkOn)
        : null;

      const beforeExtract = performance.now();
      const ex = await extractSearchParams(message, extractRequestOpts);
      const extract_await_ms = Math.round(performance.now() - beforeExtract);

      const handler_total_ms = Math.round(performance.now() - handlerStart);

      const attributeLlmInvokeMs =
        ex.timings.attempts.find((a) => a.success)?.llm_invoke_ms ?? null;

      console.log(
        `[intent-demo] 动词前缀剥离 → 属性提取 remainder="${verbRemainder}" handler_total_ms=${handler_total_ms} extract_wall_ms=${ex.timings.extract_wall_ms}`
      );

      return c.json(
        await maybeAttachStandardLlm(
          compare_standard,
          standardBaselinePromise,
          {
            intent: "FIND_ITEM",
            routing: "verb_find_llm_attributes",
            intent_skip_reason: "verb_find_prefix",
            verb_remainder: verbRemainder,
            dictionary: null,
            intent_recognition_ms: 0,
            intent_llm_invoke_ms: null,
            primary_model: modelName(),
            enable_thinking: thinkOn,
            search_params: ex.search_params,
            price_heuristic: ex.price_heuristic,
            deterministic_slots: ex.deterministic_slots,
            attribute_extraction_ms: ex.timings.extract_wall_ms,
            attribute_llm_invoke_ms: attributeLlmInvokeMs,
            timings: {
              json_parse_ms,
              validation_ms,
              dictionary_lookup_ms,
              classify_skipped: true,
              extract_skipped: false,
              classify_await_ms: 0,
              classify: null,
              extract_await_ms,
              extract: ex.timings,
              handler_total_ms,
            },
          }
        )
      );
    }

    if (!intentClassificationEnabled()) {
      standardBaselinePromise = compare_standard
        ? runStandardLlmBaseline(message, normalizedHistory, thinkOn)
        : null;

      const beforeExtract = performance.now();
      const ex = await extractSearchParams(message, extractRequestOpts);
      const extract_await_ms = Math.round(performance.now() - beforeExtract);

      const handler_total_ms = Math.round(performance.now() - handlerStart);
      const attributeLlmInvokeMs =
        ex.timings.attempts.find((a) => a.success)?.llm_invoke_ms ?? null;

      console.log(
        `[intent-demo] 仅属性提取 → 属性提取 extract_wall_ms=${ex.timings.extract_wall_ms} fallback_extract=${ex.timings.fallback}`
      );

      return c.json(
        await maybeAttachStandardLlm(
          compare_standard,
          standardBaselinePromise,
          {
            intent: "FIND_ITEM",
            routing: "extract_only_find_item",
            intent_skip_reason: "intent_classification_disabled",
            verb_remainder: null,
            dictionary: null,
            intent_recognition_ms: 0,
            intent_llm_invoke_ms: null,
            primary_model: modelName(),
            enable_thinking: thinkOn,
            search_params: ex.search_params,
            price_heuristic: ex.price_heuristic,
            deterministic_slots: ex.deterministic_slots,
            attribute_extraction_ms: ex.timings.extract_wall_ms,
            attribute_llm_invoke_ms: attributeLlmInvokeMs,
            timings: {
              json_parse_ms,
              validation_ms,
              dictionary_lookup_ms,
              classify_skipped: true,
              extract_skipped: false,
              classify_await_ms: 0,
              classify: null,
              extract_await_ms,
              extract: ex.timings,
              handler_total_ms,
            },
          }
        )
      );
    }

    const beforeClassify = performance.now();
    const cl = await classifyIntent(message);
    const classify_await_ms = Math.round(performance.now() - beforeClassify);

    const intentLlmInvokeMs =
      cl.timings.attempts.find((a) => a.success)?.llm_invoke_ms ?? null;

    if (cl.intent !== "FIND_ITEM") {
      const handler_total_ms = Math.round(performance.now() - handlerStart);

      console.log(
        `[intent-demo] 意图识别非找货 → 属性提取 intent=${cl.intent} classify_wall_ms=${cl.timings.classify_wall_ms}`
      );

      return c.json({
        intent: cl.intent,
        routing: "classify_non_find_item",
        intent_skip_reason: null,
        verb_remainder: null,
        dictionary: null,
        intent_recognition_ms: cl.timings.classify_wall_ms,
        intent_llm_invoke_ms: intentLlmInvokeMs,
        primary_model: modelName(),
        enable_thinking: thinkOn,
        search_params: null,
        price_heuristic: null,
        attribute_extraction_ms: null,
        attribute_llm_invoke_ms: null,
        timings: {
          json_parse_ms,
          validation_ms,
          dictionary_lookup_ms,
          classify_skipped: false,
          extract_skipped: true,
          classify_await_ms,
          classify: cl.timings,
          extract_await_ms: 0,
          extract: null,
          handler_total_ms,
        },
      });
    }

    standardBaselinePromise = compare_standard
      ? runStandardLlmBaseline(message, normalizedHistory, thinkOn)
      : null;

    const beforeExtract = performance.now();
    const ex = await extractSearchParams(message, extractRequestOpts);
    const extract_await_ms = Math.round(performance.now() - beforeExtract);

    const handler_total_ms = Math.round(performance.now() - handlerStart);
    const attributeLlmInvokeMs =
      ex.timings.attempts.find((a) => a.success)?.llm_invoke_ms ?? null;

    console.log(
      `[intent-demo] 意图识别找货 → 属性提取 intent=FIND_ITEM extract_wall_ms=${ex.timings.extract_wall_ms}`
    );

    return c.json(
      await maybeAttachStandardLlm(compare_standard, standardBaselinePromise, {
        intent: "FIND_ITEM",
        routing: "classify_find_item_extract",
        intent_skip_reason: null,
        verb_remainder: null,
        dictionary: null,
        intent_recognition_ms: cl.timings.classify_wall_ms,
        intent_llm_invoke_ms: intentLlmInvokeMs,
        primary_model: modelName(),
        enable_thinking: thinkOn,
        search_params: ex.search_params,
        price_heuristic: ex.price_heuristic,
        deterministic_slots: ex.deterministic_slots,
        attribute_extraction_ms: ex.timings.extract_wall_ms,
        attribute_llm_invoke_ms: attributeLlmInvokeMs,
        timings: {
          json_parse_ms,
          validation_ms,
          dictionary_lookup_ms,
          classify_skipped: false,
          extract_skipped: false,
          classify_await_ms,
          classify: cl.timings,
          extract_await_ms,
          extract: ex.timings,
          handler_total_ms,
        },
      })
    );
  } catch (e) {
    if (standardBaselinePromise) {
      void standardBaselinePromise.catch(() => {});
    }
    console.error("[intent-demo] /intent error:", e);
    const msg = e instanceof Error ? e.message : "internal_error";
    return c.json(
      {
        error: msg,
        timings: {
          json_parse_ms,
          validation_ms,
          handler_total_ms: Math.round(performance.now() - handlerStart),
        },
      },
      500
    );
  }
});

const port = Number.parseInt(process.env.PORT?.trim() ?? "3000", 10) || 3000;

const modelLabel = process.env.MODEL_NAME?.trim() || "qwen-turbo-latest";
const standardLabel = process.env.MODEL_STANDARD?.trim() || "qwen-plus-latest";
const dictLabel = searchDictionaryEnabled() ? "on" : "off";
const intentLabel = intentClassificationEnabled() ? "on" : "off";
console.log(
  `[intent-demo] http://localhost:${port}/ (intent_classify=${intentLabel}, primary=${modelLabel}, standard_extract=${standardLabel}, search_dictionary=${dictLabel})`
);

export default {
  port,
  fetch: app.fetch,
};
