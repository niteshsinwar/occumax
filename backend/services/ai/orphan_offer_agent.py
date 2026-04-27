from __future__ import annotations

import json
import logging
import re
from datetime import date

from langchain_google_genai import ChatGoogleGenerativeAI

from config import settings

logger = logging.getLogger(__name__)


_SYSTEM = """\
You are a hotel revenue AI. Your task is to pick a discount for orphan-night offers (single stranded nights)
and estimate how much that discount increases the chance the orphan night sells.

Return ONLY a JSON object with:
{
  "discount_pct": number,              // between 0.05 and 0.80
  "fill_prob_before": number,          // 0.0 to 1.0
  "fill_prob_after": number,           // 0.0 to 1.0, must be >= fill_prob_before
  "notes": string
}

Guidance:
- Orphan-night gaps are hard to sell; discount helps, but keep it realistic.
- If lead time is short (0–3 days), discount can be moderate; if far out, be conservative.
- Use common-sense hotel logic; do not invent external data sources.
"""


def _parse_strategy_json(text: str) -> dict:
    """Extract JSON object from model output (handles markdown fences or extra prose)."""
    if not text or not str(text).strip():
        raise ValueError("empty model response")
    raw = str(text).strip()
    # Strip ```json ... ``` fences if present
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    raw = raw.strip()
    if raw.startswith("{") and raw.endswith("}"):
        return json.loads(raw)
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        raise ValueError("no JSON object in model response")
    return json.loads(m.group(0))


def _normalize_strategy(data: dict, fill_prob_before_default: float) -> dict:
    discount_pct = float(data.get("discount_pct", 0.30))
    discount_pct = max(0.05, min(0.80, discount_pct))
    before = max(0.0, min(1.0, float(data.get("fill_prob_before", fill_prob_before_default))))
    after = max(before, min(1.0, float(data.get("fill_prob_after", before + 0.12))))
    notes = str(data.get("notes", "") or "").strip()
    return {
        "discount_pct": discount_pct,
        "fill_prob_before": before,
        "fill_prob_after": after,
        "notes": notes or "Model estimate for orphan-night conversion lift.",
    }


async def recommend_orphan_offer_strategy(payload: dict) -> dict:
    """
    Lightweight, single-shot Gemini call to recommend a discount and fill-prob uplift.
    Designed for hackathon demo: deterministic shuffle + AI-assisted monetization estimate.
    """
    fill_default = float(payload.get("fill_prob_before", 0.10))
    try:
        if not getattr(settings, "GEMINI_API_KEY", None):
            raise RuntimeError("GEMINI_API_KEY not configured")

        model = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            temperature=0.2,
            google_api_key=settings.GEMINI_API_KEY,
        )

        today = date.today().isoformat()
        human = json.dumps({"today": today, **payload}, ensure_ascii=False)
        resp = await model.ainvoke([{"role": "system", "content": _SYSTEM}, {"role": "user", "content": human}])
        text = getattr(resp, "content", "") if resp else ""
        if isinstance(text, list):
            # Some providers return content blocks
            text = "".join(
                getattr(b, "text", str(b)) if not isinstance(b, str) else b
                for b in text
            )
        raw = _parse_strategy_json(text)
        return _normalize_strategy(raw, fill_default)
    except Exception:
        logger.exception("Failed to compute orphan-offer strategy via Gemini; using heuristic fallback.")
        before = max(0.0, min(1.0, fill_default))
        after = min(1.0, before + 0.12)
        return _normalize_strategy(
            {
                "discount_pct": 0.30,
                "fill_prob_before": before,
                "fill_prob_after": after,
                "notes": "Heuristic estimate (Gemini unavailable or response not parseable).",
            },
            fill_default,
        )

