import { readFileSync } from "node:fs";
import path from "node:path";

/** 与 AI助手.yml「意图识别」四类对齐；正文在仓库 `prompts/intent_classification.txt`。 */
const promptPath = path.join(
  import.meta.dir,
  "..",
  "prompts",
  "intent_classification.txt",
);

export const INTENT_SYSTEM_PROMPT = `${readFileSync(promptPath, "utf8").trimEnd()}

---

上下文：（本 Demo 不提供历史对话归档，仅根据下一条用户消息分类意图。）
用户描述见下一条 User 消息。
`;
