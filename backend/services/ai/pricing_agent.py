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
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Booking

logger = logging.getLogger(__name__)


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are the Revenue Management AI for {hotel_name}.
Today is {today}.

Your job: analyse hotel occupancy data and produce dynamic pricing recommendations
for each room category over the booking window.

Occupancy Tier-1 snapshot (next 14 days):
{context}

── Pricing Rules ─────────────────────────────────────────────────────────────
Occupancy thresholds (use as starting point — adjust for lead time + pickup):
  < 30%  → DISCOUNT  aggressive  (–15–25%)
  30–50% → DISCOUNT  moderate    (–5–15%)
  50–70% → HOLD      standard BAR
  70–85% → INCREASE  moderate    (+10–20%)
  > 85%  → INCREASE  aggressive  (+20–35%)

Lead-time rule:
  Check-in within 3 days  → tighten discounts (urgency pricing)
  Check-in 4–7 days out   → standard thresholds
  Check-in 8–14 days out  → lead-time discount if occ < 50%

Pickup-pace rule:
  If last-7-day pickup rate < expected (occ% / days_remaining), discount more.
  If last-7-day pickup rate > expected, increase or hold.

Floor-rate constraint (HARD): NEVER suggest a rate below floor_rate for any date.
If the calculated suggestion would breach floor_rate, cap at floor_rate and note it.

── Tools ─────────────────────────────────────────────────────────────────────
get_pricing_context(category, start_date, end_date)
  → Per-date occupancy + rate detail for a specific range (up to 30 days).
  → Use for categories where you need detail beyond the 14-day snapshot above.

get_low_occupancy_dates(category, threshold_pct=50.0)
  → Returns dates in the next 30 days where category-level occupancy is below
    threshold_pct. Includes lead_days so you can apply urgency adjustments.
  → Uses aggregate booked/total counts per date — independent of room arrangement.
  → Use to identify discount candidates.

get_pickup_pace(category, days_back)
  → Bookings confirmed in the last N days for this category.
  → Use to assess demand momentum.

── Output format ─────────────────────────────────────────────────────────────
After calling the tools you need, output a JSON object (no markdown fence) with:
  {{
    "recommendations": [
      {{
        "category": "DELUXE",
        "date": "2026-04-15",
        "current_rate": 5000,
        "suggested_rate": 5500,
        "change_pct": 10.0,
        "confidence": "HIGH",
        "reason": "82% occupancy, strong 7-day pickup — increase to capture demand",
        "occupancy_pct": 82.0,
        "otb": 5,
        "floor_rate": 3500
      }},
      ...
    ],
    "summary": "3 categories show >80% occupancy — price increases recommended. ECONOMY has 2 empty windows — targeted discounts suggested."
  }}

Rules for recommendations:
  - Only recommend dates where action is warranted (occ < 50% or occ > 80%).
  - Dates in the 50–80% range: omit unless pickup pace is abnormally slow.
  - Max 30 recommendations total (focus on the most impactful).
  - suggested_rate must be rounded to nearest ₹100.
  - change_pct = round((suggested_rate - current_rate) / current_rate * 100, 1)
  - Confidence: HIGH if occ >85% or <30%, MEDIUM if 70–85% or 30–50%, LOW otherwise.

Output ONLY the JSON object. No explanation text before or after.
"""


# ── Tools ─────────────────────────────────────────────────────────────────────

def _make_tools(snapshot: dict, db: AsyncSession, today: date):
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
    )
    llm_with_tools = llm.bind_tools(tools)

    tool_node = ToolNode(tools)

    def agent_node(state: _AgentState):
        response = llm_with_tools.invoke(state["messages"])
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
    db: AsyncSession,
) -> dict:
    """
    Run one pricing analysis turn.
    Returns dict: { recommendations: [...], summary: str }
    """
    tools = _make_tools(snapshot, db, today)
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

    result = await graph.ainvoke({"messages": initial_messages})
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
