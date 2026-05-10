"""
Predict optimal demand-aligned length of stay (ALOS) for an occupancy slice.

Uses Poly AI via langchain-openai (same stack as pricing/receptionist agents).
Context mixes live analytics summaries with deterministic demo overlays (weather / events / flights).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from config import settings

logger = logging.getLogger(__name__)


_SYSTEM = """You are a principal revenue manager for an upscale urban hotel.

Task: recommend the single best TARGET length-of-stay (in nights) that demand patterns imply \
guests will want *during the given stay window*, so inventory can be reshaped (via moves of existing SOFT bookings) \
to open more contiguous EMPTY runs of that length.

Output ONLY valid JSON (no markdown fences):
{
  "recommended_los_nights": <integer 1-7>,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "rationale": "<2-4 concise sentences, cite signals>"
}

Rules:
- Prefer 3–4 nights when conventions / conferences dominate.
- Prefer shorter lengths when heavy disruption / flight cancellations strand travelers last-minute.
- Never exceed 7 unless explicitly justified — clamp your mental choice before emitting JSON.
"""


def _make_llm(max_tokens: int = 800) -> ChatOpenAI:
    return ChatOpenAI(
        model="auto",
        openai_api_base=settings.POLYAI_API_BASE,
        openai_api_key=settings.POLYAI_API_KEY,
        temperature=0.15,
        max_tokens=max_tokens,
        model_kwargs={"response_format": {"type": "text"}},
        extra_body={"prefer": "quality"},
    )


def _parse_json(text: str, default: dict[str, Any]) -> dict[str, Any]:
    raw = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    if raw.startswith("{"):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    m = re.search(r"\{[\s\S]*\}", raw)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return dict(default)


async def run_predict_optimal_los_llm(context: dict[str, Any]) -> dict[str, Any]:
    """
    Invoke Poly AI once with structured context; returns parsed dict with keys matching JSON schema.
    """
    llm = _make_llm()
    human = HumanMessage(content=json.dumps(context, indent=2, default=str))
    try:
        resp = await llm.ainvoke([SystemMessage(content=_SYSTEM), human])
        content = getattr(resp, "content", "") or ""
        if isinstance(content, list):
            content = "".join(
                p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
            )
        parsed = _parse_json(
            content,
            {"recommended_los_nights": 3, "confidence": "LOW", "rationale": "Fallback — model output was not valid JSON."},
        )
        k = int(parsed.get("recommended_los_nights", 3))
        k = max(1, min(7, k))
        conf = str(parsed.get("confidence", "MEDIUM")).upper()
        if conf not in ("HIGH", "MEDIUM", "LOW"):
            conf = "MEDIUM"
        rationale = str(parsed.get("rationale", "")).strip() or "No rationale returned."
        return {"recommended_los_nights": k, "confidence": conf, "rationale": rationale}
    except Exception as exc:
        logger.warning("predict_optimal_los LLM failed: %s", exc)
        return {
            "recommended_los_nights": 3,
            "confidence": "LOW",
            "rationale": "Poly AI call failed — using conservative default (3 nights).",
        }
