"""
Receptionist AI Agent — LangGraph + Gemini

Architecture:
  - Stateless: frontend owns full conversation history, sends it on every request
  - LangGraph agentic loop: agent → tool_node → agent → ... → END
  - Poly AI endpoint via langchain-openai
  - 4 tools: check_availability, suggest_upgrade, get_room_inventory, get_revenue_intelligence
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
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
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
You are the AI revenue intelligence assistant (Concierge AI) for {hotel_name},
located in New Jersey, USA.
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

New Jersey hotel market context (use this for AI insights and pricing commentary):
- NJ sits between NYC and Philadelphia — strong corporate and drive-to leisure market.
  Weekday demand: pharma (J&J, Novartis, Sanofi), finance, and tech corporate travelers.
  Weekends: drive-to leisure from NYC, Long Island, and Philadelphia — price-sensitive.
- Seasonal peaks: May–Jun graduation season (Princeton, Rutgers — Suites fill fast),
  Jun–Aug NJ shore drive market, Sep–Nov NFL/MetLife season + fall conferences, Dec holidays.
- Key local events: Giants/Jets and concerts at MetLife Stadium (East Rutherford) — huge
  weekend demand spikes; NJ Convention & Expo Center (Edison) trade shows mid-week;
  Asbury Park summer concert series; Atlantic City casino conventions.
- NYC overflow: when NYC hotel rates spike above $400/night, NJ captures late-booking
  overflow (1–3 days out). Watch for sudden midnight pickup surges.
- OTA pressure: Expedia, Booking.com, Priceline dominate. Rate pressure highest on
  Standard Mon–Thu. Suites/Deluxe have fewer OTA competitors — hold and push direct.

Available room categories (lowest → highest): ECONOMY, STANDARD, STUDIO, DELUXE, PREMIUM, SUITE.

Current hotel snapshot (category-level — see tool for per-room detail):
{context}

── CORE RULE — tool calls ────────────────────────────────────────────────────
• For BOOKING requests: you MUST have BOTH an explicit category AND explicit
  check-in + check-out dates from the guest. Only then call check_availability
  or suggest_upgrade. Never call booking tools for greetings, general questions,
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

suggest_upgrade(preferred_category, check_in, check_out)
  → Call when check_availability returns NOT_POSSIBLE.
  → Checks all higher-tier categories for the same dates.
  → Uses live pricing intelligence (probability of selling) to decide discount:
      High probability (demand strong) → full rate, no discount.
      Low probability (demand soft)    → discount recommended.
  → Returns UPGRADE_AVAILABLE with category, room_id, discount_pct, pricing_reason.
  → Returns NO_UPGRADE if no higher category has rooms available.

get_room_inventory(category)
  → Call when the guest asks about floors, specific room IDs, or exact rates.
  → Do NOT call just to check booking feasibility — use check_availability.
  → After identifying a preferred room (by floor or ID), call
    check_room_availability(room_id, check_in, check_out) to get a confirmable card.

check_room_availability(room_id, check_in, check_out)
  → Call after get_room_inventory when the guest has a floor or room preference.
  → Checks that exact room's slots and returns a confirmable DIRECT_AVAILABLE card,
    or OCCUPIED if the room is blocked on any date in the range.
  → Do NOT use for general availability — use check_availability for that.

get_revenue_intelligence()
  → Call proactively when the receptionist asks a general question, greets you,
    or there is no active booking request in progress.
  → Returns: per-category occupancy %, orphan gap nights, upgrade availability,
    tonight ADR, week revenue on books, NJ market context hints.
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
• Reference NJ market context where relevant: corporate pharma/finance demand,
  MetLife events, graduation season, shore weekends, NYC overflow nights.
── ───────────────────────────────────────────────────────────────────────────

── Normal booking flow ───────────────────────────────────────────────────────
1. Collect category, check-in, check-out from conversation.
2. Call check_availability → produces action card.
3. DIRECT_AVAILABLE / SHUFFLE_POSSIBLE → one sentence + "Confirm with the button."
4. NOT_POSSIBLE →
   a. Call suggest_upgrade(same_category, same_dates).
      UPGRADE_AVAILABLE → present upgrade option.
      If discount_pct > 0: mention the discount and pricing_reason naturally.
      ("Deluxe is open for those dates — demand is softer so I'd offer it at 10% off.")
   b. NO_UPGRADE → call get_room_inventory(preferred_category), report earliest free window.
── ───────────────────────────────────────────────────────────────────────────

── [PREFS] mode ─────────────────────────────────────────────────────────────
Message starts with [PREFS] — the receptionist just toggled a checkbox to update
guest options. This is a preference acknowledgement ONLY. Do NOT call any booking
tools. Reply with exactly one short sentence confirming the updated option (e.g.
"Got it — nearby dates option is now on."). No card, no tool calls.
── ───────────────────────────────────────────────────────────────────────────

── [HANDOFF] mode ────────────────────────────────────────────────────────────
Message starts with [HANDOFF] — the deterministic engine confirmed the exact requested
dates are impossible in the preferred category. The message contains options.* flags.
YOU MUST READ EACH FLAG AND SKIP THE CORRESPONDING STEP IF IT IS FALSE.

Stop at the first step that returns an actionable result (DIRECT_AVAILABLE,
SHUFFLE_POSSIBLE, or UPGRADE_AVAILABLE). Never skip to a later step if an earlier one
already produced a card.

  [execute only if options.nearby_dates_pm1=true]
  STEP 1: check_availability(same_category, check_in + 1 day, same duration).
          Also try check_in - 1 day if STEP 1a fails. Stop if either is available.

  [execute only if options.different_category=true]
  STEP 2: Call suggest_upgrade(preferred_category, original_dates).
          This finds the best available higher-tier room and applies pricing intelligence.
          UPGRADE_AVAILABLE → present the upgrade + any discount the pricing engine set.
          Stop here.

  [always — if nothing above produced a card]
  STEP 3: get_room_inventory(preferred_category). Report the earliest free window. No card.

Do NOT call check_availability for the original preferred_category on the original dates —
the deterministic engine already confirmed that is impossible.
── ───────────────────────────────────────────────────────────────────────────

── Category independence rule ────────────────────────────────────────────────
A NOT_POSSIBLE result for one category means ONLY that category is fully blocked on
those dates. It says NOTHING about any other category. NEVER say "not available in
any category" unless you have called check_availability for every category and all
returned NOT_POSSIBLE. When a receptionist asks about other categories in follow-up
messages, call check_availability for the specific categories they mention — or for
ALL remaining categories (ECONOMY, STANDARD, STUDIO, PREMIUM, SUITE) if they say
"any other". Prior tool results for DELUXE do not apply to ECONOMY or SUITE.
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
• Reference NJ market context naturally — don't over-explain it.
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
      0. confirmed    — booking_confirmed
      1. actionable   — DIRECT_AVAILABLE, SHUFFLE_POSSIBLE, or UPGRADE_AVAILABLE
      2. informational— NOT_POSSIBLE (shows infeasible dates, no confirm button)

    Scanning in chronological order and keeping the highest-priority result means
    that if the AI calls check_availability(ECONOMY) → DIRECT_AVAILABLE and then
    check_availability(DELUXE) → NOT_POSSIBLE, the DIRECT_AVAILABLE card wins
    rather than being overwritten by the later NOT_POSSIBLE result.
    """
    confirmed: Optional[dict]  = None
    actionable: Optional[dict] = None
    not_possible: Optional[dict] = None

    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        try:
            data = json.loads(msg.content)
        except (json.JSONDecodeError, TypeError):
            continue

        if data.get("booking_id"):
            confirmed = {"type": "booking_confirmed", "data": data}
        elif data.get("state") in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
            # Keep the first actionable result; don't overwrite with a later NOT_POSSIBLE
            if actionable is None:
                actionable = {"type": "availability_result", "data": data}
        elif data.get("state") == "UPGRADE_AVAILABLE" and data.get("upgrades"):
            # Promote the best upgrade option to an actionable availability_result card.
            # Carries is_upgrade + discount fields so the frontend can display them.
            if actionable is None:
                best = data["upgrades"][0]
                actionable = {
                    "type": "availability_result",
                    "data": {
                        "state": best["state"],
                        "room_id": best["room_id"],
                        "swap_plan": best.get("swap_plan"),
                        "comparison": best.get("comparison"),
                        "request": best["request"],
                        "is_upgrade": True,
                        "upgrade_from": data["preferred_category"],
                        "discount_recommended": best.get("discount_recommended", False),
                        "discount_pct": best.get("discount_pct", 0.0),
                        "pricing_reason": best.get("pricing_reason", ""),
                        "prob_of_selling": best.get("prob_of_selling", ""),
                    },
                }
        elif data.get("state") == "NOT_POSSIBLE":
            not_possible = {"type": "availability_result", "data": data}

    return confirmed or actionable or not_possible


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
    async def check_room_availability(
        room_id: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        Check if a SPECIFIC room (by ID) is available for the given date range.
        Call this after get_room_inventory when the guest has expressed a floor
        or room preference — it returns a confirmable action card for that exact room.

        Returns DIRECT_AVAILABLE with a card the receptionist can confirm,
        or OCCUPIED with the date the room is blocked from.
        room_id: exact room ID from get_room_inventory (e.g. "D09", "S03")
        Dates must be ISO format: YYYY-MM-DD.
        """
        try:
            ci = date.fromisoformat(check_in)
            co = date.fromisoformat(check_out)

            room_result = await db.execute(
                select(Room.id, Room.category, Room.floor_number, Room.base_rate)
                .where(Room.id == room_id, Room.is_active == True)
            )
            room = room_result.first()
            if not room:
                return json.dumps({"error": f"Room {room_id} not found or inactive."})

            r_id, r_cat, r_floor, r_rate = room
            cat_str = r_cat.value if hasattr(r_cat, "value") else str(r_cat)

            stay_dates = [ci + timedelta(days=i) for i in range((co - ci).days)]

            slots_result = await db.execute(
                select(Slot.date, Slot.block_type)
                .where(
                    Slot.room_id == room_id,
                    Slot.date >= ci,
                    Slot.date < co,
                )
            )
            slot_map = {row.date: row.block_type for row in slots_result.all()}

            blocked = [
                d for d in stay_dates
                if slot_map.get(d, BlockType.EMPTY) != BlockType.EMPTY
            ]

            if not blocked:
                return json.dumps({
                    "state": "DIRECT_AVAILABLE",
                    "room_id": room_id,
                    "message": (
                        f"Room {room_id} (floor {r_floor}, {cat_str}, "
                        f"${int(r_rate)}/night) is available {check_in} to {check_out}."
                    ),
                    "swap_plan": None,
                    "comparison": None,
                    "infeasible_dates": [],
                    "alternatives": [],
                    "request": {
                        "category": cat_str,
                        "check_in": check_in,
                        "check_out": check_out,
                    },
                })

            return json.dumps({
                "state": "OCCUPIED",
                "room_id": room_id,
                "floor": r_floor,
                "message": (
                    f"Room {room_id} is not available — blocked from "
                    f"{min(blocked)}. Try another room on floor {r_floor}."
                ),
                "blocked_from": str(min(blocked)),
            })

        except Exception as exc:
            logger.exception("check_room_availability tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def suggest_upgrade(
        preferred_category: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        When check_availability returns NOT_POSSIBLE for the preferred category,
        find an available upgrade in the next higher-tier category.

        Uses pricing intelligence from the pricing engine (probability of selling)
        to decide whether to offer a discount on the upgrade:
        - High probability (INCREASE action / majority demand): full rate, no discount.
        - Low probability (DISCOUNT action / soft demand): recommend a discount.

        preferred_category must be one of: ECONOMY, STANDARD, STUDIO, DELUXE, PREMIUM, SUITE.
        Dates must be ISO format: YYYY-MM-DD.

        Returns UPGRADE_AVAILABLE with category, room_id, prob_of_selling,
        discount_recommended, discount_pct, pricing_reason.
        Returns NO_UPGRADE if no higher-tier room is available.
        """
        try:
            from core.models.pricing_recommendation import PricingRec

            cat_order = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "PREMIUM", "SUITE"]
            pref = preferred_category.upper()
            ci = date.fromisoformat(check_in)
            co = date.fromisoformat(check_out)

            if pref not in cat_order:
                return json.dumps({"error": f"Unknown category: {preferred_category}"})

            pref_idx = cat_order.index(pref)
            higher_categories = cat_order[pref_idx + 1:]

            if not higher_categories:
                return json.dumps({
                    "state": "NO_UPGRADE",
                    "preferred_category": pref,
                    "message": f"{pref} is already the highest tier — no upgrade available.",
                })

            # Date strings for pricing lookup
            stay_dates = [(ci + timedelta(days=i)).isoformat() for i in range((co - ci).days)]

            for cat in higher_categories:
                # Check if this category has a room available
                req = BookingRequestIn(
                    category=RoomCategory(cat),
                    check_in=ci,
                    check_out=co,
                    guest_name="",
                )
                avail = await ctrl.check_availability(req, db)
                if avail.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                    continue

                # Fetch pricing recs for this category + stay dates from pricing_recs table
                rec_ids = [f"{cat}_{d}" for d in stay_dates]
                recs_result = await db.execute(
                    select(
                        PricingRec.recommended_action,
                        PricingRec.confidence,
                        PricingRec.change_pct,
                    ).where(PricingRec.id.in_(rec_ids))
                )
                recs = recs_result.all()

                # Aggregate demand signal across stay dates
                total = len(recs)
                increase_days = sum(1 for r in recs if r.recommended_action == "INCREASE")
                discount_days = sum(1 for r in recs if r.recommended_action == "DISCOUNT")

                if total == 0 or increase_days >= total * 0.5:
                    # Strong or unknown demand — hold rate
                    prob_of_selling = "HIGH"
                    discount_pct = 0.0
                    pricing_reason = "High demand expected — upgrade offered at full rate."
                elif discount_days > total * 0.5:
                    # Soft demand — pricing engine recommends discount
                    prob_of_selling = "LOW"
                    soft_recs = [r for r in recs if r.recommended_action == "DISCOUNT"]
                    avg_drop = sum(abs(r.change_pct) for r in soft_recs) / max(1, len(soft_recs))
                    discount_pct = round(min(avg_drop, 20.0))
                    pricing_reason = (
                        f"Softer demand this period — {int(discount_pct)}% discount "
                        "recommended to secure the booking."
                    )
                else:
                    prob_of_selling = "MEDIUM"
                    discount_pct = 0.0
                    pricing_reason = "Moderate demand — upgrade offered at standard rate."

                comparison = avail.comparison if isinstance(avail.comparison, dict) else None

                return json.dumps({
                    "state": "UPGRADE_AVAILABLE",
                    "preferred_category": preferred_category,
                    "upgrades": [{
                        "category": cat,
                        "room_id": avail.room_id,
                        "state": avail.state,
                        "swap_plan": avail.swap_plan,
                        "comparison": comparison,
                        "prob_of_selling": prob_of_selling,
                        "discount_recommended": discount_pct > 0,
                        "discount_pct": discount_pct,
                        "pricing_reason": pricing_reason,
                        "request": {
                            "category": cat,
                            "check_in": check_in,
                            "check_out": check_out,
                        },
                    }],
                })

            return json.dumps({
                "state": "NO_UPGRADE",
                "preferred_category": preferred_category,
                "message": f"No higher-tier rooms available for {check_in}–{check_out}.",
            })

        except Exception as exc:
            logger.exception("suggest_upgrade tool error")
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
                    "Hotel is in New Jersey, USA. Weekdays = pharma/finance/tech corporate guests "
                    "(rate-inelastic). Weekends = drive-to leisure from NYC/Philadelphia (price-sensitive). "
                    "Peak: May-Jun graduation, Jun-Aug shore season, Sep-Nov MetLife/NFL. "
                    "NYC overflow drives late-booking surges when NYC rates exceed $400/night. "
                    "OTA pressure highest on Standard Mon-Thu (Expedia, Priceline flash deals)."
                ),
            })
        except Exception as exc:
            logger.exception("get_revenue_intelligence tool error")
            return json.dumps({"error": str(exc)})

    # confirm_booking and confirm_split_stay are intentionally NOT tools.
    # The AI only recommends. All DB writes go through the receptionist's
    # confirm button in the UI — never triggered by the AI itself.

    tools = [check_availability, check_room_availability, suggest_upgrade, get_room_inventory, get_revenue_intelligence]

    # ── LLM ───────────────────────────────────────────────────────────────────

    llm = ChatOpenAI(
        model="auto",
        openai_api_base=settings.POLYAI_API_BASE,
        openai_api_key=settings.POLYAI_API_KEY,
        temperature=0.3,
    )
    llm_with_tools = llm.bind_tools(tools)

    # ── Graph nodes ───────────────────────────────────────────────────────────

    async def agent_node(state: AgentState) -> dict:
        all_messages = [system_msg] + state["messages"]
        response = await llm_with_tools.ainvoke(all_messages)
        # Carry forward action_data extracted from any tool results already in state
        action_data = _extract_action_data(state["messages"]) or state.get("action_data")
        return {"messages": [response], "action_data": action_data}

    # Sequential tool executor — all tools share one AsyncSession; ToolNode's
    # default asyncio.gather would cause SQLAlchemy "concurrent operations" errors.
    tool_map = {t.name: t for t in tools}

    async def tool_node(state: AgentState) -> dict:
        last = state["messages"][-1]
        tool_messages: list[BaseMessage] = []
        for tc in last.tool_calls:
            fn = tool_map.get(tc["name"])
            if fn is None:
                tool_messages.append(ToolMessage(
                    content=json.dumps({"error": f"Unknown tool: {tc['name']}"}),
                    tool_call_id=tc["id"],
                ))
                continue
            try:
                result = await fn.ainvoke(tc["args"])
            except Exception as exc:
                result = json.dumps({"error": str(exc)})
            tool_messages.append(ToolMessage(content=result, tool_call_id=tc["id"]))
        return {"messages": tool_messages, "action_data": state.get("action_data")}

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

    # Poly AI returns content as a list of typed blocks:
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
