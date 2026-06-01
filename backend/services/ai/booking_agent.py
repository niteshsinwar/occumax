from __future__ import annotations
"""
Booking AI Agent — LangGraph + Gemini

Architecture:
  - Stateless: frontend owns full conversation history, sends it on every request
  - LangGraph agentic loop: agent → tool_node → agent → ... → END
  - Poly AI endpoint via langchain-openai
  - tools: availability, split-stay, upgrade, inventory, and revenue intelligence
  - action_data: structured payload returned alongside text reply for frontend cards
"""


import json
import logging
import operator
import re
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
from langgraph.errors import GraphRecursionError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from controllers import booking as ctrl
from core.models import Room, Slot, Booking
from core.models.enums import BlockType, RoomCategory
from core.schemas import BookingRequestIn

logger = logging.getLogger(__name__)

_CATEGORY_ORDER = ["ECONOMY", "STANDARD", "DELUXE", "SUITE"]
MAX_AGENT_TOOL_CALLS = 10


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are the Stay Assistant for {hotel_name}.
Today is {today}.

You help guests find and book rooms on the hotel website.
Be warm, brief, and helpful. Speak like a friendly concierge — not a report.

═══ WHAT YOU NEVER EXPOSE TO THE GUEST ═══════════════════════════════════════
• Room IDs, booking IDs, floor numbers
• Occupancy rates, RevPAR, ADR, orphan gaps, pricing signals
• Why prices are set the way they are (demand, conferences, events, market)
• Why discounts are or aren't offered
• Internal reasoning about which option is "better for revenue"
• Failed checks, blocked dates detail, swap plans, internal rationale
• Tool names, JSON, graph steps, or any backend terminology

You use all this data internally to pick the best options.
You NEVER share any of it with the guest.
═════════════════════════════════════════════════════════════════════════════════

Room categories (lowest → highest): ECONOMY, STANDARD, DELUXE, SUITE.

Hotel snapshot:
{context}

═══ TOOLS (use internally, never mention tool names to guest) ════════════════
check_availability(category, check_in, check_out)
  → Check if a room is available. Needs category + dates from guest first.

suggest_upgrade(preferred_category, check_in, check_out)
  → Find a higher-tier room when the requested one isn't available.

get_room_inventory(category)
  → Look up room details when guest asks about floors or specific rooms.

check_room_availability(room_id, check_in, check_out)
  → Check a specific room after guest picks one from inventory.

find_split_stay(category, check_in, check_out)
  → Find a way to cover all nights using 2+ rooms in the same category.

find_split_stay_flex(preferred_category, check_in, check_out)
  → Find a way to cover all nights using rooms across categories.

explore_recovery_options(preferred_category, check_in, check_out, infeasible_dates_csv="")
  → One-shot tool that finds ALL alternatives when exact booking fails.
    Call this once in [HANDOFF] mode. It returns everything you need.

search_best_alternative_category(preferred_category, check_in, check_out)
  → Find the best room in a different category for the same dates.

get_revenue_intelligence()
  → Get hotel info for general questions. Do NOT call during active booking.

build_recovery_options(preferred_category, check_in, check_out, infeasible_dates_csv="")
  → Last resort for shortened stays. Only after all other tools tried.
═════════════════════════════════════════════════════════════════════════════════

═══ RULES ════════════════════════════════════════════════════════════════════
• Need BOTH category AND dates before calling any booking tool.
• Call ONE tool at a time.
• You only recommend — guest confirms via UI button.
• For greetings/general questions: reply in 1–2 sentences, no tools needed.
═════════════════════════════════════════════════════════════════════════════════

═══ HOW TO PRESENT OPTIONS ═══════════════════════════════════════════════════
When you have multiple options, present a SHORT numbered list (2–3 max).
Each option = ONE line with: name, dates, price.
That's it. No reasoning. No "because demand is high". No "this preserves category".

GOOD example:
  "Here are your options:
   1. Split Stay (Deluxe) — Jun 1–4, $1,710. 5% discount.
   2. Suite — Jun 1–4, $3,150. One room, no moves.
   3. Deluxe — Jun 1–3, $1,300. 2 nights.
   Which works best?"

BAD example (NEVER do this):
  "The split stay preserves your preferred category with minimal disruption
   and the 5% discount is applied because demand is moderate this week..."
═════════════════════════════════════════════════════════════════════════════════

═══ [PREFS] MODE ═════════════════════════════════════════════════════════════
Message starts with [PREFS] → guest toggled a preference.
Reply with ONE short sentence confirming. No tools.
═════════════════════════════════════════════════════════════════════════════════

═══ [HANDOFF] MODE ═══════════════════════════════════════════════════════════
Message starts with [HANDOFF] → the requested dates are unavailable.
1. Call explore_recovery_options once.
2. Present the top 2–3 options as a clean numbered list.
3. The best option's action card appears below your message automatically.
4. End with: "Which works best for your stay?"

Do NOT re-check the original dates — they're already confirmed impossible.
═════════════════════════════════════════════════════════════════════════════════

═══ FOLLOW-UPS ═══════════════════════════════════════════════════════════════
Previous messages may contain [STRUCTURED_STATE] JSON with option details.
Use it to handle "I like option 2" or "I don't want option 1" requests.
Never invent options from memory — use stored data or call tools again.
═════════════════════════════════════════════════════════════════════════════════

═══ VOICE ════════════════════════════════════════════════════════════════════
• Never start with "I" — lead with the info.
• No markdown headers, no tables, no bullet points in chat.
• Keep it conversational and brief. 2 lines max per option.
• Vary openers: "Here's what I found —", "Great news —", "A few options —"
═════════════════════════════════════════════════════════════════════════════════
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
        elif data.get("state") == "SPLIT_POSSIBLE" and data.get("segments"):
            if actionable is None:
                actionable = {"type": "split_stay_result", "data": data}
        elif data.get("state") == "RECOVERY_MENU":
            if actionable is None:
                actionable = {"type": "recovery_menu", "data": data}
        elif data.get("state") == "RECOVERY_OPTIONS" and data.get("options"):
            if actionable is None:
                actionable = {"type": "recovery_options", "data": data}
        elif data.get("state") == "NOT_POSSIBLE":
            not_possible = {"type": "availability_result", "data": data}

    return confirmed or actionable or not_possible


def _reply_for_action_data(action_data: dict) -> Optional[str]:
    """Deterministic fallback when the model tries to keep calling tools."""
    kind = action_data.get("type")
    data = action_data.get("data", {})

    if kind == "split_stay_result":
        segments = data.get("segments") or []
        if data.get("state") == "SPLIT_POSSIBLE" and segments:
            return "Found a split-stay option for the requested dates. Confirm with the button below when ready."

    if kind == "availability_result":
        state = data.get("state")
        request = data.get("request") or {}
        category = request.get("category", "the requested category")
        if state == "DIRECT_AVAILABLE":
            room_id = data.get("room_id")
            return f"Good news — room {room_id} in {category} is available with no rearrangement. Confirm with the button below when ready."
        if state == "SHUFFLE_POSSIBLE":
            room_id = data.get("room_id")
            return f"{category} can be recovered via room rearrangement, with room {room_id} available for this guest. Confirm with the button below when ready."
        if state == "UPGRADE_AVAILABLE":
            room_id = data.get("room_id")
            discount = data.get("discount_pct", 0)
            discount_text = f" with a {discount}% discount" if discount else ""
            return f"Found an upgrade option in room {room_id}{discount_text}. Confirm with the button below when ready."
        if state == "NOT_POSSIBLE":
            return data.get("message") or "No confirmable option is available under the current constraints."

    if kind == "recovery_options":
        options = data.get("options") or []
        if options:
            lead = options[0]
            return (
                f"Exact full-stay inventory is not available, but I found recovery offers. "
                f"Best option: {lead.get('title')} from {lead.get('check_in', 'flexible')} "
                f"to {lead.get('check_out', 'flexible')}. Review the options below with the guest."
            )

    if kind == "recovery_menu":
        options = data.get("options") or []
        if options:
            lead = options[0]
            return (
                f"Found {len(options)} recovery options. Lead with option "
                f"{lead.get('display_rank', 1)}: {lead.get('title', 'best available option')}. "
                "Review the recovery menu below and choose the best fit for the guest."
            )

    return None


def _sanitize_reply(reply: str) -> str:
    """Keep public booking assistant text customer-safe."""
    cleaned = (
        reply.replace("**", "")
        .replace("__", "")
        .replace("`", "")
        .strip()
    )
    replacements = {
        r"\bRoom\s+[A-Z]{1,4}\d{1,5}\b": "A matching room",
        r"\b[A-Z]{1,4}\d{2,5}\b": "a matching room",
        r"\bthis guest\b": "your stay",
        r"\bthe guest\b": "you",
        r"\bguest\b": "you",
        r"\bRevPAR\b": "stay value",
        r"\bpricing engine\b": "current booking conditions",
        r"\boccupancy\b": "availability",
        r"\borphan gaps?\b": "short availability gaps",
        r"\bhard-blocked\b": "unavailable",
        r"\bsoft-blocked\b": "reserved",
        r"\bsoft blocks?\b": "reservations",
        r"\btool calls?\b": "checks",
    }
    for pattern, replacement in replacements.items():
        cleaned = re.sub(pattern, replacement, cleaned, flags=re.IGNORECASE)
    return cleaned


def _is_actionable_action_data(action_data: Optional[dict]) -> bool:
    if not action_data:
        return False
    kind = action_data.get("type")
    data = action_data.get("data", {})
    if kind == "split_stay_result":
        return data.get("state") == "SPLIT_POSSIBLE" and bool(data.get("segments"))
    if kind == "availability_result":
        return data.get("state") in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE", "UPGRADE_AVAILABLE")
    if kind == "recovery_options":
        return data.get("state") == "RECOVERY_OPTIONS" and bool(data.get("options"))
    if kind == "recovery_menu":
        return data.get("state") == "RECOVERY_MENU" and bool(data.get("options"))
    return kind in ("booking_confirmed", "split_stay_confirmed")


def _availability_payload(result, category: str, check_in: str, check_out: str) -> dict:
    comparison = result.comparison if isinstance(result.comparison, dict) else None
    return {
        "state": result.state,
        "room_id": result.room_id,
        "message": result.message,
        "swap_plan": result.swap_plan,
        "comparison": comparison,
        "infeasible_dates": result.infeasible_dates,
        "alternatives": [
            (a.model_dump() if hasattr(a, "model_dump") else a)
            for a in (result.alternatives or [])
        ],
        "request": {
            "category": category.upper(),
            "check_in": check_in,
            "check_out": check_out,
        },
    }


def _split_payload(result, category: str, check_in: str, check_out: str) -> dict:
    payload = result.model_dump(mode="json")
    payload["category"] = category.upper()
    payload["request"] = {
        "category": category.upper(),
        "check_in": check_in,
        "check_out": check_out,
    }
    return payload


async def _pricing_signal(
    db: AsyncSession,
    category: str,
    check_in: date,
    check_out: date,
) -> dict:
    """Summarize pricing_recs for ranking recovery options."""
    try:
        from core.models.pricing_recommendation import PricingRec

        recs_result = await db.execute(
            select(
                PricingRec.recommended_action,
                PricingRec.confidence,
                PricingRec.change_pct,
                PricingRec.reasoning,
            ).where(
                PricingRec.category == category,
                PricingRec.date >= check_in,
                PricingRec.date < check_out,
            )
        )
        recs = recs_result.all()
    except Exception:
        recs = []

    if not recs:
        return {
            "action": "UNKNOWN",
            "confidence": "LOW",
            "score": 2.0,
            "discount_pct": 0.0,
            "reason": "No pricing recommendation exists for this stay window.",
        }

    action_counts: dict[str, int] = {}
    confidence_counts: dict[str, int] = {}
    score = 0.0
    discount_changes: list[float] = []
    reasons: list[str] = []

    for rec in recs:
        action_counts[rec.recommended_action] = action_counts.get(rec.recommended_action, 0) + 1
        confidence_counts[rec.confidence] = confidence_counts.get(rec.confidence, 0) + 1
        if rec.recommended_action == "DISCOUNT":
            score += 12.0
            discount_changes.append(abs(float(rec.change_pct)))
        elif rec.recommended_action == "MAINTAIN":
            score += 5.0
        elif rec.recommended_action == "INCREASE":
            score += 1.0
        if rec.confidence == "HIGH":
            score += 2.0
        elif rec.confidence == "LOW":
            score -= 1.0
        if rec.reasoning and len(reasons) < 2:
            reasons.append(str(rec.reasoning)[:140])

    top_action = max(action_counts, key=action_counts.get)
    top_confidence = max(confidence_counts, key=confidence_counts.get)
    discount_pct = round(min(sum(discount_changes) / max(1, len(discount_changes)), 20.0)) if discount_changes else 0.0
    return {
        "action": top_action,
        "confidence": top_confidence,
        "score": round(score / max(1, len(recs)), 2),
        "discount_pct": discount_pct,
        "reason": " ".join(reasons) or f"{top_action} pricing signal across the stay.",
    }


async def _longest_free_runs(
    db: AsyncSession,
    category: str,
    check_in: date,
    check_out: date,
    limit: int = 3,
) -> list[dict]:
    cat = RoomCategory(category.upper())
    rooms_result = await db.execute(
        select(Room.id, Room.floor_number, Room.base_rate)
        .where(Room.category == cat, Room.is_active == True)
        .order_by(Room.floor_number, Room.id)
    )
    rooms = rooms_result.all()
    if not rooms:
        return []

    room_ids = [room_id for room_id, _, _ in rooms]
    slots_result = await db.execute(
        select(Slot.room_id, Slot.date, Slot.block_type)
        .where(
            Slot.room_id.in_(room_ids),
            Slot.date >= check_in,
            Slot.date < check_out,
        )
    )
    slot_map: dict[str, dict[date, BlockType]] = defaultdict(dict)
    for room_id, slot_date, block_type in slots_result.all():
        slot_map[room_id][slot_date] = block_type

    runs: list[dict] = []
    for room_id, floor, base_rate in rooms:
        cur = check_in
        while cur < check_out:
            if slot_map[room_id].get(cur, BlockType.EMPTY) != BlockType.EMPTY:
                cur += timedelta(days=1)
                continue
            start = cur
            while cur < check_out and slot_map[room_id].get(cur, BlockType.EMPTY) == BlockType.EMPTY:
                cur += timedelta(days=1)
            runs.append({
                "room_id": room_id,
                "floor": floor,
                "check_in": str(start),
                "check_out": str(cur),
                "nights": (cur - start).days,
                "base_rate": float(base_rate),
            })

    return sorted(runs, key=lambda item: (item["nights"], item["base_rate"]), reverse=True)[:limit]


async def _build_recovery_options(
    db: AsyncSession,
    preferred_category: str,
    check_in: date,
    check_out: date,
    attempts: list[str],
    infeasible_dates: list[str],
) -> dict:
    nights = max(1, (check_out - check_in).days)
    options: list[dict] = []

    preferred_signal = await _pricing_signal(db, preferred_category, check_in, check_out)
    discount_pct = float(preferred_signal["discount_pct"]) if preferred_signal["action"] == "DISCOUNT" else 0.0

    preferred_runs = await _longest_free_runs(db, preferred_category, check_in, check_out, limit=4)
    for idx, run in enumerate(preferred_runs):
        discounted_rate = round(run["base_rate"] * (1 - discount_pct / 100), 2)
        options.append({
            "kind": "SHORTEN_STAY",
            "priority": "BEST" if idx == 0 else "GOOD",
            "title": f"Shorten in {preferred_category}: {run['nights']} nights",
            "category": preferred_category,
            "room_id": run["room_id"],
            "check_in": run["check_in"],
            "check_out": run["check_out"],
            "nights": run["nights"],
            "discount_pct": discount_pct,
            "estimated_total": round(run["nights"] * discounted_rate, 2),
            "rationale": (
                f"Enjoy a shorter stay in your preferred {preferred_category} room. "
                f"Covers {run['nights']} of {nights} requested nights."
            ),
        })

    adjacent_categories = [
        cat for cat in _CATEGORY_ORDER
        if cat != preferred_category
    ]
    adjacent_categories.sort(key=lambda cat: (
        abs(_CATEGORY_ORDER.index(cat) - _CATEGORY_ORDER.index(preferred_category)),
        0 if _CATEGORY_ORDER.index(cat) > _CATEGORY_ORDER.index(preferred_category) else 1,
    ))

    for cat in adjacent_categories[:3]:
        runs = await _longest_free_runs(db, cat, check_in, check_out, limit=1)
        if not runs:
            continue
        run = runs[0]
        signal = await _pricing_signal(db, cat, check_in, check_out)
        cat_discount = float(signal["discount_pct"]) if signal["action"] == "DISCOUNT" else 0.0
        discounted_rate = round(run["base_rate"] * (1 - cat_discount / 100), 2)
        preferred_best_nights = preferred_runs[0]["nights"] if preferred_runs else 0
        options.append({
            "kind": "CATEGORY_FRAGMENT",
            "priority": "GOOD" if run["nights"] >= preferred_best_nights else "ALT",
            "title": f"Alternative category fragment: {cat}",
            "category": cat,
            "room_id": run["room_id"],
            "check_in": run["check_in"],
            "check_out": run["check_out"],
            "nights": run["nights"],
            "discount_pct": cat_discount,
            "estimated_total": round(run["nights"] * discounted_rate, 2),
            "pricing_action": signal["action"],
            "rationale": (
                f"A great alternative available for {run['nights']} nights in a {cat} room."
            ),
        })

    if preferred_runs:
        options.append({
            "kind": "POLICY_EXCEPTION",
            "priority": "ASK",
            "title": "Manager override: allow more room moves",
            "category": preferred_category,
            "nights": nights,
            "discount_pct": 10.0,
            "estimated_total": None,
            "rationale": (
                "We can cover your full stay if you're willing to change rooms a few times."
            ),
        })

    options.append({
        "kind": "CHANGE_CONSTRAINT",
        "priority": "ASK",
        "title": "Ask for one constraint change",
        "category": preferred_category,
        "nights": nights,
        "discount_pct": discount_pct,
        "estimated_total": None,
        "rationale": (
            "Let us know if your dates are flexible, or if you'd be open to trying a different room style."
        ),
    })

    options = sorted(
        options,
        key=lambda item: (
            {"BEST": 0, "GOOD": 1, "ALT": 2, "ASK": 3}.get(str(item.get("priority")), 9),
            -int(item.get("nights") or 0),
        ),
    )[:6]

    lead = options[0] if options else None
    summary = (
        f"Exact {preferred_category} for all {nights} nights is not recoverable under current rules. "
    )
    if lead:
        summary += (
            f"Best proactive offer: {lead['title']} from {lead.get('check_in', 'flexible')} "
            f"to {lead.get('check_out', 'flexible')}."
        )
    else:
        summary += "No partial inventory fragments were found; ask for a date or category change."

    return {
        "reply": summary,
        "action_data": {
            "type": "recovery_options",
            "data": {
                "state": "RECOVERY_OPTIONS",
                "preferred_category": preferred_category,
                "check_in": str(check_in),
                "check_out": str(check_out),
                "requested_nights": nights,
                "infeasible_dates": infeasible_dates,
                "pricing_signal": preferred_signal,
                "options": options,
                "attempts": attempts,
            },
        },
    }


# ── Agent state ───────────────────────────────────────────────────────────────

class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], operator.add]
    action_data: Optional[dict]
    tool_count: int


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
        category must be one of: ECONOMY, STANDARD, DELUXE, SUITE.
        Dates must be ISO format: YYYY-MM-DD.
        """
        try:
            req = BookingRequestIn(
                category=RoomCategory(category.upper()),
                check_in=date.fromisoformat(check_in),
                check_out=date.fromisoformat(check_out),
                guest_name="Direct Guest",
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
                # everything needed to call /booking/confirm without
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
        category must be one of: ECONOMY, STANDARD, DELUXE, SUITE.
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

        Returns DIRECT_AVAILABLE with a card the booking can confirm,
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

        preferred_category must be one of: ECONOMY, STANDARD, DELUXE, SUITE.
        Dates must be ISO format: YYYY-MM-DD.

        Returns UPGRADE_AVAILABLE with category, room_id, prob_of_selling,
        discount_recommended, discount_pct, pricing_reason.
        Returns NO_UPGRADE if no higher-tier room is available.
        """
        try:
            from core.models.pricing_recommendation import PricingRec

            cat_order = ["ECONOMY", "STANDARD", "DELUXE", "SUITE"]
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
                    guest_name="Direct Guest",
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
    async def find_split_stay(
        category: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        Find a same-category split stay for the full requested date range.
        Call this when a continuous room is impossible but the guest may accept
        one or two room moves to preserve the preferred category.
        Returns SPLIT_POSSIBLE with confirmable segments, or NOT_POSSIBLE.
        """
        try:
            req = BookingRequestIn(
                category=RoomCategory(category.upper()),
                check_in=date.fromisoformat(check_in),
                check_out=date.fromisoformat(check_out),
                guest_name="Direct Guest",
            )
            result = await ctrl.find_split_stay(req, db)
            payload = result.model_dump(mode="json")
            payload["category"] = category.upper()
            payload["request"] = {
                "category": category.upper(),
                "check_in": check_in,
                "check_out": check_out,
            }
            return json.dumps(payload)
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
        Find a mixed-category split stay for the full requested date range.
        Call after same-category split stay fails and mixed category movement is
        acceptable. Returns SPLIT_POSSIBLE with confirmable segments, or NOT_POSSIBLE.
        """
        try:
            req = BookingRequestIn(
                category=RoomCategory(preferred_category.upper()),
                check_in=date.fromisoformat(check_in),
                check_out=date.fromisoformat(check_out),
                guest_name="Direct Guest",
            )
            result = await ctrl.find_split_stay_flex(req, db)
            payload = result.model_dump(mode="json")
            payload["category"] = preferred_category.upper()
            payload["request"] = {
                "category": preferred_category.upper(),
                "check_in": check_in,
                "check_out": check_out,
            }
            return json.dumps(payload)
        except Exception as exc:
            logger.exception("find_split_stay_flex tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def explore_recovery_options(
        preferred_category: str,
        check_in: str,
        check_out: str,
        infeasible_dates_csv: str = "",
    ) -> str:
        """
        Build a complete booking-ready recovery menu for a failed exact booking.

        Use this when a handoff arrives, exact availability is NOT_POSSIBLE, or the
        booking asks for all options/alternatives. It checks same-category split,
        mixed-category split recommendation, upgrade, best alternative category, nearby
        date shifts, and shortened fragments in one backend pass.

        Returns RECOVERY_MENU with all options, failed paths, rankings, pricing signals,
        and a primary confirmable action card. Mixed-category split stays are returned
        as recommendations only until the core split-confirm category bug is fixed.
        """
        try:
            pref = preferred_category.upper()
            if pref not in _CATEGORY_ORDER:
                return json.dumps({"error": f"Unknown category: {preferred_category}"})

            ci = date.fromisoformat(check_in)
            co = date.fromisoformat(check_out)
            if co <= ci:
                return json.dumps({"error": "check_out must be after check_in"})

            nights = (co - ci).days
            failures: list[dict] = []
            options: list[dict] = []

            async def add_room_rate(option: dict, room_id: Optional[str], category: str, start: date, end: date) -> None:
                if not room_id:
                    return
                row = (await db.execute(
                    select(Room.base_rate, Room.floor_number)
                    .where(Room.id == room_id, Room.is_active == True)
                )).first()
                if not row:
                    return
                base_rate, floor = row
                signal = await _pricing_signal(db, category, start, end)
                discount_pct = float(signal["discount_pct"]) if signal["action"] == "DISCOUNT" else 0.0
                rate = round(float(base_rate) * (1 - discount_pct / 100), 2)
                option["floor"] = floor
                option["base_rate"] = float(base_rate)
                option["discount_pct"] = discount_pct
                option["estimated_total"] = round(rate * max(1, (end - start).days), 2)
                option["pricing_signal"] = signal

            def add_failure(path: str, detail: str) -> None:
                failures.append({"path": path, "detail": detail})

            # 1. Same-category split: confirmable and usually the best guest-fit fallback.
            same_req = BookingRequestIn(
                category=RoomCategory(pref),
                check_in=ci,
                check_out=co,
                guest_name="Direct Guest",
            )
            same_split = await ctrl.find_split_stay(same_req, db)
            same_payload = _split_payload(same_split, pref, check_in, check_out)
            if same_payload.get("state") == "SPLIT_POSSIBLE" and same_payload.get("segments"):
                options.append({
                    "kind": "SAME_CATEGORY_SPLIT",
                    "rank": 10,
                    "title": f"Split Stay ({pref})",
                    "category": pref,
                    "segments": same_payload["segments"],
                    "discount_pct": same_payload.get("discount_pct", 0),
                    "estimated_total": same_payload.get("total_rate"),
                    "confirmable": True,
                    "action_data": {"type": "split_stay_result", "data": same_payload},
                    "rationale": "Stay in your preferred room style for the entire trip, with just a brief room change midway.",
                })
            else:
                add_failure("Same-category split", same_payload.get("message") or "Not possible.")

            # 2. Mixed split: useful for booking talk-track, but not confirmable yet.
            flex_split = await ctrl.find_split_stay_flex(same_req, db)
            flex_payload = _split_payload(flex_split, pref, check_in, check_out)
            if flex_payload.get("state") == "SPLIT_POSSIBLE" and flex_payload.get("segments"):
                segment_categories = {
                    str(seg.get("category") or pref).upper()
                    for seg in flex_payload.get("segments", [])
                    if isinstance(seg, dict)
                }
                is_mixed = len(segment_categories) > 1
                options.append({
                    "kind": "MIXED_CATEGORY_SPLIT" if is_mixed else "SAME_CATEGORY_SPLIT",
                    "rank": 60 if is_mixed else 11,
                    "title": "Mixed Category Split" if is_mixed else f"Split Stay ({pref})",
                    "category": pref,
                    "segments": flex_payload["segments"],
                    "discount_pct": flex_payload.get("discount_pct", 0),
                    "estimated_total": flex_payload.get("total_rate"),
                    "confirmable": not is_mixed,
                    "action_data": None if is_mixed else {"type": "split_stay_result", "data": flex_payload},
                    "rationale": (
                        "We can mix room styles to cover your dates if you don't mind switching."
                        if is_mixed else
                        "Stay in your preferred room style for the entire trip, with just a brief room change midway."
                    ),
                })
            else:
                add_failure("Mixed-category split", flex_payload.get("message") or "Not possible.")

            # 3. Upgrades: full stay, no room move, usually strongest revenue path.
            pref_idx = _CATEGORY_ORDER.index(pref)
            upgrade_found = False
            for cat in _CATEGORY_ORDER[pref_idx + 1:]:
                req = BookingRequestIn(
                    category=RoomCategory(cat),
                    check_in=ci,
                    check_out=co,
                    guest_name="Direct Guest",
                )
                result = await ctrl.check_availability(req, db)
                if result.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                    continue
                payload = _availability_payload(result, cat, check_in, check_out)
                signal = await _pricing_signal(db, cat, ci, co)
                opt = {
                    "kind": "UPGRADE",
                    "rank": 20 if signal["action"] in ("INCREASE", "UNKNOWN") else 70,
                    "title": f"Upgrade to {cat}",
                    "category": cat,
                    "room_id": result.room_id,
                    "state": result.state,
                    "confirmable": True,
                    "action_data": {"type": "availability_result", "data": {
                        **payload,
                        "is_upgrade": True,
                        "upgrade_from": pref,
                        "discount_recommended": signal["action"] == "DISCOUNT",
                        "discount_pct": signal["discount_pct"] if signal["action"] == "DISCOUNT" else 0.0,
                        "pricing_reason": signal["reason"],
                        "prob_of_selling": "LOW" if signal["action"] == "DISCOUNT" else "HIGH",
                    }},
                    "rationale": (
                        "Enjoy a seamless stay with no room moves in a premium upgraded room."
                        if signal["action"] != "DISCOUNT"
                        else "Enjoy a seamless stay with no room moves in a premium upgraded room, offered at a special rate."
                    ),
                }
                await add_room_rate(opt, result.room_id, cat, ci, co)
                options.append(opt)
                upgrade_found = True
                break
            if not upgrade_found:
                add_failure("Upgrade", "No higher category can cover the full stay.")

            # 4. Alternatives: same dates, lower/nearby categories.
            alt_candidates = [cat for cat in _CATEGORY_ORDER if cat != pref]
            alt_candidates.sort(key=lambda cat: (
                abs(_CATEGORY_ORDER.index(cat) - pref_idx),
                0 if _CATEGORY_ORDER.index(cat) > pref_idx else 1,
            ))
            alt_found = False
            for cat in alt_candidates:
                req = BookingRequestIn(
                    category=RoomCategory(cat),
                    check_in=ci,
                    check_out=co,
                    guest_name="Direct Guest",
                )
                result = await ctrl.check_availability(req, db)
                if result.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                    continue
                signal = await _pricing_signal(db, cat, ci, co)
                payload = _availability_payload(result, cat, check_in, check_out)
                opt = {
                    "kind": "ALTERNATIVE_CATEGORY",
                    "rank": 40 + abs(_CATEGORY_ORDER.index(cat) - pref_idx),
                    "title": f"Alternative {cat}",
                    "category": cat,
                    "room_id": result.room_id,
                    "state": result.state,
                    "confirmable": True,
                    "action_data": {"type": "availability_result", "data": payload},
                    "rationale": (
                        f"A great alternative available for your exact dates."
                    ),
                }
                await add_room_rate(opt, result.room_id, cat, ci, co)
                options.append(opt)
                alt_found = True
                break
            if not alt_found:
                add_failure("Alternative category", "No other category can cover the full stay.")

            # 5. Date shifts and shortened stay in the requested category.
            shift_later_ci = ci + timedelta(days=1)
            shift_later_co = co + timedelta(days=1)
            shift_checks = [("DATE_SHIFT_LATER", shift_later_ci, shift_later_co)]
            if ci - timedelta(days=1) >= date.today():
                shift_checks.append(("DATE_SHIFT_EARLIER", ci - timedelta(days=1), co - timedelta(days=1)))
            shift_checks.append(("SHORTEN_BY_ONE_NIGHT", ci, co - timedelta(days=1)))

            for kind, start, end in shift_checks:
                if end <= start:
                    continue
                req = BookingRequestIn(
                    category=RoomCategory(pref),
                    check_in=start,
                    check_out=end,
                    guest_name="Direct Guest",
                )
                result = await ctrl.check_availability(req, db)
                if result.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                    add_failure(kind.replace("_", " ").title(), result.message)
                    continue
                payload = _availability_payload(result, pref, start.isoformat(), end.isoformat())
                opt = {
                    "kind": kind,
                    "rank": 80 if kind.startswith("DATE_SHIFT") else 90,
                    "title": "Shift dates" if kind.startswith("DATE_SHIFT") else "Shorten by one night",
                    "category": pref,
                    "room_id": result.room_id,
                    "state": result.state,
                    "check_in": start.isoformat(),
                    "check_out": end.isoformat(),
                    "confirmable": True,
                    "action_data": {"type": "availability_result", "data": payload},
                    "rationale": "Enjoy your preferred room style for slightly different dates.",
                }
                await add_room_rate(opt, result.room_id, pref, start, end)
                options.append(opt)

            # 6. Longest free fragments inside the requested window.
            runs = await _longest_free_runs(db, pref, ci, co, limit=3)
            for run in runs:
                if int(run["nights"]) < 2:
                    continue
                start = date.fromisoformat(run["check_in"])
                end = date.fromisoformat(run["check_out"])
                payload = {
                    "state": "DIRECT_AVAILABLE",
                    "room_id": run["room_id"],
                    "message": f"Room {run['room_id']} can cover the best {pref} fragment.",
                    "swap_plan": None,
                    "comparison": None,
                    "infeasible_dates": [],
                    "alternatives": [],
                    "request": {
                        "category": pref,
                        "check_in": run["check_in"],
                        "check_out": run["check_out"],
                    },
                }
                opt = {
                    "kind": "SHORTENED_FRAGMENT",
                    "rank": 100,
                    "title": f"Shorten stay in {pref}",
                    "category": pref,
                    "room_id": run["room_id"],
                    "check_in": run["check_in"],
                    "check_out": run["check_out"],
                    "nights": run["nights"],
                    "confirmable": True,
                    "action_data": {"type": "availability_result", "data": payload},
                    "rationale": f"Enjoy a shorter stay in your preferred {pref} room for {run['nights']} nights.",
                }
                await add_room_rate(opt, run["room_id"], pref, start, end)
                options.append(opt)

            deduped: list[dict] = []
            seen: set[tuple] = set()
            for opt in sorted(options, key=lambda item: (item.get("rank", 999), -float(item.get("estimated_total") or 0))):
                segments_key = tuple(
                    (
                        seg.get("room_id"),
                        seg.get("check_in"),
                        seg.get("check_out"),
                    )
                    for seg in opt.get("segments", [])
                    if isinstance(seg, dict)
                )
                key = (
                    opt.get("kind"),
                    opt.get("category"),
                    opt.get("room_id"),
                    opt.get("check_in"),
                    opt.get("check_out"),
                    segments_key,
                )
                if key in seen:
                    continue
                seen.add(key)
                deduped.append(opt)

            primary_action_data = next(
                (opt.get("action_data") for opt in deduped if opt.get("confirmable") and opt.get("action_data")),
                None,
            )
            for idx, opt in enumerate(deduped, start=1):
                opt["option_id"] = f"option_{idx}"
                opt["display_rank"] = idx

            return json.dumps({
                "state": "RECOVERY_MENU",
                "preferred_category": pref,
                "check_in": check_in,
                "check_out": check_out,
                "requested_nights": nights,
                "infeasible_dates": [
                    part.strip()
                    for part in infeasible_dates_csv.split(",")
                    if part.strip()
                ],
                "options": deduped[:8],
                "failures": failures,
                "primary_action_data": primary_action_data,
                "instruction": (
                    "Present every option in numbered form. Mention failed paths briefly. "
                    "The primary action card is attached for the top confirmable option."
                ),
            })

        except Exception as exc:
            logger.exception("explore_recovery_options tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def search_best_alternative_category(
        preferred_category: str,
        check_in: str,
        check_out: str,
    ) -> str:
        """
        Search same-date alternatives outside the preferred category.
        Checks categories outside the preferred category and ranks confirmable
        options using category distance, operational complexity, and pricing
        intelligence. Returns the best confirmable availability card, or
        NOT_POSSIBLE if no category can cover the stay.
        """
        try:
            from core.models.pricing_recommendation import PricingRec

            cat_order = ["ECONOMY", "STANDARD", "DELUXE", "SUITE"]
            pref = preferred_category.upper()
            if pref not in cat_order:
                return json.dumps({"error": f"Unknown category: {preferred_category}"})

            pref_idx = cat_order.index(pref)
            candidates = [cat for cat in cat_order if cat != pref]
            candidates.sort(key=lambda cat: (
                abs(cat_order.index(cat) - pref_idx),
                0 if cat_order.index(cat) > pref_idx else 1,
            ))

            ci = date.fromisoformat(check_in)
            co = date.fromisoformat(check_out)
            checked: list[dict] = []
            stay_dates = [ci + timedelta(days=i) for i in range((co - ci).days)]
            pricing_by_cat: dict[str, list] = defaultdict(list)

            if stay_dates:
                recs_result = await db.execute(
                    select(
                        PricingRec.category,
                        PricingRec.recommended_action,
                        PricingRec.confidence,
                        PricingRec.change_pct,
                        PricingRec.occupancy_pct,
                        PricingRec.reasoning,
                    ).where(
                        PricingRec.category.in_(candidates),
                        PricingRec.date >= ci,
                        PricingRec.date < co,
                    )
                )
                for rec in recs_result.all():
                    pricing_by_cat[rec.category].append(rec)

            def pricing_signal(cat: str) -> dict:
                recs = pricing_by_cat.get(cat, [])
                if not recs:
                    return {
                        "action": "UNKNOWN",
                        "confidence": "LOW",
                        "score": 2.0,
                        "reason": "No pricing recommendation exists for this stay window.",
                    }

                action_counts: dict[str, int] = {}
                confidence_counts: dict[str, int] = {}
                score = 0.0
                reasons: list[str] = []
                for rec in recs:
                    action_counts[rec.recommended_action] = action_counts.get(rec.recommended_action, 0) + 1
                    confidence_counts[rec.confidence] = confidence_counts.get(rec.confidence, 0) + 1
                    if rec.recommended_action == "DISCOUNT":
                        score += 12.0
                    elif rec.recommended_action == "MAINTAIN":
                        score += 5.0
                    elif rec.recommended_action == "INCREASE":
                        score += 1.0
                    if rec.confidence == "HIGH":
                        score += 2.0
                    elif rec.confidence == "LOW":
                        score -= 1.0
                    if rec.reasoning and len(reasons) < 2:
                        reasons.append(rec.reasoning[:140])

                top_action = max(action_counts, key=action_counts.get)
                top_confidence = max(confidence_counts, key=confidence_counts.get)
                return {
                    "action": top_action,
                    "confidence": top_confidence,
                    "score": round(score / max(1, len(recs)), 2),
                    "reason": " ".join(reasons) or f"{top_action} pricing signal across the stay.",
                }

            options: list[dict] = []

            for cat in candidates:
                req = BookingRequestIn(
                    category=RoomCategory(cat),
                    check_in=ci,
                    check_out=co,
                    guest_name="Direct Guest",
                )
                result = await ctrl.check_availability(req, db)
                checked.append({"category": cat, "state": result.state})
                if result.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                    continue

                comparison = result.comparison if isinstance(result.comparison, dict) else None
                cat_idx = cat_order.index(cat)
                distance = abs(cat_idx - pref_idx)
                upgrade_bonus = 5.0 if cat_idx > pref_idx else -4.0
                operational_score = 4.0 if result.state == "DIRECT_AVAILABLE" else 1.0
                signal = pricing_signal(cat)
                rank_score = round(
                    (24.0 - distance * 8.0)
                    + upgrade_bonus
                    + operational_score
                    + float(signal["score"]),
                    2,
                )
                options.append({
                    "rank_score": rank_score,
                    "pricing_signal": signal,
                    "state": result.state,
                    "room_id": result.room_id,
                    "message": (
                        f"{cat} is the best same-date alternative to {pref}. "
                        f"{result.message}"
                    ),
                    "swap_plan": result.swap_plan,
                    "comparison": comparison,
                    "infeasible_dates": result.infeasible_dates,
                    "alternatives": [
                        (a.model_dump() if hasattr(a, "model_dump") else a)
                        for a in (result.alternatives or [])
                    ],
                    "alternative_from": pref,
                    "request": {
                        "category": cat,
                        "check_in": check_in,
                        "check_out": check_out,
                    },
                })

            if options:
                best = max(options, key=lambda item: item["rank_score"])
                best["message"] = (
                    f"{best['request']['category']} is the best same-date alternative to {pref}. "
                    f"{best['message'].split('. ', 1)[-1]} "
                    f"Pricing signal: {best['pricing_signal']['action']} "
                    f"({best['pricing_signal']['confidence']})."
                )
                best["evaluated_options"] = [
                    {
                        "category": opt["request"]["category"],
                        "state": opt["state"],
                        "rank_score": opt["rank_score"],
                        "pricing_action": opt["pricing_signal"]["action"],
                    }
                    for opt in sorted(options, key=lambda item: item["rank_score"], reverse=True)
                ]
                return json.dumps(best)

            return json.dumps({
                "state": "NOT_POSSIBLE",
                "message": f"No nearby category can cover {check_in} to {check_out}.",
                "checked_categories": checked,
                "request": {
                    "category": pref,
                    "check_in": check_in,
                    "check_out": check_out,
                },
            })
        except Exception as exc:
            logger.exception("search_best_alternative_category tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def build_recovery_options(
        preferred_category: str,
        check_in: str,
        check_out: str,
        infeasible_dates_csv: str = "",
        attempts_csv: str = "",
    ) -> str:
        """
        Build a proactive recovery menu when the exact full stay is not recoverable.
        Use after direct/split/upgrade/alternative checks fail or when a handoff
        needs several guest-ready offers instead of a single no-availability answer.
        Returns RECOVERY_OPTIONS with shorter same-category stays, nearby category
        fragments, pricing/discount signals, and manager-override questions.
        You should pass attempts_csv as a comma-separated list of paths you checked (e.g., 'Direct Match, Split Stay, Upgrades')
        """
        try:
            cat = preferred_category.upper()
            ci = date.fromisoformat(check_in)
            co = date.fromisoformat(check_out)
            RoomCategory(cat)
            infeasible_dates = [
                part.strip()
                for part in infeasible_dates_csv.split(",")
                if part.strip()
            ]
            attempts = [
                part.strip()
                for part in attempts_csv.split(",")
                if part.strip()
            ]
            recovery = await _build_recovery_options(
                db=db,
                preferred_category=cat,
                check_in=ci,
                check_out=co,
                attempts=attempts,
                infeasible_dates=infeasible_dates,
            )
            return json.dumps(recovery["action_data"]["data"])
        except Exception as exc:
            logger.exception("build_recovery_options tool error")
            return json.dumps({"error": str(exc)})

    @tool
    async def get_revenue_intelligence() -> str:
        """
        Return a live revenue snapshot for the hotel — use this when the booking
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
    # The AI only recommends. All DB writes go through the booking's
    # confirm button in the UI — never triggered by the AI itself.

    tools = [
        check_availability,
        check_room_availability,
        suggest_upgrade,
        find_split_stay,
        find_split_stay_flex,
        explore_recovery_options,
        search_best_alternative_category,
        build_recovery_options,
        get_room_inventory,
        get_revenue_intelligence,
    ]

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
        action_data = _extract_action_data(state["messages"]) or state.get("action_data")
        tool_count = state.get("tool_count", 0)

        if getattr(response, "tool_calls", None) and len(response.tool_calls) > 1:
            raw_tool_calls = list(response.additional_kwargs.get("tool_calls", []))
            additional_kwargs = dict(response.additional_kwargs)
            if raw_tool_calls:
                additional_kwargs["tool_calls"] = raw_tool_calls[:1]
            response = AIMessage(
                content=response.content or "",
                additional_kwargs=additional_kwargs,
                tool_calls=response.tool_calls[:1],
            )

        if tool_count >= MAX_AGENT_TOOL_CALLS and getattr(response, "tool_calls", None):
            response = AIMessage(
                content=(
                    _reply_for_action_data(action_data)
                    or "All recovery paths have been explored within the tool budget. Review the options found above, or ask for a constraint change (different dates, shorter stay, or another category)."
                )
            )

        return {"messages": [response], "action_data": action_data, "tool_count": tool_count}

    # Sequential tool executor — all tools share one AsyncSession; ToolNode's
    # default asyncio.gather would cause SQLAlchemy "concurrent operations" errors.
    tool_map = {t.name: t for t in tools}

    async def tool_node(state: AgentState) -> dict:
        last = state["messages"][-1]
        tool_messages: list[BaseMessage] = []
        tool_calls = list(last.tool_calls or [])
        for tc in tool_calls[:1]:
            fn = tool_map.get(tc["name"])
            if fn is None:
                tool_messages.append(ToolMessage(
                    content=json.dumps({"error": f"Unknown tool: {tc['name']}"}),
                    tool_call_id=tc["id"],
                ))
                continue
            try:
                logger.info("Booking agent tool call: %s %s", tc["name"], tc.get("args", {}))
                result = await fn.ainvoke(tc["args"])
            except Exception as exc:
                result = json.dumps({"error": str(exc)})
            tool_messages.append(ToolMessage(content=result, tool_call_id=tc["id"]))
        return {
            "messages": tool_messages,
            "action_data": state.get("action_data"),
            "tool_count": state.get("tool_count", 0) + len(tool_messages),
        }

    def should_continue(state: AgentState) -> str:
        last = state["messages"][-1]
        if state.get("tool_count", 0) >= MAX_AGENT_TOOL_CALLS:
            return END
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
    Run the booking agent for one turn.

    Parameters
    ----------
    messages     : Full conversation history from frontend
                   [{ role: "user"|"assistant", content: str }, ...]
    db           : AsyncSession injected by FastAPI
    hotel_context: Live hotel summary (occupancy, floors, categories) from /booking/ai/context

    Returns
    -------
    { reply: str, action_data: Optional[dict] }
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

    try:
        result = await graph.ainvoke(
            {"messages": lc_messages, "action_data": None, "tool_count": 0},
            config={"recursion_limit": (MAX_AGENT_TOOL_CALLS * 2) + 4},
        )
    except GraphRecursionError:
        logger.exception("Booking agent hit recursion limit")
        return {
            "reply": (
                "The recovery search took too many tool steps to finish cleanly. "
                "Try a narrower date range, a different category, or run the manual availability check again."
            ),
            "action_data": None,
        }
    except Exception:
        logger.exception("Booking agent turn failed")
        return {
            "reply": "The AI assistant could not complete that turn cleanly. Use the manual availability check, then reopen the assistant if alternatives are needed.",
            "action_data": None,
        }

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

    reply = _sanitize_reply(reply)
    action_data = _extract_action_data(result["messages"])

    return {"reply": reply, "action_data": action_data}
