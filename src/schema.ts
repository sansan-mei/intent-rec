import { z } from "zod";

export const INTENT_VALUES = [
  "FIND_ITEM",
  "KNOWLEDGE_QA",
  "APP_QA",
  "CHAT",
] as const;

export const IntentSchema = z.object({
  intent: z.enum(INTENT_VALUES),
});

export type Intent = z.infer<typeof IntentSchema>["intent"];
