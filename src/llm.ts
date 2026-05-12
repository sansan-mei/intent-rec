import { ChatOpenAI } from "@langchain/openai";

export function apiKey(): string {
  return (
    process.env.DASHSCOPE_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export function baseUrl(): string {
  return (
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1"
  );
}

/** 主链路（属性抽取等）默认模型；可用 MODEL_NAME 覆盖。常见：qwen-turbo(-latest)、qwen-flash、qwen-plus、qwen-max、qwen-long 等（以控制台为准） */
export function modelName(): string {
  return process.env.MODEL_NAME?.trim() || "qwen-turbo-latest";
}

/** 对照用标准档模型，与 Dify 工作流 qwen-plus-latest 对齐；可通过 MODEL_STANDARD 覆盖 */
export function standardModelName(): string {
  return process.env.MODEL_STANDARD?.trim() || "qwen-plus-latest";
}

export function timeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 30000;
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

export function attributeTemperature(): number {
  const raw = process.env.ATTRIBUTE_TEMPERATURE?.trim();
  const n = raw ? Number.parseFloat(raw) : 0.3;
  return Number.isFinite(n) ? n : 0.3;
}

export type CreateChatModelOpts = {
  temperature?: number;
  model?: string;
  /**
   * 通义千问（DashScope 兼容 OpenAI）：深度思考 / think 模式。
   * 通过请求体 `enable_thinking` 开启；仅部分模型支持，以控制台文档为准。
   */
  enableThinking?: boolean;
};

export function createChatModel(opts?: CreateChatModelOpts): ChatOpenAI {
  const key = apiKey();
  if (!key) {
    throw new Error(
      "Missing API key: set DASHSCOPE_API_KEY (or OPENAI_API_KEY)"
    );
  }
  const modelKwargs =
    opts?.enableThinking === true ? { enable_thinking: true } : undefined;
  return new ChatOpenAI({
    apiKey: key,
    model: opts?.model ?? modelName(),
    temperature: opts?.temperature ?? 0.2,
    ...(modelKwargs ? { modelKwargs } : {}),
    configuration: {
      baseURL: baseUrl(),
    },
  });
}

export type AttributeChatModelOpts = {
  model?: string;
  enableThinking?: boolean;
};

/** 属性提取温度；默认对齐 Dify（0.3） */
export function createAttributeChatModel(
  modelOrOpts?: string | AttributeChatModelOpts
): ChatOpenAI {
  const opts =
    typeof modelOrOpts === "string"
      ? { model: modelOrOpts }
      : (modelOrOpts ?? {});
  return createChatModel({
    temperature: attributeTemperature(),
    model: opts.model ?? modelName(),
    enableThinking: opts.enableThinking,
  });
}
