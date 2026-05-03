"""
Pricing AI Agent — Multi-call strategy with Poly AI

Strategy (6 sequential + parallel LLM calls):
  1. Parallel: weather analysis, events analysis, market/news analysis, historical analysis
  2. Sequential: synthesis call combining all 4 factor analyses + live occupancy snapshot
  3. Persist results to pricing_recs table for caching / 8AM scheduler

Each call is a focused single-shot LLM invocation (no tools, no graph) — fast and reliable.
The synthesis call aggregates all signals into a 20-day calendar per room category.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import date, timedelta

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from sqlalchemy.ext.asyncio import async_sessionmaker

from config import settings
from services.ai.pricing_mock_data import (
    get_events_for_window,
    get_historical_trends,
    get_market_news,
    get_weather_forecast,
)

logger = logging.getLogger(__name__)

WINDOW_DAYS = 20
CATEGORIES = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "SUITE", "PREMIUM"]


# ── LLM factory ───────────────────────────────────────────────────────────────

def _make_llm(max_tokens: int = 10000) -> ChatOpenAI:
    return ChatOpenAI(
        model="auto",
        openai_api_base=settings.POLYAI_API_BASE,
        openai_api_key=settings.POLYAI_API_KEY,
        temperature=0.2,
        model_kwargs={
            "response_format": {"type": "text"},
            "extra_body": {"max_tokens": max_tokens, "prefer": "quality"},
        },
    )


# ── Shared helpers ────────────────────────────────────────────────────────────

async def _safe_call(llm: ChatOpenAI, messages: list, label: str) -> str:
    """Single LLM call with error handling. Returns raw content string."""
    try:
        resp = await llm.ainvoke(messages)
        content = getattr(resp, "content", "") or ""
        if isinstance(content, list):
            content = "".join(
                p.get("text", "") for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            )
        return content
    except Exception as exc:
        logger.warning("LLM call [%s] failed: %s", label, exc)
        return "{}"


def _parse_json(text: str, default: dict) -> dict:
    """Extract first JSON object from LLM output."""
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
    logger.debug("JSON parse failed for label — using default")
    return default


# ── Call 1: Weather analysis ──────────────────────────────────────────────────

_WEATHER_SYSTEM = """\
You are a hotel revenue analyst for a New Jersey hotel (corporate + leisure mix, near NYC).
Analyze the weather forecast and output ONLY valid JSON — no other text.

For each date, rate how weather affects hotel demand.

Output schema (no fences, raw JSON):
{
  "analysis": {
    "YYYY-MM-DD": {
      "impact": "positive" | "neutral" | "negative",
      "brief": "one sentence about weather impact on demand"
    }
  }
}

Rules:
- Sunny/warm weekends (Fri-Sun) = positive — NJ shore drive-to leisure market surges
- Rain/storms on weekends = negative — leisure drop-off; consider rate support
- Weekday weather rarely affects demand — corporate travelers are inelastic
- Clear warm Fridays = anticipate early leisure arrivals
"""

async def _call_weather_agent(llm: ChatOpenAI, weather: list) -> dict:
    human = json.dumps({"forecast": weather}, ensure_ascii=False)
    text = await _safe_call(llm, [SystemMessage(content=_WEATHER_SYSTEM), HumanMessage(content=human)], "weather")
    return _parse_json(text, {"analysis": {}}).get("analysis", {})


# ── Call 2: Events analysis ───────────────────────────────────────────────────

_EVENTS_SYSTEM = """\
You are a hotel revenue analyst. Analyze local NJ/NYC-area events and output ONLY valid JSON.

For each event date (and 1-2 lead-in days), estimate demand impact on the hotel.

Output schema (no fences, raw JSON):
{
  "analysis": {
    "YYYY-MM-DD": {
      "event": "event name or null",
      "demand_boost_pct": 25,
      "brief": "one sentence about event impact on hotel demand"
    }
  }
}

Rules:
- Graduation weekends (Rutgers/Princeton) = +40-65% demand; families book Suites/Deluxe
- Stadium concerts (MetLife) = +25-40% for that night + 1 night before
- Conferences (Edison NJ Convention Center) = +15-25% Standard/Deluxe mid-week
- Holiday weekends (Memorial Day) = +25-40% leisure demand
- Include 1-2 lead-in days before major events (early arrivals)
- Use 0 demand_boost_pct for dates with no event influence
"""

async def _call_events_agent(llm: ChatOpenAI, events: list, today: date) -> dict:
    human = json.dumps({"events": events, "analysis_start": today.isoformat()}, ensure_ascii=False)
    text = await _safe_call(llm, [SystemMessage(content=_EVENTS_SYSTEM), HumanMessage(content=human)], "events")
    return _parse_json(text, {"analysis": {}}).get("analysis", {})


# ── Call 3: Market/news analysis ──────────────────────────────────────────────

_MARKET_SYSTEM = """\
You are a hotel revenue strategist. Analyze market news and output ONLY valid JSON.

Output schema (no fences, raw JSON):
{
  "sentiment": "bullish" | "neutral" | "bearish",
  "rate_pressure": "up" | "flat" | "down",
  "key_insight": "2-3 sentence market outlook paragraph",
  "category_outlook": {
    "ECONOMY": "brief pricing outlook",
    "STANDARD": "brief pricing outlook",
    "STUDIO": "brief pricing outlook",
    "DELUXE": "brief pricing outlook",
    "SUITE": "brief pricing outlook",
    "PREMIUM": "brief pricing outlook"
  }
}
"""

async def _call_market_agent(llm: ChatOpenAI, news: list) -> dict:
    human = json.dumps({"news_headlines": news, "market": "NJ/NYC metro hotel market"}, ensure_ascii=False)
    text = await _safe_call(llm, [SystemMessage(content=_MARKET_SYSTEM), HumanMessage(content=human)], "market")
    default = {"sentiment": "neutral", "rate_pressure": "flat", "key_insight": "", "category_outlook": {}}
    return _parse_json(text, default)


# ── Call 4: Historical trends analysis ────────────────────────────────────────

_HISTORY_SYSTEM = """\
You are a hotel revenue analyst with 2-year booking history data.
Analyze seasonal patterns for this NJ hotel and output ONLY valid JSON.

Output schema (no fences, raw JSON):
{
  "seasonal_multipliers": {
    "ECONOMY": 1.05,
    "STANDARD": 1.10,
    "STUDIO": 1.08,
    "DELUXE": 1.15,
    "SUITE": 1.25,
    "PREMIUM": 1.12
  },
  "pattern_insight": "2-3 sentences about YoY booking patterns for this period",
  "week_note": "specific insight about this week historically vs full year"
}

Context: NJ hotel in May — graduation season, shore drive-to market opening, pharma conference season.
"""

async def _call_history_agent(llm: ChatOpenAI, history: dict, today: date) -> dict:
    human = json.dumps({"period": f"Week of {today.isoformat()}", "historical_data": history}, ensure_ascii=False)
    text = await _safe_call(llm, [SystemMessage(content=_HISTORY_SYSTEM), HumanMessage(content=human)], "history")
    default = {"seasonal_multipliers": {}, "pattern_insight": "", "week_note": ""}
    return _parse_json(text, default)


# ── Call 5: Synthesis (final calendar) ───────────────────────────────────────

_SYNTHESIS_SYSTEM = """\
You are RateIQ, the Revenue Management AI for {hotel_name} (New Jersey, USA). Today: {today}.

You have received 4 factor analyses: weather, events, market news, and historical trends.
Combined with the live occupancy snapshot, generate actionable pricing entries for the next 20 days.

Output ONLY valid JSON (no markdown fences):
{{
  "summary": "2-3 sentence market summary covering key events, occupancy outlook, and priority action",
  "calendar": {{
    "STANDARD": [
      {{
        "date": "YYYY-MM-DD",
        "suggested_rate": 179,
        "change_pct": 20.1,
        "action": "INCREASE",
        "confidence": "HIGH",
        "reason": "15-30 word market-aware reason referencing specific NJ demand driver",
        "weather_factor": "brief sentence",
        "event_factor": "brief sentence or empty string",
        "news_factor": "brief sentence"
      }}
    ],
    "DELUXE": [...],
    "SUITE": [...],
    "ECONOMY": [...],
    "STUDIO": [...],
    "PREMIUM": [...]
  }}
}}

Hard rules:
- ONLY include entries where action is INCREASE or DISCOUNT — omit MAINTAIN dates entirely
- INCREASE when: occ > 70% OR strong event signal (graduation, concert, holiday weekend)
- DISCOUNT when: occ < 50% AND no major event AND lead_days > 2
- suggested_rate MUST be >= floor_rate; rounded to nearest $5
- action: "INCREASE" if change_pct > 2, "DISCOUNT" if change_pct < -2
- Confidence: HIGH if occ >85% or <30%, MEDIUM if 70-85% or 30-50%, LOW otherwise
- reason: MUST reference NJ-specific context (event name, day-of-week, market trend) — 15-30 words
- Skip categories with 0 total rooms
- Keep each factor field under 15 words
- Output ONLY the JSON object — no text before or after
"""

async def _call_synthesis_agent(
    llm: ChatOpenAI,
    snapshot: dict,
    today: date,
    weather_analysis: dict,
    events_analysis: dict,
    market_analysis: dict,
    history_analysis: dict,
) -> dict:
    dates_window = [(today + timedelta(days=i)).isoformat() for i in range(WINDOW_DAYS)]

    # Compact snapshot for synthesis context (only categories that exist)
    compact_snapshot = {
        cat: {
            d: {
                "occ_pct": b.get("occ_pct"),
                "otb": b.get("otb"),
                "total": b.get("total"),
                "avg_rate": b.get("avg_rate"),
                "floor_rate": b.get("floor_rate"),
                "base_rate": b.get("base_rate"),
            }
            for d, b in list(dates_data.items())[:WINDOW_DAYS]
        }
        for cat, dates_data in snapshot.items()
        if snapshot.get(cat)
    }

    context = json.dumps({
        "dates_window": dates_window,
        "occupancy_snapshot": compact_snapshot,
        "weather_impact": weather_analysis,
        "events_impact": events_analysis,
        "market_outlook": market_analysis,
        "historical_multipliers": history_analysis.get("seasonal_multipliers", {}),
        "historical_note": history_analysis.get("week_note", ""),
    }, ensure_ascii=False)

    system = _SYNTHESIS_SYSTEM.format(
        hotel_name=settings.HOTEL_NAME,
        today=today.isoformat(),
    )

    text = await _safe_call(
        llm,
        [SystemMessage(content=system), HumanMessage(content=context)],
        "synthesis",
    )
    return _parse_json(text, {"summary": "Analysis complete.", "calendar": {}})


# ── Persist to DB ─────────────────────────────────────────────────────────────

async def _persist_recs(
    result: dict,
    snapshot: dict,
    session_factory: async_sessionmaker,
) -> None:
    """Upsert AI calendar recommendations to pricing_recs table."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from core.models.pricing_recommendation import PricingRec

    calendar = result.get("calendar", {})
    if not calendar:
        return

    rows = []
    for cat, cells in calendar.items():
        if not isinstance(cells, list):
            continue
        snap_cat = snapshot.get(cat.upper(), {})
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            d_str = cell.get("date", "")
            if not d_str:
                continue
            snap_day = snap_cat.get(d_str, {})
            rows.append({
                "id": f"{cat.upper()}_{d_str}",
                "category": cat.upper(),
                "date": d_str,
                "recommended_action": cell.get("action", "MAINTAIN"),
                "current_rate": float(snap_day.get("avg_rate", 0.0)),
                "recommended_rate": float(cell.get("suggested_rate", snap_day.get("avg_rate", 0.0))),
                "change_pct": float(cell.get("change_pct", 0.0)),
                "confidence": cell.get("confidence", "MEDIUM"),
                "reasoning": cell.get("reason", ""),
                "weather_factor": cell.get("weather_factor", "") or "",
                "event_factor": cell.get("event_factor", "") or "",
                "news_factor": cell.get("news_factor", ""),
                "is_orphan": False,
                "occupancy_pct": float(snap_day.get("occ_pct", 0.0)),
                "otb": int(snap_day.get("otb", 0)),
                "floor_rate": float(snap_day.get("floor_rate", 0.0)),
                "computed_at": __import__("datetime").datetime.utcnow(),
            })

    if not rows:
        return

    try:
        async with session_factory() as db:
            for row in rows:
                stmt = (
                    pg_insert(PricingRec)
                    .values(**row)
                    .on_conflict_do_update(
                        index_elements=["id"],
                        set_={k: v for k, v in row.items() if k != "id"},
                    )
                )
                await db.execute(stmt)
            await db.commit()
        logger.info("Persisted %d pricing recs to DB", len(rows))
    except Exception as exc:
        logger.warning("Could not persist pricing recs: %s", exc)


# ── Public entry point ────────────────────────────────────────────────────────

async def run_pricing_agent(
    snapshot: dict,
    context_text: str,  # noqa: ARG001 — kept for API compat; multi-call strategy builds its own
    today: date,
    session_factory: async_sessionmaker,
) -> dict:
    """
    Run multi-call pricing analysis. Returns:
      { "summary": str, "calendar": { category: [cells] } }

    Phase 1 — 4 parallel focused LLM calls (weather, events, market, history)
    Phase 2 — 1 synthesis call combining all signals + live occupancy
    Phase 3 — persist to pricing_recs table
    """
    llm = _make_llm()

    # Gather mock external data
    weather = get_weather_forecast(today, WINDOW_DAYS)
    events = get_events_for_window(today, WINDOW_DAYS)
    news = get_market_news()
    history = get_historical_trends()

    llm_synthesis = _make_llm(max_tokens=10000)

    # Phase 1a: weather + events (larger output — run together first)
    try:
        weather_analysis, events_analysis = await asyncio.wait_for(
            asyncio.gather(
                _call_weather_agent(llm, weather),
                _call_events_agent(llm, events, today),
            ),
            timeout=240,
        )
    except asyncio.TimeoutError:
        logger.warning("Weather/events calls timed out — using defaults")
        weather_analysis, events_analysis = {}, {}

    # Phase 1b: market + history (compact output — run after Phase 1a)
    try:
        market_analysis, history_analysis = await asyncio.wait_for(
            asyncio.gather(
                _call_market_agent(llm, news),
                _call_history_agent(llm, history, today),
            ),
            timeout=180,
        )
    except asyncio.TimeoutError:
        logger.warning("Market/history calls timed out — using defaults")
        market_analysis, history_analysis = {}, {}

    # Phase 2: synthesis — combines all 4 factor analyses + live occupancy
    try:
        result = await asyncio.wait_for(
            _call_synthesis_agent(
                llm_synthesis, snapshot, today,
                weather_analysis, events_analysis, market_analysis, history_analysis,
            ),
            timeout=300,
        )
    except asyncio.TimeoutError:
        logger.error("Synthesis call timed out")
        result = {"summary": "Analysis timed out — try again.", "calendar": {}}

    # Phase 3: persist
    await _persist_recs(result, snapshot, session_factory)

    return result
