/** 行话「小五一开」「中六三开」「小七二开」：与 {@link ./priceHeuristic} 中区间口径一致 */

export const KAI_DIGIT: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function rangeForKaiOpen(
  si: string,
  wei: string,
  digit: number
): { lo: number; hi: number } | null {
  if (digit < 1 || digit > 9) return null;
  if (wei === "五") {
    if (si === "小") {
      const lo = digit * 10_000;
      return { lo, hi: lo + 9999 };
    }
    if (si === "中") {
      const base = (digit + 3) * 10_000;
      if (base > 99_999) return null;
      return { lo: base, hi: base + 9999 };
    }
    if (si === "大") {
      const base = (digit + 6) * 10_000;
      if (base > 99_999) return null;
      return { lo: base, hi: base + 9999 };
    }
  }
  if (wei === "六") {
    if (si === "小") {
      if (digit > 3) return null;
      const lo = digit * 100_000;
      return { lo, hi: lo + 99_999 };
    }
    if (si === "中") {
      if (digit > 3) return null;
      const lo = (digit + 3) * 100_000;
      return { lo, hi: lo + 99_999 };
    }
    if (si === "大") {
      if (digit > 3) return null;
      const lo = (digit + 6) * 100_000;
      return { lo, hi: lo + 99_999 };
    }
  }
  if (wei === "七") {
    if (si === "小") {
      if (digit > 3) return null;
      const lo = digit * 1_000_000;
      return { lo, hi: lo + 999_999 };
    }
    if (si === "中") {
      if (digit > 3) return null;
      const lo = (digit + 3) * 1_000_000;
      return { lo, hi: lo + 999_999 };
    }
    if (si === "大") {
      if (digit > 3) return null;
      const lo = (digit + 6) * 1_000_000;
      return { lo, hi: lo + 999_999 };
    }
  }
  return null;
}

/** 全部「小中大 + 五六七 + 一二…九 + 开」短语，供前置替换按最长词命中 */
export function allKaiOpenPhrases(): { pattern: string; min: number; max: number }[] {
  const out: { pattern: string; min: number; max: number }[] = [];
  for (const si of ["小", "中", "大"] as const) {
    for (const wei of ["五", "六", "七"] as const) {
      for (const ch of Object.keys(KAI_DIGIT)) {
        const digit = KAI_DIGIT[ch];
        const r = rangeForKaiOpen(si, wei, digit);
        if (!r) continue;
        out.push({ pattern: `${si}${wei}${ch}开`, min: r.lo, max: r.hi });
      }
    }
  }
  return out;
}
