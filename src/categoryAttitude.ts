import type { SearchParams } from "./searchSchema";

type CategoryState = {
  id: number;
  label: string;
  status: "positive" | "negative";
  index: number;
};

const CATEGORY_ALIASES: Array<{ id: number; label: string; aliases: string[] }> = [
  { id: 1, label: "翡翠", aliases: ["翡翠"] },
  { id: 2, label: "和田玉", aliases: ["和田玉", "玉石"] },
  { id: 3, label: "钻石", aliases: ["钻石"] },
  { id: 4, label: "彩宝", aliases: ["彩宝", "碧玺", "托帕石", "海蓝宝", "红宝石", "蓝宝石"] },
  { id: 39, label: "书画", aliases: ["书画", "字画", "国画"] },
  { id: 40, label: "黄金", aliases: ["黄金"] },
  { id: 107, label: "金饰", aliases: ["金饰", "K金", "k金", "18k", "18K", "18k金", "18K金", "银饰", "白银"] },
  { id: 108, label: "奢品", aliases: ["奢品", "奢侈品"] },
  { id: 109, label: "文玩", aliases: ["文玩", "蜜蜡", "南红", "绿松石", "沉香", "天珠", "黄花梨"] },
  { id: 110, label: "钱币", aliases: ["钱币", "纪念币", "纪念章", "邮票"] },
  { id: 111, label: "品牌金", aliases: ["品牌金"] },
  { id: 112, label: "茶", aliases: ["茶", "茶叶", "普洱", "普洱茶"] },
  { id: 113, label: "酒", aliases: ["酒", "名酒", "白酒", "老酒"] },
  { id: 114, label: "补品", aliases: ["补品", "燕窝", "花胶"] },
];

const CLAUSE_BOUNDARY_RE = /[，,。.!！?？；;\n]/u;
const NEGATIVE_TAIL_RE =
  /(?:不要|别要|别看|不看|不考虑|排除|剔除|过滤|不是|非|无)\s*(?:这种|这类|那种|那类|这个|那个|的)?$/u;
const POSITIVE_TAIL_RE =
  /(?:还是要|还要|就要|要|想要|想看|看看|找|搜|搜索|换成|改成|来个|来点|推荐)\s*(?:这种|这类|那种|那类|一个|一些|点)?$/u;

function lastClausePrefix(text: string, index: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY_RE.test(text[i])) {
      start = i + 1;
      break;
    }
  }
  return text.slice(start, index).trim();
}

function categoryMentionStatus(text: string, index: number): "positive" | "negative" {
  const prefix = lastClausePrefix(text, index);
  const tail = prefix.slice(-16);
  if (NEGATIVE_TAIL_RE.test(tail)) return "negative";
  if (POSITIVE_TAIL_RE.test(tail)) return "positive";
  return "positive";
}

function findCategoryStates(text: string): CategoryState[] {
  const states: CategoryState[] = [];
  for (const category of CATEGORY_ALIASES) {
    for (const alias of category.aliases) {
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(alias, from);
        if (index < 0) break;
        states.push({
          id: category.id,
          label: category.label,
          status: categoryMentionStatus(text, index),
          index,
        });
        from = index + alias.length;
      }
    }
  }
  return states.sort((a, b) => a.index - b.index);
}

function mergeNegativeFilters(
  existing: string[] | null,
  negativeLabels: string[],
  positiveLabels: string[]
): string[] | null {
  const merged = [...(existing ?? []), ...negativeLabels]
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !positiveLabels.includes(item));
  return merged.length > 0 ? [...new Set(merged)] : null;
}

export function sanitizeCategoryAgainstUserText(
  sp: SearchParams,
  rawUserMessage: string
): SearchParams {
  const text = rawUserMessage.trim();
  if (!text) return sp;

  const mentions = findCategoryStates(text);
  if (mentions.length === 0) return sp;

  const lastByCategory = new Map<number, CategoryState>();
  for (const mention of mentions) {
    lastByCategory.set(mention.id, mention);
  }

  const lastPositive = [...lastByCategory.values()]
    .filter((mention) => mention.status === "positive")
    .sort((a, b) => b.index - a.index)[0];
  const negativeLabels = [...lastByCategory.values()]
    .filter((mention) => mention.status === "negative")
    .map((mention) => mention.label);
  const positiveLabels = [...lastByCategory.values()]
    .filter((mention) => mention.status === "positive")
    .map((mention) => mention.label);

  return {
    ...sp,
    category_id: lastPositive?.id ?? null,
    negative_filters: mergeNegativeFilters(
      sp.negative_filters,
      negativeLabels,
      positiveLabels
    ),
  };
}
