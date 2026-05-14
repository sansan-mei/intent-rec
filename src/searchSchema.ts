import { z } from "zod";

/**
 * 对齐 AI助手.yml「属性提取」字段。
 * DashScope / OpenAI structured outputs：禁止「仅有 .optional()」的可缺省字段，须改为「必填但可为 null」。
 */
export const SearchParamsSchema = z.object({
  q: z
    .string()
    .describe(
      "向量检索用：贴近商品标题和AI总结风格的短自然描述（约12-48字），优先包含品类、材质、形态及少量明确属性；允许保留圈口、卡数、毫米等标题常见尺寸词；禁止价格、热度复述和无证据发挥",
    ),
  price_min: z
    .number()
    .nullable()
    .describe(
      "仅当用户明确给出下限或规则允许推断时填写，否则 null；禁止编造",
    ),
  price_max: z
    .number()
    .nullable()
    .describe(
      "仅当用户明确预算/上限表述时填写，否则 null；禁止靠品类臆测",
    ),
  heat_min: z
    .number()
    .nullable()
    .describe("仅当有围观/出价等量或明确「围观最多」类表述时填；否则 null"),
  heat_max: z
    .number()
    .nullable()
    .describe("同上；未提及则为 null"),
  inner_circle_size_min: z
    .number()
    .nullable()
    .describe("仅当用户明确提到手镯/戒指圈口、戒圈、内径、手寸等尺寸时填写下限；否则 null"),
  inner_circle_size_max: z
    .number()
    .nullable()
    .describe("仅当用户明确提到圈口/戒圈范围时填写上限；单点尺寸保持 null；否则 null"),
  is_uncertain: z.boolean().nullable(),
  is_free_guarantee: z.boolean().nullable(),
  is_searchable: z.boolean().nullable(),
  has_discount: z.boolean().nullable(),
  category_id: z.number().nullable(),
  core_word: z
    .string()
    .nullable()
    .describe("必须为 null，禁止填写任何实体词"),
  is_early_close: z.boolean().nullable(),
  negative_filters: z.array(z.string()).nullable(),
});

export type SearchParams = z.infer<typeof SearchParamsSchema>;
