/**
 * 珠宝/闲置交易常见价位行话（与业务口径对齐后可再调 min/max）。
 * 供 {@link ./priceHeuristic} 抽取区间与 {@link ./preprocessPriceTerms} 替换为数字区间共用。
 */
export type PriceSlangLexiconEntry = {
  patterns: string[];
  min: number;
  max: number;
};

export const PRICE_SLANG_LEXICON: PriceSlangLexiconEntry[] = [
  { patterns: ["小五价", "小五"], min: 10_000, max: 19_999 },
  { patterns: ["小万"], min: 10_000, max: 39_999 },
  { patterns: ["中五价", "中五"], min: 10_000, max: 39_999 },
  { patterns: ["大五价", "大五"], min: 40_000, max: 99_999 },
  { patterns: ["小六价", "小六"], min: 100_000, max: 399_999 },
  { patterns: ["中六价", "中六"], min: 400_000, max: 699_999 },
  { patterns: ["大六价", "大六"], min: 700_000, max: 999_999 },
  { patterns: ["小七价", "小七"], min: 1_000_000, max: 3_999_999 },
  { patterns: ["中七价", "中七"], min: 4_000_000, max: 6_999_999 },
  { patterns: ["大七价", "大七"], min: 7_000_000, max: 9_999_999 },
  {
    patterns: ["小小千", "小千价", "小千", "小四价", "小四"],
    min: 1000,
    max: 3999,
  },
  { patterns: ["中千价", "中千", "中四价", "中四"], min: 4000, max: 6999 },
  { patterns: ["大千价", "大千", "大四价", "大四"], min: 7000, max: 9999 },
  { patterns: ["小小万"], min: 10_000, max: 19_999 },
  { patterns: ["十来万", "小十万"], min: 100_000, max: 199_999 },
  { patterns: ["大几十万"], min: 500_000, max: 990_000 },
  { patterns: ["百来万", "一百来万"], min: 1_000_000, max: 1_999_999 },
  { patterns: ["半万", "半个万"], min: 4000, max: 6500 },
  { patterns: ["万把块", "万把块钱", "一万来块", "万把"], min: 9000, max: 13_000 },
  { patterns: ["千把块", "千把块钱", "一千来块"], min: 900, max: 1800 },
  {
    patterns: [
      "价格千元左右",
      "价位千元左右",
      "预算千元左右",
      "大概千元左右",
      "大约千元左右",
      "也就千元左右",
      "千元左右",
    ],
    min: 800,
    max: 1200,
  },
  {
    patterns: [
      "价格万左右",
      "价位万左右",
      "预算万左右",
      "大概万左右",
      "大约万左右",
      "也就万左右",
    ],
    min: 8000,
    max: 12_000,
  },
];
