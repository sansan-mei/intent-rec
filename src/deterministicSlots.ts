export type SlotEvidenceSpan = {
  text: string;
  start: number;
  end: number;
  rule: string;
};

export type NumericSlotResult = {
  min: number | null;
  max: number | null;
  evidence_span: SlotEvidenceSpan | null;
  confidence: number;
};

export type DeterministicNumericSlots = {
  price: NumericSlotResult;
  heat: NumericSlotResult;
  inner_circle: NumericSlotResult;
};

function scaleMoney(n: number, unit?: string): number {
  if (!unit) return Math.round(n);
  if (unit === "万") return Math.round(n * 10000);
  if (unit === "千") return Math.round(n * 1000);
  return Math.round(n);
}

function makeEvidence(
  input: string,
  start: number,
  end: number,
  rule: string
): SlotEvidenceSpan {
  return { text: input.slice(start, end), start, end, rule };
}

export function parseDeterministicNumericSlots(
  input: string
): DeterministicNumericSlots {
  const text = input.trim();
  if (!text) {
    return {
      price: { min: null, max: null, evidence_span: null, confidence: 0.2 },
      heat: { min: null, max: null, evidence_span: null, confidence: 0.2 },
      inner_circle: {
        min: null,
        max: null,
        evidence_span: null,
        confidence: 0.2,
      },
    };
  }

  let price: NumericSlotResult = {
    min: null,
    max: null,
    evidence_span: null,
    confidence: 0.35,
  };
  const pricePatterns: Array<{
    re: RegExp;
    rule: string;
    confidence: number;
    map: (m: RegExpExecArray) => { min: number | null; max: number | null };
  }> = [
    {
      re: /(\d+(?:\.\d+)?)\s*(万|千|元|块)?\s*(?:到|至|-|—|~)\s*(\d+(?:\.\d+)?)\s*(万|千|元|块)?/gu,
      rule: "price_range",
      confidence: 0.95,
      map: (m) => {
        const a = scaleMoney(Number(m[1]), m[2]);
        const b = scaleMoney(Number(m[3]), m[4]);
        return { min: Math.min(a, b), max: Math.max(a, b) };
      },
    },
    {
      re: /(\d+(?:\.\d+)?)\s*(万|千|元|块)?\s*(?:以内|以下|不超过|最多|封顶)/gu,
      rule: "price_cap",
      confidence: 0.9,
      map: (m) => ({ min: null, max: scaleMoney(Number(m[1]), m[2]) }),
    },
    {
      re: /(\d+(?:\.\d+)?)\s*(万|千|元|块)?\s*(?:以上|起|往上|不低于|至少)/gu,
      rule: "price_floor",
      confidence: 0.88,
      map: (m) => ({ min: scaleMoney(Number(m[1]), m[2]), max: null }),
    },
    {
      re: /(\d+(?:\.\d+)?)\s*(万|千|元|块)?\s*(?:左右|上下|大概|差不多)/gu,
      rule: "price_around",
      confidence: 0.8,
      map: (m) => {
        const unit = m[2];
        const base = scaleMoney(Number(m[1]), unit);
        const prefix = text.slice(Math.max(0, m.index - 6), m.index);
        const sizeContext = /卡|圈口|内径|直径|港码|手寸|mm|毫米/u.test(prefix);
        if (!unit && base < 1000 && !/价格|预算|价位/u.test(prefix)) {
          return { min: null, max: null };
        }
        if (sizeContext) return { min: null, max: null };
        return { min: Math.round(base * 0.8), max: Math.round(base * 1.2) };
      },
    },
  ];

  let bestPriceMatch: {
    start: number;
    end: number;
    rule: string;
    confidence: number;
    min: number | null;
    max: number | null;
  } | null = null;
  for (const p of pricePatterns) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null = p.re.exec(text);
    while (m) {
      const mapped = p.map(m);
      if (mapped.min !== null || mapped.max !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (!bestPriceMatch || start >= bestPriceMatch.start) {
          bestPriceMatch = {
            start,
            end,
            rule: p.rule,
            confidence: p.confidence,
            min: mapped.min,
            max: mapped.max,
          };
        }
      }
      m = p.re.exec(text);
    }
  }
  if (bestPriceMatch) {
    price = {
      min: bestPriceMatch.min,
      max: bestPriceMatch.max,
      confidence: bestPriceMatch.confidence,
      evidence_span: makeEvidence(
        text,
        bestPriceMatch.start,
        bestPriceMatch.end,
        bestPriceMatch.rule
      ),
    };
  }

  const heatMatch =
    /(围观|出价|竞拍人数|热度|人次)[^\d]{0,8}(\d{1,6})/u.exec(text) ||
    /(\d{1,6})[^\d]{0,6}(围观|出价|竞拍人数|热度|人次)/u.exec(text);
  const heat: NumericSlotResult = heatMatch
    ? {
        min: Number(heatMatch[2] ?? heatMatch[1]),
        max: Number(heatMatch[2] ?? heatMatch[1]),
        confidence: 0.92,
        evidence_span: makeEvidence(
          text,
          heatMatch.index,
          heatMatch.index + heatMatch[0].length,
          "heat_explicit"
        ),
      }
    : { min: null, max: null, evidence_span: null, confidence: 0.86 };

  const innerMatch =
    /(圈口|内径|港码|手寸|直径)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)/u.exec(text) ||
    /(\d{1,3}(?:\.\d+)?)\s*(mm|毫米)/u.exec(text);
  const innerValue = innerMatch
    ? Number(innerMatch[2] ?? innerMatch[1])
    : null;
  const inner_circle: NumericSlotResult =
    innerValue !== null && Number.isFinite(innerValue) && innerValue < 200
      ? {
          min: innerValue,
          max: innerValue,
          confidence: 0.9,
          evidence_span: makeEvidence(
            text,
            innerMatch!.index,
            innerMatch!.index + innerMatch![0].length,
            "inner_explicit"
          ),
        }
      : { min: null, max: null, evidence_span: null, confidence: 0.86 };

  return { price, heat, inner_circle };
}

