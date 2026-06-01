from __future__ import annotations
from typing import Optional
"""
Pricing AI Agent — Multi-call strategy with Poly AI

Strategy:
  Phase 1: build factor context from frontend context feed or legacy mock sources.
  Phase 2: one parallel synthesis call per active category with unsold inventory.
  Phase 3: merge results, derive reasons from factor data, persist to pricing_recs.
"""


import asyncio
import copy
import hashlib
import json
import logging
import re
import time
import uuid
from datetime import date, timedelta

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from sqlalchemy.ext.asyncio import async_sessionmaker

from config import settings
from services.ai.pricing_mock_data import get_historical_trends

logger = logging.getLogger(__name__)

WINDOW_DAYS = 20
CATEGORIES = ["ECONOMY", "STANDARD", "DELUXE", "SUITE"]
SYNTHESIS_CATEGORIES = CATEGORIES  # categories priced by AI when present in the live snapshot
WINDOW_SIZE = 5   # days per micro-synthesis shard
_CACHE_TTL_SECONDS = 15 * 60
_RUN_CACHE: dict[str, tuple[float, dict]] = {}


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


def _stable_hash(payload: object) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _composite_score(item: dict) -> int:
    factors = item.get("factors") or []
    weight_sum = 0.0
    score_sum = 0.0
    for factor in factors:
        if not isinstance(factor, dict):
            continue
        weight = max(0.0, min(1.0, float(factor.get("weight") or 0.0)))
        score = max(0.0, min(100.0, float(factor.get("score") or 0.0)))
        weight_sum += weight
        score_sum += score * weight
    return round(score_sum / weight_sum) if weight_sum > 0 else 0


def _context_payload(context_items: Optional[list[dict]], today: date) -> tuple[str, dict[str, list[dict]]]:
    fragments: list[str] = []
    date_signals: dict[str, list[dict]] = {}

    for item in context_items or []:
        if not isinstance(item, dict):
            continue

        title = str(item.get("title") or "").strip()
        detail = str(item.get("detail") or "").strip()
        kind = str(item.get("kind") or "").strip()
        severity = str(item.get("severity") or "").strip()
        segment = str(item.get("demand_segment") or "").strip()
        score = _composite_score(item)

        factors = []
        for factor in item.get("factors") or []:
            if not isinstance(factor, dict):
                continue
            label = str(factor.get("label") or "").strip()
            value = str(factor.get("value") or "").strip()
            if label or value:
                factors.append(f"{label}: {value}".strip(": "))

        if title or detail or factors:
            fragments.append(
                " - ".join(part for part in [title, detail, "; ".join(factors)] if part)
            )

        start_offset = int(item.get("impact_start_offset_days") or 0)
        end_offset = int(item.get("impact_end_offset_days") if item.get("impact_end_offset_days") is not None else start_offset)
        start_offset = max(0, min(60, start_offset))
        end_offset = max(start_offset, min(60, end_offset))
        signal = {
            "kind": kind,
            "severity": severity,
            "title": title,
            "score": score,
            "segment": segment,
        }
        for delta in range(start_offset, end_offset + 1):
            d = (today + timedelta(days=delta)).isoformat()
            date_signals.setdefault(d, []).append(signal)

    return " | ".join(fragments)[:1200], date_signals


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
    "SUITE": "brief pricing outlook"
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
    "SUITE": 1.25
  },
  "pattern_insight": "2-3 sentences about YoY booking patterns for this period",
  "week_note": "specific insight about this week historically vs full year"
}

Context: NJ hotel in June — graduation season, shore drive-to market opening, pharma conference season.
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
Price {category} rooms ONLY on the dates given in the input JSON ("days" array). These dates already reflect nights with unsold inventory — do not add extra dates.

Output ONLY a raw JSON array — no fences, no extra text:
[{{"date":"YYYY-MM-DD","rate":149,"action":"INCREASE","conf":"HIGH"}}, ...]

Rules:
- Output one entry per input date unless holding flat is optimal — then omit that date.
- action: INCREASE or DISCOUNT only (omit dates where BAR should hold unchanged).
- INCREASE when: weekend pickup strength OR category occ_pct suggests compression OR demand signals warrant uplift.
- DISCOUNT when: weak pickup AND discretionary/unsold inventory should clear faster — prioritize realistic BAR reductions vs OTB/floor.
- Use each day's signals/context_score plus market_insight as supplied external context. Do not invent events, weather, travel shocks, or market news.
- rate: integer, must be >= floor_rate from payload, rounded to nearest $5
- conf: HIGH / MEDIUM / LOW based on confidence given occupancy totals vs OTB in payload.
- Keep JSON compact — fewer dates analyzed means shorter arrays are acceptable.
- Output ONLY the JSON array
"""

_SUMMARY_SYSTEM = """\
You are RateIQ, the Revenue Management AI for {hotel_name} (NJ, USA). Today: {today}.
Given the market signals below, write a 2-3 sentence revenue outlook summary.
Mention specific upcoming events (concert, graduation, holiday), current demand trend, and one priority action.
Output ONLY the summary text — no JSON, no headings.
"""

_SUMMARY_SYSTEM_CONTEXT = """\
You are RateIQ, the Revenue Management AI for {hotel_name} (NJ, USA). Today: {today}.
You MUST use ONLY the provided context feed bundle as external signals. Do NOT invent events, concerts, holidays, or news.
Write a 2-3 sentence revenue outlook summary based on:
- the provided context feed signals (event/weather/travel/market)
- the live occupancy snapshot trends implied by the request context
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
    date_signals = market_analysis.get("date_signals", {}).get(date_str, [])

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
    elif date_signals:
        titles = ", ".join(str(s.get("title") or "") for s in date_signals[:2] if s.get("title"))
        reason = f"{cat} date-aware demand signal: {titles} — rate adjustment warranted."
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
        day_signals = market_analysis.get("date_signals", {}).get(d, [])
        remaining = int(b.get("total", 0) or 0) - int(b.get("otb", 0) or 0)
        day_rows.append({
            "date": d,
            "occ_pct": b.get("occ_pct", 0),
            "otb": b.get("otb", 0),
            "total": b.get("total", 0),
            "remaining_inventory": max(0, remaining),
            "avg_rate": b.get("avg_rate", 0),
            "floor_rate": b.get("floor_rate", 0),
            "base_rate": b.get("base_rate", 0),
            "event": ev.get("event") or None,
            "event_boost": ev.get("demand_boost_pct", 0),
            "weather": wx.get("impact", "neutral"),
            "signals": day_signals[:4],
            "context_score": max([int(s.get("score") or 0) for s in day_signals] or [0]),
            "is_weekend": date.fromisoformat(d).weekday() >= 4,
        })

    context = json.dumps({
        "days": day_rows,
        "seasonal_multiplier": history_analysis.get("seasonal_multipliers", {}).get(category, 1.0),
        "market_rate_pressure": market_analysis.get("rate_pressure", "flat"),
        "market_insight": market_analysis.get("key_insight", "")[:1200],
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


def _dates_with_unsold_inventory(snapshot: dict, cat: str, dates_window: list[str]) -> list[str]:
    """Dates in window where category aggregate snapshot shows unsold rooms (total > OTB)."""
    snap_cat = snapshot.get(cat, {})
    out: list[str] = []
    for d in dates_window:
        b = snap_cat.get(d, {})
        total = int(b.get("total", 0) or 0)
        otb = int(b.get("otb", 0) or 0)
        if total > otb:
            out.append(d)
    return out


def _eligible_synthesis_categories(
    snapshot: dict,
    today: date,
    analysis_window_days: int,
    empty_nights_only: bool,
) -> list[str]:
    dates_window = [(today + timedelta(days=i)).isoformat() for i in range(analysis_window_days)]
    out: list[str] = []
    for cat in SYNTHESIS_CATEGORIES:
        snap_cat = snapshot.get(cat)
        if not snap_cat:
            continue
        if empty_nights_only and not _dates_with_unsold_inventory(snapshot, cat, dates_window):
            continue
        out.append(cat)
    return out


async def _call_summary_agent_from_context(
    llm: ChatOpenAI,
    context_items: list[dict],
    today: date,
) -> str:
    """Single call to produce a short summary from the provided context feed bundle."""
    context = json.dumps(
        {
            "context_feed": [
                {
                    "kind": i.get("kind"),
                    "severity": i.get("severity"),
                    "title": i.get("title"),
                    "detail": i.get("detail"),
                    "factors": i.get("factors", []),
                }
                for i in (context_items or [])
            ]
        },
        ensure_ascii=False,
    )
    system = _SUMMARY_SYSTEM_CONTEXT.format(hotel_name=settings.HOTEL_NAME, today=today.isoformat())
    text = await _safe_call(llm, [SystemMessage(content=system), HumanMessage(content=context)], "summary_context")
    return (text or "").strip() or "Analysis complete."

async def _call_synthesis_agent(
    llm: ChatOpenAI,
    snapshot: dict,
    today: date,
    weather_analysis: dict,
    events_analysis: dict,
    market_analysis: dict,
    history_analysis: dict,
    context_items: Optional[list[dict]] = None,
    analysis_window_days: int = WINDOW_DAYS,
    empty_nights_only: bool = False,
) -> dict:
    dates_window_full = [(today + timedelta(days=i)).isoformat() for i in range(analysis_window_days)]

    compact_snapshot: dict[str, dict] = {}
    for cat, dates_data in snapshot.items():
        if not dates_data:
            continue
        compact_snapshot[cat] = {}
        for d in dates_window_full:
            b = dates_data.get(d)
            if not b:
                continue
            compact_snapshot[cat][d] = {
                "occ_pct": b.get("occ_pct"),
                "otb": b.get("otb"),
                "total": b.get("total"),
                "avg_rate": b.get("avg_rate"),
                "floor_rate": b.get("floor_rate"),
                "base_rate": b.get("base_rate"),
            }

    shard_args_base = dict(
        weather_analysis=weather_analysis,
        events_analysis=events_analysis,
        market_analysis=market_analysis,
        history_analysis=history_analysis,
        today=today,
    )

    tasks = []
    for cat in SYNTHESIS_CATEGORIES:
        snap_c = compact_snapshot.get(cat)
        if not snap_c:
            continue
        dates_for_shard = (
            _dates_with_unsold_inventory(snapshot, cat, dates_window_full)
            if empty_nights_only
            else dates_window_full
        )
        if not dates_for_shard:
            continue
        tasks.append(
            _synthesis_shard(
                llm,
                cat,
                dates_window=dates_for_shard,
                snap_cat=snap_c,
                **shard_args_base,
            )
        )
    if context_items:
        tasks.append(_call_summary_agent_from_context(llm, context_items, today))  # type: ignore[arg-type]
    else:
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
            try:
                rec_date = date.fromisoformat(str(d_str))
            except ValueError:
                logger.warning("Skipping pricing rec with invalid date: %s", d_str)
                continue
            snap_day = snap_cat.get(d_str, {})
            rows.append({
                "id": f"{cat.upper()}_{d_str}",
                "category": cat.upper(),
                "date": rec_date,
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
    context_items: Optional[list[dict]] = None,
    analysis_window_days: int = WINDOW_DAYS,
    empty_nights_only: bool = False,
) -> dict:
    """
    Run multi-call pricing analysis. Returns:
      { "summary": str, "calendar": { category: [cells] } }

    Phase 1 — 4 parallel focused LLM calls (weather, events, market, history)
    Phase 2 — 1 synthesis call combining all signals + live occupancy
    Phase 3 — persist to pricing_recs table
    """
    run_id = uuid.uuid4().hex
    context_hash = _stable_hash(context_items or [])
    cache_key = _stable_hash({
        "snapshot": snapshot,
        "context_hash": context_hash,
        "today": today.isoformat(),
        "analysis_window_days": analysis_window_days,
        "empty_nights_only": empty_nights_only,
    })
    now = time.time()
    cached = _RUN_CACHE.get(cache_key)
    if cached and now - cached[0] <= _CACHE_TTL_SECONDS:
        result = copy.deepcopy(cached[1])
        result["_meta"] = {
            **result.get("_meta", {}),
            "cache_hit": True,
            "cache_key": cache_key,
        }
        return result

    for key, (created_at, _) in list(_RUN_CACHE.items()):
        if now - created_at > _CACHE_TTL_SECONDS:
            _RUN_CACHE.pop(key, None)

    llm = _make_llm()

    # Historical trends remain internal/demo; external context should come from provided context_items.
    history = get_historical_trends()

    if context_items:
        # When context is provided from the frontend, do NOT use backend mock external data.
        weather_analysis, events_analysis = {}, {}
        context_insight, date_signals = _context_payload(context_items, today)
        market_analysis = {
            "sentiment": "neutral",
            "rate_pressure": "flat",
            "key_insight": context_insight,
            "date_signals": date_signals,
            "category_outlook": {},
        }
    else:
        # Legacy path (uses backend mock external data)
        from services.ai.pricing_mock_data import (  # local import to avoid forcing mocks when context provided
            get_events_for_window,
            get_market_news,
            get_weather_forecast,
        )

        weather = get_weather_forecast(today, analysis_window_days)
        events = get_events_for_window(today, analysis_window_days)
        news = get_market_news()

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

        # Phase 1b: market (LLM) — only in legacy path
        try:
            market_analysis = await asyncio.wait_for(_call_market_agent(llm, news), timeout=180)
        except asyncio.TimeoutError:
            logger.warning("Market call timed out — using defaults")
            market_analysis = {}

    try:
        history_analysis = await asyncio.wait_for(_call_history_agent(llm, history, today), timeout=180)
    except asyncio.TimeoutError:
        logger.warning("History call timed out — using defaults")
        history_analysis = {}

    synthesis_categories = _eligible_synthesis_categories(
        snapshot,
        today,
        analysis_window_days,
        empty_nights_only,
    )
    base_llm_call_count = 1 if context_items else 4  # history, plus legacy weather/events/market when used
    expected_llm_call_count = base_llm_call_count + len(synthesis_categories) + 1  # + summary

    # Phase 2: 1 micro-shard per category + 1 summary — all parallel
    # Each shard covers 1 category × 20 days with compact output (fits Poly AI 400-token cap)
    try:
        result = await asyncio.wait_for(
            _call_synthesis_agent(
                llm, snapshot, today,
                weather_analysis, events_analysis, market_analysis, history_analysis,
                context_items=context_items,
                analysis_window_days=analysis_window_days,
                empty_nights_only=empty_nights_only,
            ),
            timeout=300,
        )
    except asyncio.TimeoutError:
        logger.error("Synthesis shards timed out")
        result = {"summary": "Analysis timed out — try again.", "calendar": {}}

    # Phase 3: persist
    await _persist_recs(result, snapshot, session_factory)

    result["_meta"] = {
        "run_id": run_id,
        "cache_hit": False,
        "cache_key": cache_key,
        "context_hash": context_hash,
        "context_item_count": len(context_items or []),
        "llm_call_count": expected_llm_call_count,
        "synthesis_categories": synthesis_categories,
    }
    _RUN_CACHE[cache_key] = (time.time(), copy.deepcopy(result))

    return result
