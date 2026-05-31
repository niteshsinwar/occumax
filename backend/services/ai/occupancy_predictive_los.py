"""
Predict optimal demand-aligned length of stay (ALOS) for an occupancy slice.

Uses Poly AI via langchain-openai (same stack as pricing/receptionist agents).
Context mixes live DB-derived analytics summaries with an explicitly supplied
current-event awareness feed.
"""

from __future__ import annotations

import json
import logging
import re
import asyncio
from typing import Literal
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field, field_validator

from config import settings

logger = logging.getLogger(__name__)


_SYSTEM = """You are a principal revenue manager for an upscale urban hotel.

Task: recommend the single best TARGET length-of-stay (in nights) that demand patterns imply \
guests will want *during the given stay window*, so inventory can be reshaped (via moves of existing SOFT bookings) \
to open more contiguous EMPTY runs of that length.

Output ONLY valid JSON (no markdown fences):
{
  "recommended_los_nights": <integer 2-7>,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "rationale": "<2-4 concise sentences, cite signals>"
}

Rules:
- Use only the supplied JSON context. Do not invent weather, events, travel disruption, or market news.
- Recommend a RECOVERY target LOS for reshuffling inventory, not merely the most common historical LOS.
- Never output 1 night: k=1 creates no new recovery value because every empty room-night is already a 1-night window.
- Prefer the LOS lengths that are supported by the in-window booking histogram, pace/on-books signals, and supplied current-event feed.
- Prefer 3-4 nights when supplied event context indicates convention or midweek corporate compression.
- Prefer 2 nights when supplied travel disruption or last-minute leisure context dominates.
- Never exceed 7 unless explicitly justified — clamp your mental choice before emitting JSON.
"""


class _PredictLosLLMOutput(BaseModel):
    recommended_los_nights: int = Field(ge=2, le=7)
    confidence: Literal["HIGH", "MEDIUM", "LOW"] = "MEDIUM"
    rationale: str = ""

    @field_validator("recommended_los_nights", mode="before")
    @classmethod
    def _coerce_los(cls, value: Any) -> int:
        try:
            k = int(value)
        except (TypeError, ValueError):
            k = 3
        return max(2, min(7, k))

    @field_validator("confidence", mode="before")
    @classmethod
    def _coerce_confidence(cls, value: Any) -> str:
        conf = str(value or "MEDIUM").upper()
        return conf if conf in {"HIGH", "MEDIUM", "LOW"} else "MEDIUM"

    @field_validator("rationale", mode="before")
    @classmethod
    def _coerce_rationale(cls, value: Any) -> str:
        text = str(value or "").strip()
        return text or "No rationale returned."


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
        resp = await asyncio.wait_for(
            llm.ainvoke([SystemMessage(content=_SYSTEM), human]),
            timeout=45,
        )
        content = getattr(resp, "content", "") or ""
        if isinstance(content, list):
            content = "".join(
                p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
            )
        raw_parsed = _parse_json(
            content,
            {"recommended_los_nights": 3, "confidence": "LOW", "rationale": "Fallback - model output was not valid JSON."},
        )
        parsed = _PredictLosLLMOutput.model_validate(raw_parsed)
        return parsed.model_dump()
    except Exception as exc:
        logger.warning("predict_optimal_los LLM failed: %s", exc)
        return {
            "recommended_los_nights": 3,
            "confidence": "LOW",
            "rationale": "Poly AI call failed - using conservative default recovery target (3 nights).",
        }
