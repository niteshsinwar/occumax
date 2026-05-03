"""
Pricing AI Agent — Multi-call strategy with Poly AI

Strategy:
  Phase 1 (parallel): 4 focused factor calls — weather, events, market, historical
  Phase 2 (12 parallel): 3 categories × 4 date-windows of 5 days each = 12 micro-synthesis calls
    Each call covers 1 category + 5 specific days — output fits in Poly AI's 400-token cap
  Phase 3: merge 12 results, derive reasons from factor data, persist to pricing_recs

Categories priced: ECONOMY, STANDARD, STUDIO  (extend SYNTHESIS_CATEGORIES to add more)
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
SYNTHESIS_CATEGORIES = ["ECONOMY", "STANDARD", "STUDIO"]  # categories priced by AI
WINDOW_SIZE = 5   # days per micro-synthesis shard


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


# ── Call 5: Synthesis (micro-shards, 1 category each) ────────────────────────
#
# Each shard covers exactly 1 category across all 20 days.
# Output schema is ultra-compact (no reason/factor text) to stay under the
# Poly AI 400-token completion cap. Reasons are derived from factor analyses
# in Python after all shards complete.

_SHARD_SYSTEM = """\
You are a hotel revenue manager for {hotel_name} (New Jersey, USA). Today: {today}.
Price {category} rooms for the next 20 days using the occupancy data and demand signals provided.

Output ONLY a raw JSON array — no fences, no extra text:
[{{"date":"YYYY-MM-DD","rate":149,"action":"INCREASE","conf":"HIGH"}}, ...]

Rules:
- action: INCREASE or DISCOUNT only — omit dates where rate should hold flat
- INCREASE when: event day/lead-in OR weekend (Fri/Sat/Sun) OR occ >= 55%
- DISCOUNT when: occ < 40% AND weekday AND no event signal
- rate: integer, must be >= floor_rate, rounded to nearest $5
- INCREASE: rate >= base_rate * 1.05; DISCOUNT: rate <= base_rate * 0.95
- conf: HIGH (occ>80% or <25% or named event), MEDIUM (occ 55-80% or 25-40%), LOW otherwise
- Aim for 12-16 actionable dates out of 20
- Output ONLY the JSON array
"""

_SUMMARY_SYSTEM = """\
You are RateIQ, the Revenue Management AI for {hotel_name} (NJ, USA). Today: {today}.
Given the market signals below, write a 2-3 sentence revenue outlook summary.
Mention specific upcoming events (concert, graduation, holiday), current demand trend, and one priority action.
Output ONLY the summary text — no JSON, no headings.
"""


def _derive_reason(
    date_str: str,
    cat: str,
    events_analysis: dict,
    weather_analysis: dict,
    market_analysis: dict,
    snap_day: dict,
) -> tuple[str, str, str, str]:
    """Return (reason, weather_factor, event_factor, news_factor) from factor data."""
    ev = events_analysis.get(date_str, {})
    wx = weather_analysis.get(date_str, {})
    occ = snap_day.get("occ_pct", 50)

    event_factor = ev.get("brief", "") or ""
    weather_factor = wx.get("brief", "") or ""
    news_factor = market_analysis.get("key_insight", "")[:80] if market_analysis.get("key_insight") else ""

    # Build reason from strongest signal
    if ev.get("demand_boost_pct", 0) > 0 and ev.get("event"):
        reason = f"{ev['event']} drives {cat} demand — {event_factor[:60]}" if event_factor else f"{ev['event']} boosts NJ hotel demand; rate increase warranted."
    elif wx.get("impact") == "positive" and weather_factor:
        reason = f"Favorable NJ weekend weather — {weather_factor[:80]}"
    elif wx.get("impact") == "negative" and weather_factor:
        reason = f"Adverse weather dampens leisure demand — {weather_factor[:80]}"
    elif occ >= 70:
        reason = f"{cat} occupancy at {occ:.0f}% — strong on-books demand supports rate increase."
    elif occ < 35:
        reason = f"{cat} occupancy at {occ:.0f}% — rate support needed to drive advance bookings."
    else:
        insight = market_analysis.get("key_insight", "")
        reason = (insight[:120] + " — rate adjustment warranted.") if insight else f"Day-of-week demand pattern for {cat} warrants pricing action."

    return reason[:200], weather_factor[:80], event_factor[:80], news_factor[:80]


async def _synthesis_shard(
    llm: ChatOpenAI,
    category: str,
    dates_window: list[str],
    snap_cat: dict,
    weather_analysis: dict,
    events_analysis: dict,
    market_analysis: dict,
    history_analysis: dict,
    today: date,
) -> tuple[str, list]:
    """Price one category across all 20 days. Returns (category, cells_list)."""
    if not snap_cat:
        return category, []

    # Build compact per-day context for this category
    day_rows = []
    for d in dates_window:
        b = snap_cat.get(d, {})
        ev = events_analysis.get(d, {})
        wx = weather_analysis.get(d, {})
        day_rows.append({
            "date": d,
            "occ_pct": b.get("occ_pct", 0),
            "otb": b.get("otb", 0),
            "total": b.get("total", 0),
            "avg_rate": b.get("avg_rate", 0),
            "floor_rate": b.get("floor_rate", 0),
            "base_rate": b.get("base_rate", 0),
            "event": ev.get("event") or None,
            "event_boost": ev.get("demand_boost_pct", 0),
            "weather": wx.get("impact", "neutral"),
            "is_weekend": date.fromisoformat(d).weekday() >= 4,
        })

    context = json.dumps({
        "days": day_rows,
        "seasonal_multiplier": history_analysis.get("seasonal_multipliers", {}).get(category, 1.0),
        "market_rate_pressure": market_analysis.get("rate_pressure", "flat"),
    }, ensure_ascii=False)

    system = _SHARD_SYSTEM.format(
        hotel_name=settings.HOTEL_NAME,
        today=today.isoformat(),
        category=category,
    )

    text = await _safe_call(
        llm,
        [SystemMessage(content=system), HumanMessage(content=context)],
        f"synthesis[{category}]",
    )

    # Parse compact array output
    raw = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    arr_match = re.search(r"\[[\s\S]*\]", raw)
    if arr_match:
        try:
            cells = json.loads(arr_match.group(0))
            if isinstance(cells, list):
                return category, cells
        except json.JSONDecodeError:
            pass
    logger.debug("Shard parse failed for %s", category)
    return category, []


async def _call_summary_agent(
    llm: ChatOpenAI,
    events_analysis: dict,
    weather_analysis: dict,
    market_analysis: dict,
    today: date,
) -> str:
    """Single call to produce the 2-3 sentence market summary."""
    top_events = [
        f"{v['event']} on {d} (boost +{v.get('demand_boost_pct', 0)}%)"
        for d, v in sorted(events_analysis.items())
        if v.get("event") and v.get("demand_boost_pct", 0) > 0
    ][:4]
    top_weather = [
        f"{d}: {v.get('brief', '')}"
        for d, v in sorted(weather_analysis.items())
        if v.get("impact") in ("positive", "negative")
    ][:4]
    context = json.dumps({
        "top_events": top_events,
        "notable_weather": top_weather,
        "market_sentiment": market_analysis.get("sentiment", "neutral"),
        "rate_pressure": market_analysis.get("rate_pressure", "flat"),
        "market_insight": market_analysis.get("key_insight", ""),
    }, ensure_ascii=False)
    system = _SUMMARY_SYSTEM.format(hotel_name=settings.HOTEL_NAME, today=today.isoformat())
    text = await _safe_call(llm, [SystemMessage(content=system), HumanMessage(content=context)], "summary")
    return (text or "").strip() or "Analysis complete."


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

    # 1 shard per category (ECONOMY, STANDARD, STUDIO) + 1 summary call — all parallel
    shard_args = dict(
        dates_window=dates_window,
        weather_analysis=weather_analysis,
        events_analysis=events_analysis,
        market_analysis=market_analysis,
        history_analysis=history_analysis,
        today=today,
    )

    tasks = [
        _synthesis_shard(llm, cat, snap_cat=compact_snapshot.get(cat, {}), **shard_args)
        for cat in SYNTHESIS_CATEGORIES
        if compact_snapshot.get(cat)
    ]
    tasks.append(_call_summary_agent(llm, events_analysis, weather_analysis, market_analysis, today))  # type: ignore[arg-type]

    results = await asyncio.gather(*tasks)

    # Last result is the summary string
    summary_result = results[-1]
    summary = summary_result if isinstance(summary_result, str) else "Analysis complete."

    # Build calendar — expand compact cells and attach derived reasons
    merged_calendar: dict = {}
    for cat_result in results[:-1]:
        if not isinstance(cat_result, tuple):
            continue
        cat, cells = cat_result
        snap_cat = compact_snapshot.get(cat, {})
        expanded = []
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            d = cell.get("date", "")
            if not d:
                continue
            snap_day = snap_cat.get(d, {})
            avg_rate = snap_day.get("avg_rate", 0.0)
            suggested = float(cell.get("rate", avg_rate))
            action_raw = cell.get("action", "").upper()
            conf_raw = cell.get("conf", "MEDIUM").upper()

            # Expand abbreviated confidence
            conf_map = {"H": "HIGH", "M": "MEDIUM", "L": "LOW", "HIGH": "HIGH", "MEDIUM": "MEDIUM", "LOW": "LOW"}
            confidence = conf_map.get(conf_raw, "MEDIUM")

            reason, weather_factor, event_factor, news_factor = _derive_reason(
                d, cat, events_analysis, weather_analysis, market_analysis, snap_day
            )

            expanded.append({
                "date": d,
                "suggested_rate": suggested,
                "change_pct": round((suggested - avg_rate) / avg_rate * 100, 1) if avg_rate else 0.0,
                "action": action_raw if action_raw in ("INCREASE", "DISCOUNT") else "MAINTAIN",
                "confidence": confidence,
                "reason": reason,
                "weather_factor": weather_factor,
                "event_factor": event_factor,
                "news_factor": news_factor,
            })
        if expanded:
            merged_calendar[cat] = expanded

    return {"summary": summary, "calendar": merged_calendar}


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

    # Phase 1a: weather + events (parallel)
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

    # Phase 1b: market + history (parallel)
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

    # Phase 2: 1 micro-shard per category + 1 summary — all parallel
    # Each shard covers 1 category × 20 days with compact output (fits Poly AI 400-token cap)
    try:
        result = await asyncio.wait_for(
            _call_synthesis_agent(
                llm, snapshot, today,
                weather_analysis, events_analysis, market_analysis, history_analysis,
            ),
            timeout=300,
        )
    except asyncio.TimeoutError:
        logger.error("Synthesis shards timed out")
        result = {"summary": "Analysis timed out — try again.", "calendar": {}}

    # Phase 3: persist
    await _persist_recs(result, snapshot, session_factory)

    return result
