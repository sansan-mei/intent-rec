/**
 * 用户原文前置：把常见珠宝行话换成「数字-数字」区间，便于下游 LLM / 规则统一理解。
 *
 * 例：翡翠手镯，中五 → 翡翠手镯，10000-39999（口径见 {@link ./priceSlangLexicon}）
 */

import { allKaiOpenPhrases } from "./priceKaiOpen";
import { PRICE_SLANG_LEXICON } from "./priceSlangLexicon";

export type PriceTermReplacement = { from: string; to: string };

let cachedRules: { pattern: string; display: string }[] | null = null;

function buildRulesFromSlang(): { pattern: string; display: string }[] {
  const rules: { pattern: string; display: string }[] = [];

  for (const k of allKaiOpenPhrases()) {
    rules.push({ pattern: k.pattern, display: `${k.min}-${k.max}` });
  }

  for (const e of PRICE_SLANG_LEXICON) {
    for (const pattern of e.patterns) {
      rules.push({ pattern, display: `${e.min}-${e.max}` });
    }
  }

  const seen = new Set<string>();
  const dedup: { pattern: string; display: string }[] = [];
  for (const r of rules.sort((a, b) => b.pattern.length - a.pattern.length)) {
    if (seen.has(r.pattern)) continue;
    seen.add(r.pattern);
    dedup.push(r);
  }
  return dedup.sort((a, b) => b.pattern.length - a.pattern.length);
}

export function getPriceTermReplacementRules(): {
  pattern: string;
  display: string;
}[] {
  if (!cachedRules) {
    cachedRules = buildRulesFromSlang();
  }
  return cachedRules;
}

/** 从左到右最长匹配替换，避免短词抢先吃掉长词（如「7-10百」与「10百」）。 */
export function replacePriceTermsLongest(
  message: string,
  rules: { pattern: string; display: string }[] = getPriceTermReplacementRules()
): { text: string; replacements: PriceTermReplacement[] } {
  const replacements: PriceTermReplacement[] = [];
  let i = 0;
  let out = "";
  const s = message;

  while (i < s.length) {
    let hit: { pattern: string; display: string } | null = null;
    for (const r of rules) {
      const { pattern } = r;
      if (!pattern) continue;
      if (s.startsWith(pattern, i)) {
        if (
          pattern.endsWith("价") &&
          s.slice(i + pattern.length, i + pattern.length + 1) === "位"
        ) {
          continue;
        }
        hit = r;
        break;
      }
    }
    if (hit) {
      out += hit.display;
      replacements.push({ from: hit.pattern, to: hit.display });
      i += hit.pattern.length;
    } else {
      out += s[i];
      i += 1;
    }
  }

  return { text: out, replacements };
}

export function preprocessUserPriceTerms(message: string): {
  text: string;
  replacements: PriceTermReplacement[];
} {
  return replacePriceTermsLongest(message.trim());
}
