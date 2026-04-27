from __future__ import annotations

import json
import logging
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


async def recommend_orphan_offer_strategy(payload: dict) -> dict:
    """
    Lightweight, single-shot Gemini call to recommend a discount and fill-prob uplift.
    Designed for hackathon demo: deterministic shuffle + AI-assisted monetization estimate.
    """
    try:
        model = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            temperature=0.2,
            google_api_key=settings.GEMINI_API_KEY,
        )

        today = date.today().isoformat()
        human = json.dumps({"today": today, **payload}, ensure_ascii=False)
        resp = await model.ainvoke([{"role": "system", "content": _SYSTEM}, {"role": "user", "content": human}])
        text = getattr(resp, "content", "") if resp else ""
        data = json.loads(text)
        return data
    except Exception:
        logger.exception("Failed to compute orphan-offer strategy via Gemini; using fallback.")
        # Fallback: modest lift assumptions
        return {
            "discount_pct": 0.30,
            "fill_prob_before": float(payload.get("fill_prob_before", 0.10)),
            "fill_prob_after": 0.22,
            "notes": "Fallback estimate (AI unavailable).",
        }

