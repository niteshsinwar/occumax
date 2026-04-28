"""
Pricing AI Agent — LangGraph + Gemini 2.5 Flash

Single-shot agent (no conversation history):
  1. Manager calls GET /manager/pricing/analyse
  2. Agent receives occupancy snapshot + Tier-1 context text
  3. Agent calls tools to gather detail, then returns structured recommendations
  4. Controller converts results into PricingRecommendation list

Tools:
  get_pricing_context(category, start_date, end_date)   — per-date detail for a range
  get_empty_windows(category)                            — consecutive empty runs ≥2 nights
  get_pickup_pace(category, days_back)                   — bookings made in last N days

Output format (from AI final message):
  JSON array of recommendation objects embedded in a fenced code block or raw JSON.
"""

# NOTE: intentionally no `from __future__ import annotations` — LangGraph
# resolves TypedDict annotations at runtime and needs them in global scope.

import asyncio
import json
import logging
import operator
from datetime import date, timedelta
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from config import settings
from core.models import Room, Booking

logger = logging.getLogger(__name__)


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are the Revenue Management AI (RateIQ) for {hotel_name}, a hotel in New Jersey, USA.
Today is {today}.

Your job: analyse hotel occupancy data and produce intelligent, market-aware
pricing recommendations for Standard, Deluxe, and Suite categories.

Occupancy Tier-1 snapshot (next 14 days — Standard, Deluxe, Suite):
{context}

── New Jersey Hotel Market Context ───────────────────────────────────────────
Use this context to make reason fields specific and insightful — not generic.

Demand drivers:
  • Weekdays (Mon–Thu): Corporate travelers — pharma (J&J, Novartis, Sanofi in
    Titusville/East Hanover), finance (Goldman/Morgan Stanley NJ offices), and
    tech (AT&T, Cognizant campuses). Business demand is rate-inelastic. Hold firm.
  • Weekends (Fri–Sun): Drive-to leisure from NYC, Philadelphia, and Long Island.
    Price-sensitive. Packages (parking, breakfast) outperform flat discounts.
  • Peak seasons:
    May–Jun: Graduation season (Princeton, Rutgers, Seton Hall, Montclair State)
              — Suites and Deluxe fill weeks in advance; hold rates firm.
    Jun–Aug: Shore drive market (Asbury Park, Long Beach Island, Cape May).
              Weekend leisure peaks; weekday corporate continues.
    Sep–Nov: Fall foliage, NFL season (Giants/Jets at MetLife Stadium in East
              Rutherford), and conference season. Strong mixed demand.
    Dec:     Holiday corporate parties + leisure — Short Hills Mall, NYC day trips.
              Suites and Deluxe sell at a premium.
    Mar–Apr: Spring shoulder — softer leisure; corporate steady.

  • Key demand events (factor into rate reasoning when dates align):
    -- MetLife Stadium (East Rutherford): concerts and NFL games → +25–40% Deluxe/Suite
       uplift within 2 nights of event; bookings arrive 7–10 days out.
    -- Atlantic City casino conventions → mid-week Standard/Deluxe bump.
    -- NJ Convention & Expo Center (Edison): pharma summits, NJEA, trade shows
       fill Standard 3–6 weeks out.
    -- Princeton/Rutgers graduation weekends (mid-May) → 95%+ Suite occupancy.
    -- Asbury Park summer concert series (Jun–Aug weekends) → leisure spike.
    -- NYC overflow: when NYC hotel rates spike above $400/night, NJ captures
       overflow guests booking 1–3 days out — watch for late-arrival pickup surges.

OTA dynamics:
  • Expedia, Booking.com, Hotels.com, and Priceline dominate NJ OTA bookings.
  • Standard rooms face highest OTA price competition — Priceline flash deals.
  • Suites and Deluxe have fewer OTA competitors — hold rates and push direct.
  • Last-minute OTA deals (1–2 days out) drive Standard/Deluxe fill during NYC
    overflow nights.

── Pricing Rules ─────────────────────────────────────────────────────────────
Occupancy thresholds (adjust for lead time, pickup pace, and day-of-week):
  < 30%  → DISCOUNT aggressive   (–15–25%) — but check day-of-week first
  30–50% → DISCOUNT moderate     (–5–15%)
  50–70% → HOLD standard BAR
  70–85% → INCREASE moderate     (+10–20%)
  > 85%  → INCREASE aggressive   (+20–35%)

Day-of-week adjustment:
  Weekday low occ (<40%): standard discount — corporate bookings are rate-sticky
  Weekend low occ (<40%): leisure package angle, mention parking/breakfast bundle
  Weekday high occ (>80%): increase confidently — corporate guests book on company card
  Weekend high occ (>80%): increase moderately — leisure guests are elastic

Lead-time rule:
  Check-in within 3 days  → tighten discounts (urgency pricing, OTA visibility)
  Check-in 4–7 days out   → standard thresholds
  Check-in 8–14 days out  → lead-time discount if occ < 50%

Pickup-pace rule:
  If last-7-day pickup rate < expected → discount or promote
  If last-7-day pickup rate > expected → increase or hold

Floor-rate constraint (HARD): NEVER suggest a rate below floor_rate for any date.

── Tools ─────────────────────────────────────────────────────────────────────
get_pricing_context(category, start_date, end_date)
  → Per-date occupancy + rate detail for a range (up to 30 days).
  → Focus on STANDARD, DELUXE, SUITE.

get_low_occupancy_dates(category, threshold_pct=50.0)
  → Dates in next 30 days where category occupancy is below threshold_pct.
  → Includes lead_days for urgency adjustments.

get_pickup_pace(category, days_back)
  → Bookings confirmed in the last N days for this category.

── Output format ─────────────────────────────────────────────────────────────
After calling the tools you need, output a JSON object (no markdown fence) with:
  {{
    "recommendations": [
      {{
        "category": "DELUXE",
        "date": "2026-05-16",
        "current_rate": 249,
        "suggested_rate": 329,
        "change_pct": 32.1,
        "confidence": "HIGH",
        "reason": "Friday before Rutgers graduation weekend — Deluxe at 92% OTB; families book 10+ days ahead and are rate-inelastic. Capture last rooms at peak.",
        "occupancy_pct": 92.0,
        "otb": 9,
        "floor_rate": 149
      }},
      ...
    ],
    "summary": "Concise 2–3 sentence summary referencing NJ market conditions, which categories need action, and one actionable management insight."
  }}

Rules for recommendations:
  - Focus on STANDARD, DELUXE, and SUITE. Include other categories only if clearly impactful.
  - Only recommend dates where action is warranted (occ < 50% or occ > 80%).
  - Omit 50–80% dates unless pickup pace is abnormally slow.
  - Max 30 recommendations total. Focus on the most impactful.
  - All rates in USD. suggested_rate must be rounded to nearest $5.
  - change_pct = round((suggested_rate - current_rate) / current_rate * 100, 1)
  - Confidence: HIGH if occ >85% or <30%, MEDIUM if 70–85% or 30–50%, LOW otherwise.
  - reason field: MUST be 15–30 words, market-aware, specific to the date/day-of-week
    and NJ demand context. Reference events (MetLife, graduation, shore season, NYC overflow)
    when relevant. NEVER write just "X% occupancy, aggressive discount."
  - summary: Reference NJ conditions — events, seasons, channel pressure. Mention the
    highest-priority action and any event-driven opportunity.

Output ONLY the JSON object. No explanation text before or after.
"""


# ── Tools ─────────────────────────────────────────────────────────────────────

def _make_tools(snapshot: dict, session_factory: async_sessionmaker, today: date):
    """Create tool callables bound to the current request's data."""

    @tool
    async def get_pricing_context(category: str, start_date: str, end_date: str) -> str:
        """
        Return per-date occupancy and rate data for a category between start_date
        and end_date (inclusive, ISO format YYYY-MM-DD). Max 30 days.
        """
        try:
            ci = date.fromisoformat(start_date)
            co = date.fromisoformat(end_date)
        except ValueError:
            return json.dumps({"error": "Invalid date format. Use YYYY-MM-DD."})

        days = min((co - ci).days + 1, 30)
        cat_data = snapshot.get(category.upper(), {})
        result = []
        for delta in range(days):
            d = (ci + timedelta(days=delta)).isoformat()
            b = cat_data.get(d)
            if b:
                result.append({"date": d, **b})
            else:
                result.append({"date": d, "occ_pct": 0, "otb": 0, "total": 0,
                                "avg_rate": 0, "floor_rate": 0, "base_rate": 0})
        return json.dumps({"category": category.upper(), "data": result})

    @tool
    async def get_low_occupancy_dates(category: str, threshold_pct: float = 50.0) -> str:
        """
        Return dates in the next 30 days where CATEGORY-LEVEL occupancy is below
        threshold_pct (default 50%). Uses aggregate booked/total counts per date —
        completely independent of which specific room holds each booking.

        Use this to identify discount candidates. Do NOT use per-room slot patterns
        for pricing decisions — room-level arrangement is managed by the yield
        optimiser and should not influence rates.
        """
        cat_data = snapshot.get(category.upper(), {})
        low_dates = []
        for delta in range(30):
            d = (today + timedelta(days=delta)).isoformat()
            b = cat_data.get(d, {})
            occ = b.get("occ_pct", 0.0)
            if occ < threshold_pct:
                low_dates.append({
                    "date":      d,
                    "occ_pct":   occ,
                    "otb":       b.get("otb", 0),
                    "total":     b.get("total", 0),
                    "avg_rate":  b.get("avg_rate", 0),
                    "floor_rate": b.get("floor_rate", 0),
                    "lead_days": delta,     # days from today — useful for urgency pricing
                })
        return json.dumps({
            "category":       category.upper(),
            "threshold_pct":  threshold_pct,
            "low_dates_count": len(low_dates),
            "dates":          low_dates,
        })

    @tool
    async def get_pickup_pace(category: str, days_back: int = 7) -> str:
        """
        Return number of bookings confirmed in the last N days for this category.
        Use to judge whether demand is building or stalling.
        """
        cutoff = today - timedelta(days=max(1, min(days_back, 30)))
        try:
            async with session_factory() as db:
                res = await db.execute(
                    select(Booking.id, Booking.check_in, Booking.created_at)
                    .join(Room, Booking.assigned_room_id == Room.id)
                    .where(
                        Room.category == category.upper(),
                        Booking.created_at >= cutoff,
                    )
                )
                rows = res.all()
        except Exception as e:
            logger.warning("get_pickup_pace query error: %s", e)
            rows = []

        return json.dumps({
            "category": category.upper(),
            "days_back": days_back,
            "new_bookings": len(rows),
            "expected_pace_note": (
                f"With {days_back} days lookback, {len(rows)} new bookings found. "
                "Compare against category total rooms × occ_target to gauge momentum."
            ),
        })

    return [get_pricing_context, get_low_occupancy_dates, get_pickup_pace]


# ── Agent state (module-level so LangGraph annotation resolution finds it) ────

class _AgentState(TypedDict):
    messages: Annotated[list, operator.add]


# ── Agent graph ───────────────────────────────────────────────────────────────

def _build_graph(tools: list):
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        google_api_key=settings.GEMINI_API_KEY,
        temperature=0.2,
        convert_system_message_to_human=True,  # Gemini doesn't natively support system role
    )
    llm_with_tools = llm.bind_tools(tools)

    tool_node = ToolNode(tools)

    async def agent_node(state: _AgentState):
        response = await llm_with_tools.ainvoke(state["messages"])
        return {"messages": [response]}

    def should_continue(state: _AgentState):
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END

    graph = StateGraph(_AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


def _parse_recommendations(ai_text: str) -> dict:
    """Extract JSON from AI final message. Returns dict with recommendations + summary."""
    # Try to find JSON object in the text
    text = ai_text.strip()

    # Strip markdown fences if present
    if "```" in text:
        start = text.find("{", text.find("```"))
        end = text.rfind("}") + 1
        if start != -1 and end > start:
            text = text[start:end]

    # If it looks like raw JSON starting with {
    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

    # Find first { to last }
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass

    logger.warning("Pricing agent: could not parse JSON from AI output (full): %s", text)
    return {"recommendations": [], "summary": "Unable to parse AI response."}


# ── Public entry point ────────────────────────────────────────────────────────

async def run_pricing_agent(
    snapshot: dict,
    context_text: str,
    today: date,
    session_factory: async_sessionmaker,
) -> dict:
    """
    Run one pricing analysis turn.
    Returns dict: { recommendations: [...], summary: str }
    """
    tools = _make_tools(snapshot, session_factory, today)
    graph = _build_graph(tools)

    system_prompt = _SYSTEM.format(
        hotel_name=settings.HOTEL_NAME,
        today=today.isoformat(),
        context=context_text,
    )

    prompt = (
        "Analyse the hotel occupancy data and generate pricing recommendations "
        "for all categories. Use the tools to gather detail on categories that need "
        "closer inspection. Output the final JSON recommendations object."
    )

    initial_messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=prompt),
    ]

    try:
        result = await asyncio.wait_for(
            graph.ainvoke({"messages": initial_messages}),
            timeout=290,  # 10s under Nginx's 300s proxy_read_timeout
        )
    except asyncio.TimeoutError:
        logger.error("Pricing agent timed out after 290s")
        return {"recommendations": [], "summary": "Analysis timed out — try again or reduce the booking window."}
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "spending cap" in msg:
            from fastapi import HTTPException
            raise HTTPException(status_code=503, detail="Gemini API spending cap reached. Go to ai.studio/spend to increase your limit.")
        logger.error("Pricing agent error: %s", msg)
        raise
    messages = result["messages"]

    # Last AIMessage without tool_calls = final answer
    # Gemini returns content as a list[dict] when tools were used — extract text parts.
    final_text = ""
    for msg in reversed(messages):
        if isinstance(msg, AIMessage) and not msg.tool_calls:
            if isinstance(msg.content, str):
                final_text = msg.content
            elif isinstance(msg.content, list):
                final_text = "".join(
                    part.get("text", "") for part in msg.content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
            break

    if not final_text:
        logger.error("Pricing agent: no final message found in output")
        return {"recommendations": [], "summary": "Pricing analysis failed."}

    return _parse_recommendations(final_text)
