from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass
import re
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage


AROUND_LOW = 0.8
AROUND_HIGH = 1.2


@dataclass(frozen=True)
class LexiconEntry:
    patterns: tuple[str, ...]
    min_price: int
    max_price: int


LEXICON: tuple[LexiconEntry, ...] = (
    LexiconEntry(("小五价", "小五"), 10_000, 19_999),
    LexiconEntry(("小万",), 10_000, 39_999),
    LexiconEntry(("中五价", "中五"), 10_000, 39_999),
    LexiconEntry(("大五价", "大五"), 40_000, 99_999),
    LexiconEntry(("小六价", "小六"), 100_000, 399_999),
    LexiconEntry(("中六价", "中六"), 400_000, 699_999),
    LexiconEntry(("大六价", "大六"), 700_000, 999_999),
    LexiconEntry(("小千价", "小千", "小四价", "小四"), 1_000, 3_999),
    LexiconEntry(("中千价", "中千", "中四价", "中四"), 4_000, 6_999),
    LexiconEntry(("大千价", "大千", "大四价", "大四"), 7_000, 9_999),
    LexiconEntry(("万把块", "万把块钱", "一万来块", "万把"), 9_000, 13_000),
    LexiconEntry(("千把块", "千把块钱", "一千来块"), 900, 1_800),
)

RANGE_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*[-~到至]\s*([\d,]+(?:\.\d+)?)(万|w|W|千|k|K)?")
AROUND_RE = re.compile(
    r"([\d,]+(?:\.\d+)?)\s*(万|w|W|千|k|K)?\s*(左右|上下|大概|差不多)(?:吧|啊|呀|呢|哦|噢|嗯)?"
)


def _scale(number: float, unit: str | None) -> int:
    if not unit:
        return round(number)
    u = unit.lower()
    if u in {"万", "w"}:
        return round(number * 10_000)
    if u in {"千", "k"}:
        return round(number * 1_000)
    return round(number)


def _to_number(text: str) -> float | None:
    try:
        return float(text.replace(",", "").strip())
    except Exception:
        return None


def _replace_slang(query: str) -> tuple[str, list[str]]:
    hits: list[str] = []
    out = query
    flat: list[tuple[str, int, int]] = []
    for entry in LEXICON:
        for pattern in entry.patterns:
            flat.append((pattern, entry.min_price, entry.max_price))
    flat.sort(key=lambda x: len(x[0]), reverse=True)

    for pattern, lo, hi in flat:
        if pattern in out:
            out = out.replace(pattern, f"{lo}-{hi}")
            hits.append(f"lexicon:{pattern}->{lo}-{hi}")
    return out, hits


def _extract_price(query: str, hits: list[str]) -> tuple[int | None, int | None]:
    price_min: int | None = None
    price_max: int | None = None

    range_match = RANGE_RE.search(query)
    if range_match:
        a = _to_number(range_match.group(1))
        b = _to_number(range_match.group(2))
        unit = range_match.group(3)
        if a is not None and b is not None:
            lo = min(_scale(a, unit), _scale(b, unit))
            hi = max(_scale(a, unit), _scale(b, unit))
            price_min, price_max = lo, hi
            hits.append(f"range:{lo}-{hi}")

    if price_min is None and price_max is None:
        around_match = AROUND_RE.search(query)
        if around_match:
            v = _to_number(around_match.group(1))
            unit = around_match.group(2)
            if v is not None:
                center = _scale(v, unit)
                lo = max(0, round(center * AROUND_LOW))
                hi = max(0, round(center * AROUND_HIGH))
                price_min, price_max = lo, hi
                hits.append(f"around:{center}->{lo}-{hi}")

    return price_min, price_max


def _merge_attributes(
    confirmed_attributes: dict[str, Any] | None,
    price_min: int | None,
    price_max: int | None,
) -> dict[str, Any]:
    merged = dict(confirmed_attributes or {})
    # 上游已明确时保持上游值；空缺时由启发式补齐。
    if merged.get("price_min") in (None, "") and price_min is not None:
        merged["price_min"] = price_min
    if merged.get("price_max") in (None, "") and price_max is not None:
        merged["price_max"] = price_max
    return merged


class HeuristicPreprocessTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        query = str(tool_parameters.get("query", "")).strip()
        confirmed_attributes = tool_parameters.get("confirmed_attributes")
        if not isinstance(confirmed_attributes, dict):
            confirmed_attributes = {}

        normalized_query, hits = _replace_slang(query)
        price_min, price_max = _extract_price(query, hits)
        merged_attributes = _merge_attributes(confirmed_attributes, price_min, price_max)

        after_let = normalized_query
        if price_min is not None and price_max is not None:
            after_let = f"{normalized_query}（启发式价位->{price_min}-{price_max}）"

        payload = {
            "after_let": after_let,
            "confirmed_attributes": merged_attributes,
            "heuristic": {
                "price_min": price_min,
                "price_max": price_max,
                "hits": hits,
            },
        }
        yield self.create_json_message(payload)
