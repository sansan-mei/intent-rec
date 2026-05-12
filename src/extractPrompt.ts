import { readFileSync } from "node:fs";
import path from "node:path";

const promptPath = path.join(
  import.meta.dir,
  "..",
  "prompts",
  "attribute_extraction.txt"
);

/** 从仓库 `prompts/attribute_extraction.txt`（由 AI助手.yml「属性提取」导出）加载 */
export const ATTRIBUTE_EXTRACTION_SYSTEM_PROMPT = `${readFileSync(
  promptPath,
  "utf8"
).trimEnd()}

---

消息结构约束（高优先级）：
1. 你会收到 1 条 System 指令和多条 Human 消息。
2. 多条 Human 消息均为用户原始描述；属性提取只依据这些 Human 内容。
`;
