"""
Receptionist AI Agent — LangGraph + Gemini

Architecture:
  - Stateless: frontend owns full conversation history, sends it on every request
  - LangGraph agentic loop: agent → tool_node → agent → ... → END
  - Gemini 1.5 Flash via langchain-google-genai
  - 3 tools: check_availability, find_split_stay (Phase 2 stub), confirm_booking
  - action_data: structured payload returned alongside text reply for frontend cards
"""

from __future__ import annotations

import json
import logging
import operator
from collections import defaultdict
from datetime import date, timedelta
from typing import Annotated, Optional, TypedDict

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from controllers import receptionist as ctrl
from core.models import Room, Slot, Booking
from core.models.enums import BlockType, RoomCategory
from core.schemas import BookingRequestIn

logger = logging.getLogger(__name__)


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are the AI revenue intelligence assistant for {hotel_name}, located in Pune, India.
Today is {today}.

You serve TWO roles simultaneously at the front desk:

ROLE 1 — BOOKING ASSISTANT
Handle guest booking requests conversationally. Collect dates and category, call
the right tool, return an action card the receptionist can confirm with one click.

ROLE 2 — REVENUE ADVISOR (parallel, always-on)
Proactively surface revenue intelligence. When a receptionist is idle, handling a
booking, or asking a general question, you may call get_revenue_intelligence() and
share a short insight: tonight's occupancy, which category has gaps to fill, whether
an upgrade is worth offering, or if a date is under pressure. You are not just a
fallback for impossible bookings — you are an always-on advisor.

Pune hotel market context (use this for AI insights and pricing commentary):
- Pune is a major IT and business hub (Hinjewadi, Magarpatta, Kharadi corridors).
  Weekday demand is driven by corporate guests; weekends see leisure + family travel.
- Seasonal peaks: October–February (pleasant weather, wedding season, conferences).
  Monsoon (June–September): leisure demand drops, corporate travel continues.
- Local events that impact demand: Pune Festival (Oct), IT conferences (Mar, Sep),
  IPL season (Apr–May), Ganesh Chaturthi (Aug/Sep — very high leisure demand).
- Key competitor set: mid-market business hotels near Viman Nagar, Koregaon Park,
  Hadapsar. Rate pressure is highest Mon–Thu from OTAs (MakeMyTrip, Goibibo, Agoda).
- Weddings and MICE events book 3–6 months in advance and fill Suites + Deluxe fast.

Available room categories (lowest → highest): ECONOMY, STANDARD, STUDIO, DELUXE, PREMIUM, SUITE.

Current hotel snapshot (category-level — see tool for per-room detail):
{context}

── CORE RULE — tool calls ────────────────────────────────────────────────────
• For BOOKING requests: you MUST have BOTH an explicit category AND explicit
  check-in + check-out dates from the guest. Only then call check_availability
  or find_split_stay. Never call booking tools for greetings, general questions,
  or occupancy queries — call get_revenue_intelligence() instead.
• For INSIGHTS: call get_revenue_intelligence(). Never call check_availability
  just to show data — it produces a card that confuses the receptionist.
• Never quote room IDs or rates from memory. Only report what tool results return.
• You are a recommendation engine — you NEVER write to the database.
  Confirmation is always done by the receptionist clicking the UI button.
── ───────────────────────────────────────────────────────────────────────────

── Tools ─────────────────────────────────────────────────────────────────────
check_availability(category, check_in, check_out)
  → Call whenever you want to recommend a room for a date range.
  → Returns DIRECT_AVAILABLE, SHUFFLE_POSSIBLE, or NOT_POSSIBLE.
  → ALWAYS call this even if you already know availability from context.

find_split_stay(category, check_in, check_out)
  → Call when check_availability returns NOT_POSSIBLE.
  → Returns SPLIT_POSSIBLE (2–3 rooms, discount) or NOT_POSSIBLE.

find_split_stay_flex(preferred_category, check_in, check_out)
  → Call when the receptionist allows mixed-category split stays.
  → Returns SPLIT_POSSIBLE across ANY categories, preferring preferred_category.

get_room_inventory(category)
  → Call when the guest asks about floors, specific room IDs, or exact rates.
  → Do NOT call just to check booking feasibility — use check_availability.

probe_split_window(category, anchor_check_in, duration_nights)
  → Call when find_split_stay returned NOT_POSSIBLE for the guest's dates.
  → Tries ±5 day shifts to find the nearest split stay window.
  → Also call when guest asks "any date/category with split stay discount?"

get_revenue_intelligence()
  → Call proactively when the receptionist asks a general question, greets you,
    or there is no active booking request in progress.
  → Returns: per-category occupancy %, orphan gap nights, upgrade availability,
    tonight ADR, week revenue on books, Pune market context hints.
  → Use this to give a brief (1–2 sentence) insight: what's filling up, what's
    empty, which upgrades are available, whether to push a certain category.
  → Do NOT call this when a specific booking action is already in progress.
── ───────────────────────────────────────────────────────────────────────────

── Revenue advisor behaviour ─────────────────────────────────────────────────
• If the receptionist says "hi", "hello", "what's looking good today?", "what
  should I push?", or anything non-booking: call get_revenue_intelligence() and
  give a brief, friendly, actionable insight. E.g.:
  "Suite occupancy is light this weekend — if a guest upgrades, offer it at 10%
  off. Deluxe is nearly full for Friday, so hold the rate there."
• After completing a booking, if there's an upgrade opportunity (guest booked
  Standard but Deluxe has rooms), proactively mention it.
• Reference Pune market context where relevant: corporate demand, IPL, wedding
  season, IT conference weeks, monsoon slow periods.
── ───────────────────────────────────────────────────────────────────────────

── Normal booking flow ───────────────────────────────────────────────────────
1. Collect category, check-in, check-out from conversation.
2. Call check_availability → produces action card.
3. DIRECT_AVAILABLE / SHUFFLE_POSSIBLE → one sentence + "Confirm with the button."
4. NOT_POSSIBLE →
   a. Call find_split_stay(same category, same dates). SPLIT_POSSIBLE → done.
   b. If mixed-category split allowed: call find_split_stay_flex. SPLIT_POSSIBLE → done.
   c. Call check_availability(next higher category, same dates). Available → done.
   d. Call check_availability(next lower category, same dates). Available → done.
   e. Call check_availability(same category, check_in+1 day, same duration). Available → done.
   f. None worked → call get_room_inventory(category), report earliest free window.
── ───────────────────────────────────────────────────────────────────────────

── [PREFS] mode ─────────────────────────────────────────────────────────────
Message starts with [PREFS] — the receptionist just toggled a checkbox to update
guest options. This is a preference acknowledgement ONLY. Do NOT call any booking
tools. Reply with exactly one short sentence confirming the updated option (e.g.
"Got it — split stay option is now off."). No card, no tool calls.
── ───────────────────────────────────────────────────────────────────────────

── [HANDOFF] mode ────────────────────────────────────────────────────────────
Message starts with [HANDOFF] — deterministic engine already confirmed the exact
requested dates are impossible. Do NOT call check_availability for those same dates.
  STEP 1: check_availability(same category, check_in+1 day, same duration). Available → done.
  STEP 2: check_availability(next higher category, original dates). Available → done.
  STEP 3: check_availability(next lower category, original dates). Available → done.
  STEP 4: find_split_stay(same category, original dates). SPLIT_POSSIBLE → done.
  STEP 4b: find_split_stay_flex(preferred_category, original dates) if mixed allowed. Done.
  STEP 5: get_room_inventory(category), report earliest free window, no card.
── ───────────────────────────────────────────────────────────────────────────

── Voice and tone (always) ───────────────────────────────────────────────────
You are a sharp, friendly hotel revenue concierge. Speak warmly but briefly.
• Sound like a knowledgeable colleague, not a report generator.
• No bullet points, no markdown headers, no tables, no lettered options.
• Never start with "I" — start with the insight or the room.
• Vary your openers: "Looks like…", "Good news —", "Found one —", "Tonight…", etc.
• 1–2 sentences max. The card carries all the detail.

── Output rules (always) ─────────────────────────────────────────────────────
• Never invent room IDs or rates — only report tool results.
• Never say "I'll confirm" or "booking is done" — you only recommend.
• For bookings: end with "Confirm with the button below when ready."
• For revenue insights: end with a concrete suggestion the receptionist can act on.
• Reference Pune context naturally — don't over-explain it.
── ───────────────────────────────────────────────────────────────────────────
"""


# ── LangChain ↔ JSON helpers ──────────────────────────────────────────────────

def _to_lc_messages(raw: list[dict]) -> list[BaseMessage]:
    """Convert frontend { role, content } dicts to LangChain message objects."""
    out: list[BaseMessage] = []
    for m in raw:
        role    = m.get("role", "user")
        content = m.get("content", "")
        if role == "user":
            out.append(HumanMessage(content=content))
        elif role == "assistant":
            out.append(AIMessage(content=content))
        # tool / system messages from previous turns are intentionally excluded —
        # the frontend only stores user/assistant turns
    return out


def _extract_action_data(messages: list[BaseMessage]) -> Optional[dict]:
    """
    Scan ALL tool results and return the highest-priority action_data.

    Priority (highest wins — order matters):
      0. confirmed    — booking_confirmed / split_stay_confirmed
      1. actionable   — DIRECT_AVAILABLE or SHUFFLE_POSSIBLE (receptionist can act)
      2. split        — SPLIT_POSSIBLE (receptionist can act)
      3. informational— NOT_POSSIBLE (shows infeasible dates, no confirm button)

    Scanning in chronological order and keeping the highest-priority result means
    that if the AI calls check_availability(ECONOMY) → DIRECT_AVAILABLE and then
    check_availability(DELUXE) → NOT_POSSIBLE, the DIRECT_AVAILABLE card wins
    rather than being overwritten by the later NOT_POSSIBLE result.
    """
    confirmed: Optional[dict]    = None
    actionable: Optional[dict]   = None
    split_possible: Optional[dict] = None
    not_possible: Optional[dict] = None

    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        try:
            data = json.loads(msg.content)
        except (json.JSONDecodeError, TypeError):
            continue

        if data.get("stay_group_id"):
            confirmed = {"type": "split_stay_confirmed", "data": data}
        elif data.get("booking_id"):
            confirmed = {"type": "booking_confirmed", "data": data}
        elif data.get("state") == "SPLIT_POSSIBLE":
            split_possible = {"type": "split_stay_result", "data": data}
        elif data.get("state") in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
            # Keep the first actionable result; don't overwrite with a later NOT_POSSIBLE
            if actionable is None:
                actionable = {"type": "availability_result", "data": data}
        elif data.get("state") == "NOT_POSSIBLE":
            not_possible = {"type": "availability_result", "data": data}

    return confirmed or actionable or split_possible or not_possible


# ── Agent state ───────────────────────────────────────────────────────────────

class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], operator.add]
    action_data: Optional[dict]


# ── Graph builder ─────────────────────────────────────────────────────────────

def _build_graph(db: AsyncSession, system_msg: SystemMessage):
    """
    Build and compile a LangGraph graph bound to a specific DB session.
    Tools are closures that capture `db` — no global state.
    """

    # ── Tools (closures over db) ──────────────────────────────────────────────

    @tool
    async def check_availability(
        category: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        Check room availability for a category and date range.
        Returns state: DIRECT_AVAILABLE, SHUFFLE_POSSIBLE, or NOT_POSSIBLE,
        plus room_id, message, swap_plan, and alternatives.
        category must be one of: ECONOMY, STANDARD, STUDIO, DELUXE, PREMIUM, SUITE.
        Dates must be ISO format: YYYY-MM-DD.
        """
        try:
            req = BookingRequestIn(
                category=RoomCategory(category.upper()),
                check_in=date.fromisoformat(check_in),
                check_out=date.fromisoformat(check_out),
                guest_name="",
            )
            result = await ctrl.check_availability(req, db)
            # comparison is a plain dict — serialise directly
            comparison = result.comparison if isinstance(result.comparison, dict) else None
            return json.dumps({
                "state":            result.state,
                "room_id":          result.room_id,
                "message":          result.message,
                "swap_plan":        result.swap_plan,
                "comparison":       comparison,
                "infeasible_dates": result.infeasible_dates,
                "alternatives": [
                    (a.model_dump() if hasattr(a, "model_dump") else a)
                    for a in (result.alternatives or [])
                ],
                # Echo request params so the frontend Confirm button has
                # everything needed to call /receptionist/confirm without
                # the agent needing to do anything
                "request": {
                    "category":  category,
                    "check_in":  check_in,
                    "check_out": check_out,
                },
            })
        except Exception as exc:
            logger.exception("check_availability tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def find_split_stay(
        category: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        When check_availability returns NOT_POSSIBLE, find a split stay:
        cover all requested nights across 2–3 rooms of the same category,
        with a consecutive-stay discount (5% for 1 handoff, 10% for 2).
        Returns segments with room_id, floor, check_in, check_out, nights,
        base_rate, discounted_rate, total_rate, discount_pct.
        category must be one of: ECONOMY, STANDARD, STUDIO, DELUXE, PREMIUM, SUITE.
        Dates must be ISO format: YYYY-MM-DD.
        """
        try:
            req = BookingRequestIn(
                category   = RoomCategory(category.upper()),
                check_in   = date.fromisoformat(check_in),
                check_out  = date.fromisoformat(check_out),
                guest_name = "",
            )
            result = await ctrl.find_split_stay(req, db)
            return json.dumps({
                "state":        result.state,
                "message":      result.message,
                "category":     category,
                "discount_pct": result.discount_pct,
                "total_nights": result.total_nights,
                "total_rate":   result.total_rate,
                "segments": [
                    {
                        "room_id":         s.room_id,
                        "floor":           s.floor,
                        "check_in":        str(s.check_in),
                        "check_out":       str(s.check_out),
                        "nights":          s.nights,
                        "base_rate":       s.base_rate,
                        "discounted_rate": s.discounted_rate,
                    }
                    for s in result.segments
                ],
            })
        except Exception as exc:
            logger.exception("find_split_stay tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def find_split_stay_flex(
        preferred_category: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        Find a split stay allowing mixed room categories, preferring the requested
        category and adjacent categories first.

        Returns segments with room_id, category, floor, check_in, check_out, nights,
        base_rate, discounted_rate, total_rate, discount_pct.
        """
        try:
            req = BookingRequestIn(
                category=RoomCategory(preferred_category.upper()),
                check_in=date.fromisoformat(check_in),
                check_out=date.fromisoformat(check_out),
                guest_name="",
            )
            result = await ctrl.find_split_stay_flex(req, db)
            return json.dumps({
                "state":        result.state,
                "message":      result.message,
                "category":     preferred_category,
                "discount_pct": result.discount_pct,
                "total_nights": result.total_nights,
                "total_rate":   result.total_rate,
                "segments": [
                    {
                        "room_id":         s.room_id,
                        "category":        (s.category.value if hasattr(s.category, "value") else s.category),
                        "floor":           s.floor,
                        "check_in":        str(s.check_in),
                        "check_out":       str(s.check_out),
                        "nights":          s.nights,
                        "base_rate":       s.base_rate,
                        "discounted_rate": s.discounted_rate,
                    }
                    for s in (result.segments or [])
                ],
            })
        except Exception as exc:
            logger.exception("find_split_stay_flex tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def get_room_inventory(category: str) -> str:
        """
        Return per-room detail for one category across the full booking window.
        Call this when the guest asks which rooms are free, what prices are,
        which floors are available, or how long a room is occupied.

        Returns a list of rooms, each with:
          id, floor, base_rate, today_status (EMPTY/SOFT/HARD),
          timeline (20-day window: date → status),
          booked_until (last consecutive blocked date from today, if occupied),
          first_free (first EMPTY date).
        category must be one of: ECONOMY, STANDARD, STUDIO, DELUXE, PREMIUM, SUITE.
        """
        try:
            cat = RoomCategory(category.upper())
            today = date.today()
            window_end = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)

            # All active rooms for this category
            rooms_result = await db.execute(
                select(Room.id, Room.floor_number, Room.base_rate)
                .where(Room.category == cat, Room.is_active == True)
                .order_by(Room.floor_number, Room.id)
            )
            rooms = rooms_result.all()

            if not rooms:
                return json.dumps({"error": f"No active rooms in category {category}"})

            room_ids = [r[0] for r in rooms]

            # All slots in the booking window for these rooms
            slots_result = await db.execute(
                select(Slot.room_id, Slot.date, Slot.block_type, Slot.current_rate)
                .where(
                    Slot.room_id.in_(room_ids),
                    Slot.date >= today,
                    Slot.date < window_end,
                )
                .order_by(Slot.room_id, Slot.date)
            )
            # Build {room_id: {date: (block_type, rate)}}
            slot_map: dict[str, dict] = defaultdict(dict)
            for room_id, slot_date, block_type, rate in slots_result.all():
                slot_map[room_id][slot_date] = (block_type, rate)

            output = []
            all_dates = [today + timedelta(days=i)
                         for i in range(settings.BOOKING_WINDOW_DAYS)]

            for room_id, floor, base_rate in rooms:
                timeline = {}
                for d in all_dates:
                    bt, _ = slot_map[room_id].get(d, (BlockType.EMPTY, base_rate))
                    timeline[str(d)] = bt.value if hasattr(bt, "value") else str(bt)

                # today's status
                today_bt, today_rate = slot_map[room_id].get(
                    today, (BlockType.EMPTY, base_rate)
                )
                today_status = today_bt.value if hasattr(today_bt, "value") else str(today_bt)

                # booked_until: last consecutive non-EMPTY date from today
                booked_until = None
                first_free = str(today)
                if today_status != "EMPTY":
                    prev = today
                    for d in all_dates[1:]:
                        bt, _ = slot_map[room_id].get(d, (BlockType.EMPTY, base_rate))
                        status = bt.value if hasattr(bt, "value") else str(bt)
                        if status != "EMPTY":
                            prev = d
                        else:
                            break
                    booked_until = str(prev)
                    next_day = prev + timedelta(days=1)
                    first_free = str(next_day) if next_day < window_end else None
                else:
                    first_free = str(today)

                entry: dict = {
                    "id":           room_id,
                    "floor":        floor,
                    "base_rate":    base_rate,
                    "today_status": today_status,
                    "today_rate":   today_rate,
                    "timeline":     timeline,
                    "first_free":   first_free,
                }
                if booked_until:
                    entry["booked_until"] = booked_until

                output.append(entry)

            return json.dumps({"category": category, "rooms": output})
        except Exception as exc:
            logger.exception("get_room_inventory tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def probe_split_window(
        category: str,
        anchor_check_in: str,
        duration_nights: int,
    ) -> str:
        """
        Search for the nearest date window where a genuine split stay (2+ rooms,
        5–10% discount) is possible for this category.

        Tries the anchor dates then shifts check_in by ±1, ±2, ±3, ±4, ±5 days
        and returns the first window that yields SPLIT_POSSIBLE with 2+ segments.

        Use this when:
        - The guest asks about split stay discounts
        - find_split_stay returns NOT_POSSIBLE for the current dates
        - The guest asks "any date where split stay works?"

        Parameters
        ----------
        category        : room category (ECONOMY / STANDARD / STUDIO / DELUXE / PREMIUM / SUITE)
        anchor_check_in : the guest's preferred check_in date (YYYY-MM-DD)
        duration_nights : length of stay in nights (integer)

        Returns the first working window: state, segments, discount_pct, check_in, check_out.
        If nothing found within ±5 days, returns NOT_POSSIBLE with a message.
        """
        try:
            cat      = RoomCategory(category.upper())
            anchor   = date.fromisoformat(anchor_check_in)
            today_d  = date.today()

            # Try shifts: 0, -1, +1, -2, +2, -3, +3, -4, +4, -5, +5
            shifts = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]
            for delta in shifts:
                ci = anchor + timedelta(days=delta)
                co = ci + timedelta(days=duration_nights)
                if ci < today_d:
                    continue
                req = BookingRequestIn(
                    category   = cat,
                    check_in   = ci,
                    check_out  = co,
                    guest_name = "",
                )
                result = await ctrl.find_split_stay(req, db)
                if result.state == "SPLIT_POSSIBLE" and len(result.segments) >= 2:
                    return json.dumps({
                        "state":        "SPLIT_POSSIBLE",
                        "category":     category,
                        "check_in":     str(ci),
                        "check_out":    str(co),
                        "shift_days":   delta,
                        "discount_pct": result.discount_pct,
                        "total_nights": result.total_nights,
                        "total_rate":   result.total_rate,
                        "message":      result.message,
                        "segments": [
                            {
                                "room_id":         s.room_id,
                                "floor":           s.floor,
                                "check_in":        str(s.check_in),
                                "check_out":       str(s.check_out),
                                "nights":          s.nights,
                                "base_rate":       s.base_rate,
                                "discounted_rate": s.discounted_rate,
                            }
                            for s in result.segments
                        ],
                    })

            return json.dumps({
                "state":   "NOT_POSSIBLE",
                "message": (
                    f"No {category} split stay found within ±5 days of {anchor_check_in} "
                    f"for a {duration_nights}-night stay. The category may not have enough "
                    "rooms with the required gap pattern."
                ),
            })
        except Exception as exc:
            logger.exception("probe_split_window tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def get_revenue_intelligence() -> str:
        """
        Return a live revenue snapshot for the hotel — use this when the receptionist
        asks a general question, greets you, or there is no active booking in progress.

        Returns tonight's occupancy and ADR, per-category fill rates, orphan gap
        counts, upgrade availability, and week revenue on-books.

        Use the data to give a short (1–2 sentence) actionable insight:
        which category to push today, whether an upgrade is worth offering,
        or if a particular date is under pressure.
        """
        try:
            today = date.today()
            week_end = today + timedelta(days=7)
            scan_end = today + timedelta(days=20)

            # Active rooms
            all_rooms = (await db.execute(
                select(Room.id, Room.category, Room.base_rate)
                .where(Room.is_active == True)
            )).all()

            room_cats: dict[str, str] = {r[0]: r[1].value if hasattr(r[1], "value") else str(r[1]) for r in all_rooms}
            total_rooms = len(all_rooms)

            # Today's slots
            today_slots = (await db.execute(
                select(Slot.room_id, Slot.block_type, Slot.current_rate, Slot.channel)
                .join(Room, Room.id == Slot.room_id)
                .where(Room.is_active == True, Slot.date == today)
            )).all()

            cat_total: dict[str, int] = {}
            cat_booked: dict[str, int] = {}
            cat_rates: dict[str, list[float]] = {}
            tonight_occupied = 0
            tonight_rates: list[float] = []

            for r in all_rooms:
                cat = r[1].value if hasattr(r[1], "value") else str(r[1])
                cat_total[cat] = cat_total.get(cat, 0) + 1

            for s in today_slots:
                cat = room_cats.get(s.room_id, "UNKNOWN")
                if s.block_type != BlockType.EMPTY:
                    cat_booked[cat] = cat_booked.get(cat, 0) + 1
                    tonight_occupied += 1
                    tonight_rates.append(float(s.current_rate))
                    cat_rates.setdefault(cat, []).append(float(s.current_rate))

            tonight_occ_pct = round((tonight_occupied / max(1, total_rooms)) * 100, 1)
            tonight_adr = round(sum(tonight_rates) / len(tonight_rates), 0) if tonight_rates else 0.0

            # Per-category summary
            categories_summary = []
            for cat, total in sorted(cat_total.items()):
                booked = cat_booked.get(cat, 0)
                empty = total - booked
                occ_pct = round((booked / max(1, total)) * 100, 1)
                avg_rate = round(sum(cat_rates.get(cat, [])) / max(1, len(cat_rates.get(cat, []))), 0)
                categories_summary.append({
                    "category": cat,
                    "total_rooms": total,
                    "booked_tonight": booked,
                    "empty_tonight": empty,
                    "occ_pct": occ_pct,
                    "avg_rate_tonight": avg_rate,
                    "upgrade_available": empty > 0,
                })

            # Week revenue on-books
            week_slots = (await db.execute(
                select(Slot.current_rate, Slot.block_type)
                .join(Room, Room.id == Slot.room_id)
                .where(
                    Room.is_active == True,
                    Slot.date >= today,
                    Slot.date < week_end,
                    Slot.block_type != BlockType.EMPTY,
                )
            )).all()
            week_revenue = round(sum(float(s.current_rate) for s in week_slots), 0)
            week_booked_nights = len(week_slots)

            # Orphan gaps in next 20 days
            scan_slots = (await db.execute(
                select(Slot.room_id, Slot.date, Slot.block_type)
                .join(Room, Room.id == Slot.room_id)
                .where(
                    Room.is_active == True,
                    Slot.date >= today,
                    Slot.date < scan_end,
                )
                .order_by(Slot.room_id, Slot.date)
            )).all()

            by_room: dict[str, list] = {}
            for s in scan_slots:
                by_room.setdefault(s.room_id, []).append(s)

            orphan_nights = 0
            for room_id, rows in by_room.items():
                for i, row in enumerate(rows):
                    if row.block_type != BlockType.EMPTY:
                        continue
                    before = rows[i - 1].block_type if i > 0 else None
                    after  = rows[i + 1].block_type if i < len(rows) - 1 else None
                    if before not in (None, BlockType.EMPTY) and after not in (None, BlockType.EMPTY):
                        orphan_nights += 1

            # Recent pickup (last 7 days) — by category only (Booking has no channel column).
            # is_live is not filtered here: confirmed bookings have is_live=False by design,
            # so filtering by it would permanently zero out the pickup counter.
            cutoff = today - timedelta(days=7)
            recent_bookings = (await db.execute(
                select(Booking.room_category)
                .where(Booking.created_at >= cutoff)
            )).all()
            recent_by_cat: dict[str, int] = {}
            for b in recent_bookings:
                cat = b.room_category.value if hasattr(b.room_category, "value") else str(b.room_category)
                recent_by_cat[cat] = recent_by_cat.get(cat, 0) + 1

            # Channel breakdown from today's slots (Slot has channel column)
            channel_counts: dict[str, int] = {}
            for s in today_slots:
                ch = s.channel.value if s.channel and hasattr(s.channel, "value") else "OTA"
                channel_counts[ch] = channel_counts.get(ch, 0) + 1

            return json.dumps({
                "tonight": {
                    "occupancy_pct": tonight_occ_pct,
                    "adr": tonight_adr,
                    "occupied_rooms": tonight_occupied,
                    "total_rooms": total_rooms,
                },
                "categories": categories_summary,
                "week_revenue_on_books": week_revenue,
                "week_booked_nights": week_booked_nights,
                "orphan_nights_next_20_days": orphan_nights,
                "last_7_day_pickup_by_category": recent_by_cat,
                "tonight_channel_mix": channel_counts,
                "market_note": (
                    "Hotel is in Pune, India. Weekdays = corporate IT sector guests "
                    "(rate-inelastic). Weekends = leisure from Mumbai/Nashik (price-sensitive). "
                    "Peak: Oct-Feb wedding/conference season. Monsoon (Jun-Sep) slows leisure. "
                    "OTA pressure highest on Economy/Standard Mon-Thu."
                ),
            })
        except Exception as exc:
            logger.exception("get_revenue_intelligence tool error")
            return json.dumps({"error": str(exc)})

    # confirm_booking and confirm_split_stay are intentionally NOT tools.
    # The AI only recommends. All DB writes go through the receptionist's
    # confirm button in the UI — never triggered by the AI itself.

    tools = [check_availability, get_room_inventory, find_split_stay, find_split_stay_flex, probe_split_window, get_revenue_intelligence]

    # ── LLM ───────────────────────────────────────────────────────────────────

    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        google_api_key=settings.GEMINI_API_KEY,
        temperature=0.3,
        convert_system_message_to_human=True,   # Gemini doesn't natively support system role
    )
    llm_with_tools = llm.bind_tools(tools)

    # ── Graph nodes ───────────────────────────────────────────────────────────

    async def agent_node(state: AgentState) -> dict:
        all_messages = [system_msg] + state["messages"]
        response = await llm_with_tools.ainvoke(all_messages)
        # Carry forward action_data extracted from any tool results already in state
        action_data = _extract_action_data(state["messages"]) or state.get("action_data")
        return {"messages": [response], "action_data": action_data}

    tool_node = ToolNode(tools)

    def should_continue(state: AgentState) -> str:
        last = state["messages"][-1]
        if hasattr(last, "tool_calls") and last.tool_calls:
            return "tools"
        return END

    # ── Compile ───────────────────────────────────────────────────────────────

    g = StateGraph(AgentState)
    g.add_node("agent", agent_node)
    g.add_node("tools", tool_node)
    g.set_entry_point("agent")
    g.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    g.add_edge("tools", "agent")
    return g.compile()


# ── Public entry point ────────────────────────────────────────────────────────

async def run_agent(
    messages: list[dict],
    db: AsyncSession,
    hotel_context: str = "",
) -> dict:
    """
    Run the receptionist agent for one turn.

    Parameters
    ----------
    messages     : Full conversation history from frontend
                   [{ role: "user"|"assistant", content: str }, ...]
    db           : AsyncSession injected by FastAPI
    hotel_context: Live hotel summary (occupancy, floors, categories) from /ai/context

    Returns
    -------
    { reply: str, action_data: dict | None }
    reply       : AI text to display as the next assistant bubble
    action_data : Optional structured payload for frontend to render a rich card
    """
    today = date.today().isoformat()

    system_msg = SystemMessage(
        content=_SYSTEM.format(
            hotel_name=settings.HOTEL_NAME,
            today=today,
            context=hotel_context or "No live context provided.",
        )
    )

    graph = _build_graph(db, system_msg)
    lc_messages = _to_lc_messages(messages)

    # Guard: if history is empty the agent has nothing to respond to
    if not lc_messages:
        return {"reply": "How can I help you today?", "action_data": None}

    result = await graph.ainvoke(
        {"messages": lc_messages, "action_data": None}
    )

    final_msg = result["messages"][-1]
    raw_content = final_msg.content if hasattr(final_msg, "content") else ""

    # Gemini 2.5+ returns content as a list of typed blocks:
    #   [{"type": "text", "text": "..."}, ...]
    # Earlier models return a plain string. Handle both.
    if isinstance(raw_content, list):
        reply = " ".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in raw_content
        ).strip()
    else:
        reply = str(raw_content)

    action_data = _extract_action_data(result["messages"])

    return {"reply": reply, "action_data": action_data}
