"""
Channel Allocation AI Agent — LangGraph + Gemini 2.5 Flash

Single-shot agent:
  1. Manager clicks "Run Channel Intelligence" in the Channels tab
  2. Agent receives a consolidated channel context bundle
  3. Agent calls tools to inspect gaps, historical patterns, and partner health
  4. Returns structured channel allocation recommendations

Tools:
  get_occupancy_gaps(category, look_ahead_days)  — empty nights per category
  get_channel_history(category, days_back)        — OTA partner share and ADR history
  get_weekly_pattern(category)                    — DOW booking distribution
  get_channel_news(partner_name)                  — date-aware OTA news/campaign health
                                                    signal → PREFER/NEUTRAL/PENALIZE

Output: JSON array of recommendations with reasoning.
"""

import json
import logging
import operator
from collections import defaultdict
from datetime import date, timedelta
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from config import settings
from core.models import Room, Slot, BlockType, Channel
from services.ai.channel_news import get_partner_news

logger = logging.getLogger(__name__)


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are the Channel Strategy AI (YieldIQ) for {hotel_name}, a hotel in New Jersey, USA.
Today is {today}.

Your job: analyze inventory gaps and historical booking channel data to recommend
which US-active OTA partners should receive inventory allocation
for specific upcoming dates and room categories.

Consolidated channel intelligence context:
{context}

── New Jersey Channel Market Context ─────────────────────────────────────────
Two routes for every room night: OTA allocation or direct hotel/front-desk selling.
This agent only recommends OTA allocation. Inventory not allocated to OTA remains
direct hotel/front-desk inventory and should be used as the benchmark, not as a
recommendation target.

US-active OTA partners (with standard US commission rates):
  Expedia & Hotels.com  — 18% commission, highest volume in NJ/NYC-metro market
  Booking.com           — 18% commission, global OTA with strong US inbound and leisure demand
  Priceline             — 18% commission, opaque/flash deals dominate Standard
  Travelocity           — 18% commission, US leisure package demand
  Orbitz                — 18% commission, US rewards-led leisure demand

Direct hotel/front-desk selling — 0% commission; works best when demand already
exists or for high-value Suite/Deluxe. Treat it as the holdout/comparison path.

Business logic:
  • Treat the consolidated context plus tool outputs as the single decision surface.
    Reconcile real inventory gaps, real historical channel performance, date-aware
    OTA news/campaign and partner-health signals inside this response.
  • Do not rely on separate UI scoring.
  • Only the OTA news/campaign feed is mocked. Do not invent non-channel
    external demand shocks unless they appear in the context or a tool result.
  • Apply campaign windows by date: only use a partner campaign as positive
    evidence when its active dates overlap the recommended stay dates.
  • If the consolidated context or partner-health tool mentions a partner outage,
    downtime, CRITICAL/HIGH impact event, or explicit partner-health risk, avoid
    incremental slot pushes to that partner this run unless there is no viable safer OTA alternative.
    The summary must name the risk and say which safer partners replace it.
  • PUSH to OTA when occupancy < 50% for weekday, < 65% for weekend — fill the gap.
  • HOLD for direct hotel selling when occupancy > 70% — do not recommend OTA.
  • Never allocate OTA for a date that is already > 80% occupied — diminishing returns.
  • Suite/Deluxe gaps with < 30 days lead: recommend OTA only when the gap is material.
  • Standard gaps: OTA almost always better — high volume, price-sensitive segment.

  Partner selection — work through this cascade for every gap, skipping PENALIZE/AVOID:
  • Weekend gaps (Fri/Sat leisure):
      1st choice → Expedia       (highest NJ/NYC-metro volume)
      2nd choice → Booking.com   (global brand, strong US inbound and leisure conversion)
      3rd choice → Hotels.com    (loyalty-led repeat leisure demand)
      4th choice → Priceline     (flash deals fill remaining leisure gaps)
      5th choice → Travelocity   (US package leisure)
      6th choice → Orbitz        (rewards-led leisure)
  • Weekday gaps (Mon–Thu corporate):
      1st choice → Expedia       (broadest US corporate/leisure reach)
      2nd choice → Priceline     (opaque deals for Standard low-occ weekday)
      3rd choice → Booking.com   (business traveler segment and inbound overflow)
      4th choice → Hotels.com    (loyalty-segment weekday demand)
      5th choice → Orbitz        (price-sensitive weekday demand)
  • High-occupancy nights → hold for direct hotel selling; do not recommend OTA unless occupancy is below threshold.
  • Spread recommendations across AT LEAST 3 different partners per analysis run.
    Do not assign more than 40% of total recommendations to any single partner.

── Tools ─────────────────────────────────────────────────────────────────────
get_occupancy_gaps(category, look_ahead_days)
  → Empty slot runs per category. Use to identify what needs filling.

get_channel_history(category, days_back)
  → Historical breakdown of which OTA/partner drove bookings and at what ADR.
  → Use to identify the best-performing partner for each category.

get_weekly_pattern(category)
  → DOW distribution of past bookings. Use to judge weekend vs weekday demand.

get_channel_news(partner_name)
  → Returns mocked, date-aware OTA news/campaign and partner-health signals:
    campaigns, outages, connectivity watches, and a signal:
    PREFER / NEUTRAL / PENALIZE / AVOID.
  → ALWAYS call this for the top 2–3 partners you are about to recommend.
  → PENALIZE: lower confidence to LOW or MEDIUM, flag the risk in reasoning,
    route volume to a safer alternative instead.
  → PREFER: raise confidence, mention the positive signal in reasoning.
  → AVOID: do not recommend that partner at all this cycle.
  → Reasoning MUST mention any CRITICAL or HIGH-impact OTA news item by name.

── Output format ─────────────────────────────────────────────────────────────
After calling the tools, output a JSON object (no markdown fence, no extra text):
{{
  "recommendations": [
    {{
      "booking_source": "Booking.com",
      "channel_type": "OTA",
      "category": "DELUXE",
      "check_in": "2026-05-02",
      "check_out": "2026-05-05",
      "room_count": 1,
      "expected_gross": 750.0,
      "commission_cost": 135.0,
      "expected_net": 615.0,
      "confidence": "HIGH",
      "reasoning": "15-25 words: WHY this partner for this category on these dates, using booking history, occupancy gap, or OTA news."
    }}
  ],
  "partner_insights": [
    {{
      "partner": "Booking.com",
      "preference": "PREFER",
      "health": "GREEN",
      "confidence": "HIGH",
      "score": 94,
      "reasoning": "One best manager-facing suggestion or feedback item for this OTA partner.",
      "category": "ECONOMY",
      "check_in": "2026-05-08",
      "check_out": "2026-05-09",
      "room_count": 1,
      "expected_net": 615.0
    }}
  ],
    "summary": "2-3 sentences: overall OTA strategy for the week, referencing real gap/history signals and relevant mock OTA news/campaign or partner-health dates."
}}

Rules:
  - Produce 3–8 recommendations covering the most impactful gaps.
  - Produce exactly one partner_insights item for each OTA partner: Expedia, Hotels.com, Booking.com, Priceline, Travelocity, Orbitz.
  - partner_insights is the manager-facing ranking source. Use PREFER for the best push, WATCH for usable secondary options, HOLD when no push is recommended, and AVOID for active partner risk.
  - partner_insights.health must be GREEN, AMBER, or RED. Use RED for active outage/downtime/avoid, AMBER for watch/penalized, GREEN otherwise.
  - Each partner_insights reasoning must be one concise partner-specific recommendation or feedback item. Do not create multiple insight cards for the same partner.
  - Every recommendation must have channel_type="OTA".
  - booking_source must be one of: Expedia, Hotels.com, Booking.com, Priceline, Travelocity, Orbitz.
  - Never recommend Direct or any non-OTA partner.
  - Sort by confidence descending, then expected_net descending.
  - Only recommend dates with ≥1 empty night for the category.
  - room_count = 1 unless you have strong evidence for more (e.g., very low occ + long gap).
  - Confidence: HIGH if strong OTA history + low occ, MEDIUM if moderate gap, LOW if uncertain.
  - reasoning MUST mention either channel history, occupancy gap timing, an active OTA campaign/news item,
    or partner-health signal. Never invent non-channel events or say only "low occupancy."
  - commission_cost = expected_gross × 0.18.
  - Output ONLY the JSON object. No preamble, no trailing text.
  - If a partner has signal=PENALIZE or AVOID, do NOT recommend them — substitute
    the next best alternative and explain the switch in the reasoning field.
"""


# ── Tools ─────────────────────────────────────────────────────────────────────

def _make_tools(session_factory: async_sessionmaker, today: date):

    @tool
    async def get_occupancy_gaps(category: str, look_ahead_days: int = 14) -> str:
        """
        Return empty slot runs for CATEGORY in the next look_ahead_days days.
        Use this to find which dates/date-ranges need inventory allocation.
        """
        look_end = today + timedelta(days=min(look_ahead_days, 21))
        try:
            async with session_factory() as db:
                rows = (await db.execute(
                    select(Room.id, Room.category, Room.base_rate, Slot.date, Slot.block_type)
                    .outerjoin(
                        Slot,
                        (Slot.room_id == Room.id)
                        & (Slot.date >= today)
                        & (Slot.date < look_end),
                    )
                    .where(
                        Room.is_active == True,
                        Room.category == category.upper(),
                    )
                    .order_by(Room.id, Slot.date)
                )).all()
        except Exception as e:
            return json.dumps({"error": str(e)})

        daily: dict[str, dict] = {}
        room_ids = {room_id for room_id, *_ in rows}
        room_base_rate = {room_id: float(base_rate or 0.0) for room_id, _cat, base_rate, _d, _bt in rows}
        slot_by_room_date = {(room_id, d): block_type for room_id, _cat, _base_rate, d, block_type in rows if d is not None}
        for offset in range((look_end - today).days):
            d = today + timedelta(days=offset)
            ds = d.isoformat()
            daily[ds] = {"total": 0, "empty": 0, "occupied": 0, "base_rate": 0.0}
            base_sum = 0.0
            for room_id in room_ids:
                base_sum += room_base_rate.get(room_id, 0.0)
                block_type = slot_by_room_date.get((room_id, d), BlockType.EMPTY)
                daily[ds]["total"] += 1
                if block_type == BlockType.EMPTY:
                    daily[ds]["empty"] += 1
                else:
                    daily[ds]["occupied"] += 1
            daily[ds]["base_rate"] = round(base_sum / max(1, len(room_ids)), 2)

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
            async with session_factory() as db:
                rows = (await db.execute(
                    select(Slot.channel, Slot.channel_partner, Slot.current_rate)
                    .join(Room, Room.id == Slot.room_id)
                    .where(
                        Room.is_active == True,
                        Room.category == category.upper(),
                        Slot.date >= hist_start,
                        Slot.date < today,
                        Slot.block_type == BlockType.SOFT,
                        Slot.channel == Channel.OTA,
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
            async with session_factory() as db:
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

    @tool
    async def get_channel_news(partner_name: str) -> str:
        """
        Return date-aware OTA news/campaign intelligence for a channel partner.

        Simulates data pulled from OTA partner portals and news aggregators.

        Returns:
          news_score        : float -1.0 (very negative) to +1.0 (very positive)
          news_label        : POSITIVE / NEUTRAL / NEGATIVE / CRITICAL
          signal            : PREFER / NEUTRAL / PENALIZE / AVOID
          recent_events     : list of news/campaign items with date windows
          signal_reason     : plain-English allocation guidance for this partner

        Call this for every partner you are about to recommend before finalizing
        the output. If signal is PENALIZE or AVOID, route volume elsewhere.

        partner_name: e.g. "Expedia", "Hotels.com", "Booking.com", "Priceline",
                      "Travelocity", "Orbitz"
        """
        data = get_partner_news(partner_name, today=today)
        return json.dumps(data)

    return [get_occupancy_gaps, get_channel_history, get_weekly_pattern, get_channel_news]


# ── Agent state ────────────────────────────────────────────────────────────────

class _AgentState(TypedDict):
    messages: Annotated[list, operator.add]


# ── Graph ──────────────────────────────────────────────────────────────────────

def _build_graph(tools: list):
    llm = ChatOpenAI(
        model="auto",
        openai_api_base=settings.POLYAI_API_BASE,
        openai_api_key=settings.POLYAI_API_KEY,
        temperature=0.3,
        model_kwargs={"extra_body": {"prefer": "quality"}},
    )
    llm_with_tools = llm.bind_tools(tools)
    tool_map = {t.name: t for t in tools}

    async def agent_node(state: _AgentState):
        return {"messages": [await llm_with_tools.ainvoke(state["messages"])]}

    # Sequential executor — tools share one AsyncSession; asyncio.gather causes
    # SQLAlchemy "concurrent operations are not permitted" errors.
    async def tool_node(state: _AgentState) -> dict:
        last = state["messages"][-1]
        results: list[BaseMessage] = []
        for tc in last.tool_calls:
            fn = tool_map.get(tc["name"])
            if fn is None:
                results.append(ToolMessage(
                    content=json.dumps({"error": f"Unknown tool: {tc['name']}"}),
                    tool_call_id=tc["id"],
                ))
                continue
            try:
                out = await fn.ainvoke(tc["args"])
            except Exception as exc:
                out = json.dumps({"error": str(exc)})
            results.append(ToolMessage(content=out, tool_call_id=tc["id"]))
        return {"messages": results}

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
    session_factory: async_sessionmaker,
) -> dict:
    """
    Run one channel allocation analysis turn.
    Returns dict: { recommendations: [...], summary: str }
    """
    tools = _make_tools(session_factory, today)
    graph = _build_graph(tools)

    system_prompt = _SYSTEM.format(
        hotel_name=settings.HOTEL_NAME,
        today=today.isoformat(),
        context=context_text,
    )

    prompt = (
        "Analyze inventory gaps and historical channel data for all room categories. "
        "Use the tools to inspect each category's gaps and historical partner performance. "
        "Then output the final JSON recommendations object."
    )

    try:
        result = await graph.ainvoke({
            "messages": [
                SystemMessage(content=system_prompt),
                HumanMessage(content=prompt),
            ]
        })
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            from fastapi import HTTPException
            raise HTTPException(status_code=503, detail="AI API rate limit reached.")
        logger.error("Channel agent error: %s", msg)
        raise

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
