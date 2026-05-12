/**
 * 热搜词 / 运营配置的「标题 → 标签 ID」映射。
 * 命中词典时返回 tag_id + es_text_query；主链路仍会调用属性抽取 LLM，与 search_params 一并给 ES。
 *
 * 路由辅助：
 * - 用户句首带「找/想买/要买/我要买/帮我找/搜…」等找货句式 → 先剥离动词再对主体做词典匹配。
 */

import { readFileSync } from "node:fs";

export type DictionaryHit = {
  tag_id: number;
  matched_pattern: string;
  /** 用作 ES 检索的文本（动词剥离后的主体或原句） */
  es_text_query: string;
};

type DictionaryEntry = { tag_id: number; patterns: string[] };

const BUILTIN: DictionaryEntry[] = [
  { tag_id: 366641, patterns: ["翡翠镶嵌"] },
  { tag_id: 216077, patterns: ["摆件"] },
  { tag_id: 657836, patterns: ["翡翠挂件"] },
  { tag_id: 244865, patterns: ["紫色翡翠蛋面"] },
  {
    tag_id: 1132489,
    patterns: ["想找和田玉原石", "和田玉原石"],
  },
  { tag_id: 1066889, patterns: ["苏纪石"] },
  { tag_id: 742059, patterns: ["耳饰"] },
  { tag_id: 1070761, patterns: ["玉石和田玉"] },
  { tag_id: 325202, patterns: ["翡翠手镯", "手镯"] },
];

/** 句首找货触发词（与 strip 一致）；命中则表示找货句式，可跳过意图 LLM */
export const SEARCH_VERB_PREFIX_RES: RegExp[] = [
  /^(?:请)?(?:帮我|替我)?找一下[：:\s]*/u,
  /^(?:请)?(?:帮我|替我)?找[：:\s]*/u,
  /^想找[：:\s]*/u,
  /^想买[：:\s]*/u,
  /^要买[：:\s]*/u,
  /^我要找[：:\s]*/u,
  /^我要买[：:\s]*/u,
  /^我要[：:\s]*/u,
  /^看看有没有[：:\s]*/u,
  /^有没有[：:\s]*/u,
  /^搜一下[：:\s]*/u,
  /^搜[：:\s]*/u,
  /^找[：:\s]*/u,
];

function stripSearchPrefixes(raw: string): string {
  let q = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of SEARCH_VERB_PREFIX_RES) {
      const next = q.replace(re, "").trim();
      if (next !== q) {
        q = next;
        changed = true;
        break;
      }
    }
  }
  return q;
}

/** 是否以找货句式开头（跳过意图 LLM 的依据之一） */
export function hasSearchVerbPrefix(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  return SEARCH_VERB_PREFIX_RES.some((re) => re.test(t));
}

/**
 * 若为「找货句式 + xxx」且 xxx 非空，返回去掉前缀后的主体；否则 null（走意图模型）。
 */
export function tryVerbFindRemainder(message: string): string | null {
  const t = message.trim();
  if (!t) return null;
  if (!hasSearchVerbPrefix(t)) return null;
  const remainder = stripSearchPrefixes(t).trim();
  if (!remainder) return null;
  return remainder;
}

function loadExtraEntries(): DictionaryEntry[] {
  const p = process.env.SEARCH_DICTIONARY_EXTRA_PATH?.trim();
  if (!p) return [];
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: DictionaryEntry[] = [];
    for (const row of parsed) {
      if (
        row &&
        typeof row === "object" &&
        "tag_id" in row &&
        "patterns" in row &&
        Array.isArray((row as DictionaryEntry).patterns)
      ) {
        const tag_id = Number((row as DictionaryEntry).tag_id);
        const patterns = (row as DictionaryEntry).patterns.filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0,
        );
        if (Number.isFinite(tag_id) && patterns.length) {
          out.push({ tag_id, patterns });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

let cachedFlat: { pattern: string; tag_id: number }[] | null = null;

function flattenedPatterns(): { pattern: string; tag_id: number }[] {
  if (cachedFlat) return cachedFlat;
  const merged = [...BUILTIN, ...loadExtraEntries()];
  const flat = merged.flatMap((e) =>
    e.patterns.map((pattern) => ({ pattern: pattern.trim(), tag_id: e.tag_id })),
  );
  flat.sort((a, b) => b.pattern.length - a.pattern.length);
  cachedFlat = flat;
  return cachedFlat;
}

const PREFIX_MATCH_MIN_LEN = 4;

function matchExactOnCandidates(
  candidates: string[],
): DictionaryHit | null {
  const flat = flattenedPatterns();
  for (const cand of candidates) {
    if (!cand) continue;
    for (const { pattern, tag_id } of flat) {
      if (!pattern) continue;
      if (cand === pattern) {
        return {
          tag_id,
          matched_pattern: pattern,
          es_text_query: cand,
        };
      }
      if (
        pattern.length >= PREFIX_MATCH_MIN_LEN &&
        cand.startsWith(pattern)
      ) {
        const rest = cand.slice(pattern.length);
        if (
          rest === "" ||
          /^[，,。；;：:\s]/.test(rest) ||
          pattern.length >= 6
        ) {
          return {
            tag_id,
            matched_pattern: pattern,
            es_text_query: cand,
          };
        }
      }
    }
  }
  return null;
}

/** 模糊：候选串包含词条（最长优先）；再尝试词条包含候选串（短词命中长标题） */
export function matchSearchDictionaryFuzzy(rawMessage: string): DictionaryHit | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;

  const stripped = stripSearchPrefixes(trimmed);
  const candidates = Array.from(new Set([trimmed, stripped].filter(Boolean)));

  const exact = matchExactOnCandidates(candidates);
  if (exact) return exact;

  const flat = flattenedPatterns();
  const MIN_CONTAINS_LEN = 2;

  for (const cand of candidates) {
    if (!cand) continue;
    for (const { pattern, tag_id } of flat) {
      if (pattern.length < MIN_CONTAINS_LEN) continue;
      if (cand.includes(pattern)) {
        return {
          tag_id,
          matched_pattern: pattern,
          es_text_query: cand,
        };
      }
    }
  }

  for (const cand of candidates) {
    if (cand.length < MIN_CONTAINS_LEN) continue;
    for (const { pattern, tag_id } of flat) {
      if (pattern.includes(cand)) {
        return {
          tag_id,
          matched_pattern: pattern,
          es_text_query: cand,
        };
      }
    }
  }

  return null;
}

export function searchDictionaryEnabled(): boolean {
  const v = process.env.SEARCH_DICTIONARY_ENABLED?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}
