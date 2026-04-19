"""
Channel Allocation AI Agent — LangGraph + Gemini 2.5 Flash

Single-shot agent:
  1. Manager clicks "Run AI Analysis" in the Channels tab
  2. Agent receives occupancy snapshot + channel performance history
  3. Agent calls tools to inspect gaps and historical patterns
  4. Returns structured channel allocation recommendations

Tools:
  get_occupancy_gaps(category, look_ahead_days)  — empty nights per category
  get_channel_history(category, days_back)        — OTA/GDS share and ADR history
  get_weekly_pattern(category)                    — DOW booking distribution

Output: JSON array of recommendations with reasoning.
"""

import json
import logging
import operator
from collections import defaultdict
from datetime import date, timedelta
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, Booking, BlockType

logger = logging.getLogger(__name__)


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are the Channel Strategy AI for {hotel_name}, a hotel in Pune, India.
Today is {today}.

Your job: analyse inventory gaps and historical booking channel data to recommend
which booking sources (OTA partners or Direct) should receive inventory allocation
for specific upcoming dates and room categories.

Current inventory snapshot (next 14 days):
{context}

── Pune Channel Market Context ───────────────────────────────────────────────
Two routes for every booking: either via a Channel (OTA/GDS partner) or Direct.

OTA partners (with standard Pune commission rates):
  MakeMyTrip & Goibibo  — 18% commission, highest volume in Pune market
  Agoda                 — 18% commission, strong for international guests
  Booking.com           — 18% commission, good for Suite/Deluxe upgrades
  Expedia               — 18% commission, corporate + international mix
  Amadeus/Sabre/Travelport — 10% commission (GDS), mostly corporate accounts

Direct booking — 0% commission, but requires demand already exists.

Business logic:
  • PUSH to OTA when occupancy < 50% for weekday, < 65% for weekend — fill the gap.
  • HOLD for Direct when occupancy > 70% — retain full margin on high-demand nights.
  • Weekend gaps (Fri/Sat) → MakeMyTrip/Goibibo first (highest leisure volume in Pune).
  • Weekday gaps → Amadeus/Sabre if corporate; else Goibibo for budget business travel.
  • Never allocate OTA for a date that is already > 80% occupied — diminishing returns.
  • Suite/Premium gaps with < 30 days lead: consider Direct + corporate rate offer first.
  • Economy/Standard gaps: OTA almost always better — high volume, price-sensitive segment.

── Tools ─────────────────────────────────────────────────────────────────────
get_occupancy_gaps(category, look_ahead_days)
  → Empty slot runs per category. Use to identify what needs filling.

get_channel_history(category, days_back)
  → Historical breakdown of which OTA/partner drove bookings and at what ADR.
  → Use to identify the best-performing partner for each category.

get_weekly_pattern(category)
  → DOW distribution of past bookings. Use to judge weekend vs weekday demand.

── Output format ─────────────────────────────────────────────────────────────
After calling the tools, output a JSON object (no markdown fence, no extra text):
{{
  "recommendations": [
    {{
      "booking_source": "MakeMyTrip",
      "channel_type": "OTA",
      "category": "DELUXE",
      "check_in": "2026-04-25",
      "check_out": "2026-04-28",
      "room_count": 1,
      "expected_gross": 15000.0,
      "commission_cost": 2700.0,
      "expected_net": 12300.0,
      "confidence": "HIGH",
      "reasoning": "15-25 words: WHY this partner for this category on these dates, using Pune market context."
    }}
  ],
  "summary": "2-3 sentences: overall channel strategy for the week, referencing occupancy levels and Pune demand signals."
}}

Rules:
  - Produce 3–8 recommendations covering the most impactful gaps.
  - Sort by confidence descending, then expected_net descending.
  - Only recommend dates with ≥1 empty night for the category.
  - room_count = 1 unless you have strong evidence for more (e.g., very low occ + long gap).
  - Confidence: HIGH if strong OTA history + low occ, MEDIUM if moderate gap, LOW if uncertain.
  - reasoning MUST mention the specific Pune demand context (weekday corporate, weekend leisure,
    IPL season, monsoon, IT corridor, etc.) — never just "low occupancy."
  - commission_cost = expected_gross × commission_rate (OTA=0.18, GDS=0.10, Direct=0.0).
  - Output ONLY the JSON object. No preamble, no trailing text.
"""


# ── Tools ─────────────────────────────────────────────────────────────────────

def _make_tools(db: AsyncSession, today: date):

    @tool
    async def get_occupancy_gaps(category: str, look_ahead_days: int = 14) -> str:
        """
        Return empty slot runs for CATEGORY in the next look_ahead_days days.
        Use this to find which dates/date-ranges need inventory allocation.
        """
        look_end = today + timedelta(days=min(look_ahead_days, 21))
        try:
            rows = (await db.execute(
                select(Room.category, Room.base_rate, Slot.date, Slot.block_type)
                .join(Room, Room.id == Slot.room_id)
                .where(
                    Room.is_active == True,
                    Room.category == category.upper(),
                    Slot.date >= today,
                    Slot.date < look_end,
                )
                .order_by(Slot.date)
            )).all()
        except Exception as e:
            return json.dumps({"error": str(e)})

        daily: dict[str, dict] = {}
        for cat, base_rate, d, block_type in rows:
            ds = d.isoformat()
            if ds not in daily:
                daily[ds] = {"total": 0, "empty": 0, "occupied": 0, "base_rate": float(base_rate)}
            daily[ds]["total"] += 1
            if block_type == BlockType.EMPTY:
                daily[ds]["empty"] += 1
            else:
                daily[ds]["occupied"] += 1

        # Find contiguous empty runs
        gaps = []
        sorted_days = sorted(daily.keys())
        run_start = None
        run_empty = 0
        for ds in sorted_days:
            d_info = daily[ds]
            if d_info["empty"] > 0:
                if run_start is None:
                    run_start = ds
                    run_empty = d_info["empty"]
            else:
                if run_start is not None:
                    gaps.append({"from": run_start, "to": ds, "empty_rooms": run_empty,
                                 "base_rate": daily[run_start]["base_rate"]})
                    run_start = None
        if run_start:
            gaps.append({"from": run_start, "to": sorted_days[-1], "empty_rooms": run_empty,
                         "base_rate": daily[run_start]["base_rate"]})

        return json.dumps({
            "category": category.upper(),
            "look_ahead_days": look_ahead_days,
            "daily_summary": daily,
            "contiguous_gaps": gaps,
        })

    @tool
    async def get_channel_history(category: str, days_back: int = 60) -> str:
        """
        Return historical channel/partner breakdown for CATEGORY over the last days_back days.
        Shows which partners drive the most volume and at what average rate.
        Use this to pick the best allocation target.
        """
        hist_start = today - timedelta(days=min(days_back, 120))
        try:
            rows = (await db.execute(
                select(Slot.channel, Slot.channel_partner, Slot.current_rate)
                .join(Room, Room.id == Slot.room_id)
                .where(
                    Room.is_active == True,
                    Room.category == category.upper(),
                    Slot.date >= hist_start,
                    Slot.date < today,
                    Slot.block_type != BlockType.EMPTY,
                )
            )).all()
        except Exception as e:
            return json.dumps({"error": str(e)})

        partner_stats: dict[str, dict] = defaultdict(lambda: {"nights": 0, "revenue": 0.0})
        total_nights = 0
        for ch, partner, rate in rows:
            key = partner or (ch.value if hasattr(ch, "value") else str(ch))
            partner_stats[key]["nights"] += 1
            partner_stats[key]["revenue"] += float(rate)
            total_nights += 1

        breakdown = []
        for p, s in sorted(partner_stats.items(), key=lambda x: -x[1]["nights"]):
            n = s["nights"]
            r = s["revenue"]
            breakdown.append({
                "partner": p,
                "nights": n,
                "share_pct": round(n / max(1, total_nights) * 100, 1),
                "avg_rate": round(r / n, 0) if n else 0,
            })

        return json.dumps({
            "category": category.upper(),
            "days_back": days_back,
            "total_nights": total_nights,
            "partner_breakdown": breakdown,
            "note": "Use share_pct and avg_rate to identify best allocation partner.",
        })

    @tool
    async def get_weekly_pattern(category: str) -> str:
        """
        Return day-of-week booking distribution for CATEGORY over the past 60 days.
        Mon=0 … Sun=6. Use to determine if weekend or weekday gaps are more critical.
        """
        hist_start = today - timedelta(days=60)
        try:
            rows = (await db.execute(
                select(Slot.date)
                .join(Room, Room.id == Slot.room_id)
                .where(
                    Room.is_active == True,
                    Room.category == category.upper(),
                    Slot.date >= hist_start,
                    Slot.date < today,
                    Slot.block_type != BlockType.EMPTY,
                )
            )).scalars().all()
        except Exception as e:
            return json.dumps({"error": str(e)})

        dow_count = [0] * 7
        for d in rows:
            dow_count[d.weekday()] += 1

        dow_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        return json.dumps({
            "category": category.upper(),
            "dow_distribution": {dow_labels[i]: dow_count[i] for i in range(7)},
            "peak_day": dow_labels[dow_count.index(max(dow_count))],
            "weekend_total": dow_count[4] + dow_count[5],
            "weekday_total": sum(dow_count[:4]),
        })

    return [get_occupancy_gaps, get_channel_history, get_weekly_pattern]


# ── Agent state ────────────────────────────────────────────────────────────────

class _AgentState(TypedDict):
    messages: Annotated[list, operator.add]


# ── Graph ──────────────────────────────────────────────────────────────────────

def _build_graph(tools: list):
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        google_api_key=settings.GEMINI_API_KEY,
        temperature=0.3,
    )
    llm_with_tools = llm.bind_tools(tools)
    tool_node = ToolNode(tools)

    def agent_node(state: _AgentState):
        return {"messages": [llm_with_tools.invoke(state["messages"])]}

    def should_continue(state: _AgentState):
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END

    g = StateGraph(_AgentState)
    g.add_node("agent", agent_node)
    g.add_node("tools", tool_node)
    g.set_entry_point("agent")
    g.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    g.add_edge("tools", "agent")
    return g.compile()


def _parse(text: str) -> dict:
    text = text.strip()
    if "```" in text:
        start = text.find("{", text.find("```"))
        end = text.rfind("}") + 1
        if start != -1 and end > start:
            text = text[start:end]
    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass
    logger.warning("Channel agent: could not parse JSON: %s", text[:300])
    return {"recommendations": [], "summary": "Channel analysis failed to parse."}


# ── Public entry point ─────────────────────────────────────────────────────────

async def run_channel_agent(
    context_text: str,
    today: date,
    db: AsyncSession,
) -> dict:
    """
    Run one channel allocation analysis turn.
    Returns dict: { recommendations: [...], summary: str }
    """
    tools = _make_tools(db, today)
    graph = _build_graph(tools)

    system_prompt = _SYSTEM.format(
        hotel_name=settings.HOTEL_NAME,
        today=today.isoformat(),
        context=context_text,
    )

    prompt = (
        "Analyse inventory gaps and historical channel data for all room categories. "
        "Use the tools to inspect each category's gaps and historical partner performance. "
        "Then output the final JSON recommendations object."
    )

    result = await graph.ainvoke({
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=prompt),
        ]
    })

    final_text = ""
    for msg in reversed(result["messages"]):
        if isinstance(msg, AIMessage) and not msg.tool_calls:
            if isinstance(msg.content, str):
                final_text = msg.content
            elif isinstance(msg.content, list):
                final_text = "".join(
                    p.get("text", "") for p in msg.content
                    if isinstance(p, dict) and p.get("type") == "text"
                )
            break

    if not final_text:
        logger.error("Channel agent: no final message")
        return {"recommendations": [], "summary": "Channel analysis unavailable."}

    return _parse(final_text)
