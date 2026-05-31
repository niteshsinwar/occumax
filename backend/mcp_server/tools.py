from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from fastmcp import FastMCP
from sqlalchemy import select

from config import settings
from controllers import receptionist as receptionist_ctrl
from core.models import Booking, Room, Slot
from core.models.enums import BlockType, Channel, RoomCategory
from core.schemas import BookingConfirm, BookingRequestIn, SplitSegmentOut, SplitStayConfirm
from core.schemas.manager import SwapStep
from services.database import AsyncSessionLocal

from mcp_server.schemas import ConfirmationRequired, McpSplitSegment, ToolError, UnsupportedUntilCoreFix

logger = logging.getLogger(__name__)

MCP_INSTRUCTIONS = """\
You are connected to Occumax, a live hotel booking and revenue management system.

Use only MCP tool results for room IDs, rates, availability, booking feasibility, and pricing signals. Never invent inventory, rates, dates, or room IDs.

For failed exact bookings:
1. Check same-category split stay.
2. Check mixed-category split stay for recommendation only.
3. Check upgrades.
4. Check alternative categories.
5. Build recovery options.

Always present receptionist-ready options with room/category, exact dates, estimated total when available, discount/pricing signal when available, and operational impact.

Read tools may be used proactively. Write tools require explicit staff approval and confirm_write=true.

Checkout dates are exclusive. All dates must be ISO YYYY-MM-DD.
"""

_CATEGORY_ORDER = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "PREMIUM", "SUITE"]


def _enum_value(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


def _json_error(exc: Exception, *, public_message: str) -> dict[str, Any]:
    logger.exception(public_message)
    return ToolError(error=public_message, detail=str(exc)).model_dump()


def _date_range(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range(max(0, (end - start).days))]


def _shuffle_payload(result: Any, category: str, check_in: date, check_out: date) -> dict[str, Any]:
    return {
        "state": result.state,
        "room_id": result.room_id,
        "message": result.message,
        "swap_plan": result.swap_plan,
        "comparison": result.comparison if isinstance(result.comparison, dict) else None,
        "infeasible_dates": result.infeasible_dates,
        "alternatives": [
            item.model_dump(mode="json") if hasattr(item, "model_dump") else item
            for item in (result.alternatives or [])
        ],
        "request": {
            "category": category,
            "check_in": str(check_in),
            "check_out": str(check_out),
        },
    }


def _split_payload(result: Any, category: str, check_in: date, check_out: date) -> dict[str, Any]:
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else dict(result)
    payload["category"] = category
    payload["request"] = {
        "category": category,
        "check_in": str(check_in),
        "check_out": str(check_out),
    }
    return payload


async def _pricing_signal(db: Any, category: str, check_in: date, check_out: date) -> dict[str, Any]:
    try:
        from core.models.pricing_recommendation import PricingRec

        rows = await db.execute(
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
        recs = rows.all()
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


async def _longest_free_runs(db: Any, category: RoomCategory, check_in: date, check_out: date, limit: int = 4) -> list[dict[str, Any]]:
    rooms_result = await db.execute(
        select(Room.id, Room.floor_number, Room.base_rate)
        .where(Room.category == category, Room.is_active == True)
        .order_by(Room.floor_number, Room.id)
    )
    rooms = rooms_result.all()
    if not rooms:
        return []

    room_ids = [room_id for room_id, _, _ in rooms]
    slots_result = await db.execute(
        select(Slot.room_id, Slot.date, Slot.block_type)
        .where(Slot.room_id.in_(room_ids), Slot.date >= check_in, Slot.date < check_out)
    )
    slot_map: dict[str, dict[date, BlockType]] = defaultdict(dict)
    for room_id, slot_date, block_type in slots_result.all():
        slot_map[room_id][slot_date] = block_type

    runs: list[dict[str, Any]] = []
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


def create_mcp() -> FastMCP:
    mcp = FastMCP(
        name="Occumax Receptionist",
        instructions=MCP_INSTRUCTIONS,
        version="1.0.0",
        mask_error_details=True,
    )

    @mcp.tool(
        description="Return live occupancy, ADR, room categories, week revenue, orphan gaps, channel mix, and market context. Use for general hotel-performance questions."
    )
    async def get_hotel_snapshot() -> dict[str, Any]:
        try:
            today = date.today()
            week_end = today + timedelta(days=7)
            scan_end = today + timedelta(days=20)
            async with AsyncSessionLocal() as db:
                all_rooms = (await db.execute(
                    select(Room.id, Room.category, Room.base_rate).where(Room.is_active == True)
                )).all()
                room_cats = {room_id: _enum_value(category) for room_id, category, _ in all_rooms}
                total_rooms = len(all_rooms)

                today_slots = (await db.execute(
                    select(Slot.room_id, Slot.block_type, Slot.current_rate, Slot.channel)
                    .join(Room, Room.id == Slot.room_id)
                    .where(Room.is_active == True, Slot.date == today)
                )).all()
                week_slots = (await db.execute(
                    select(Slot.current_rate)
                    .join(Room, Room.id == Slot.room_id)
                    .where(Room.is_active == True, Slot.date >= today, Slot.date < week_end, Slot.block_type != BlockType.EMPTY)
                )).all()
                scan_slots = (await db.execute(
                    select(Slot.room_id, Slot.date, Slot.block_type)
                    .join(Room, Room.id == Slot.room_id)
                    .where(Room.is_active == True, Slot.date >= today, Slot.date < scan_end)
                    .order_by(Slot.room_id, Slot.date)
                )).all()
                recent_bookings = (await db.execute(
                    select(Booking.room_category).where(Booking.created_at >= datetime.combine(today - timedelta(days=7), datetime.min.time()))
                )).all()

            cat_total: dict[str, int] = {}
            cat_booked: dict[str, int] = {}
            cat_rates: dict[str, list[float]] = {}
            tonight_occupied = 0
            tonight_rates: list[float] = []
            channel_counts: dict[str, int] = {}

            for _, category, _ in all_rooms:
                cat_total[_enum_value(category)] = cat_total.get(_enum_value(category), 0) + 1
            for slot in today_slots:
                category = str(room_cats.get(slot.room_id, "UNKNOWN"))
                channel = str(_enum_value(slot.channel) if slot.channel else "UNKNOWN")
                channel_counts[channel] = channel_counts.get(channel, 0) + 1
                if slot.block_type != BlockType.EMPTY:
                    cat_booked[category] = cat_booked.get(category, 0) + 1
                    tonight_occupied += 1
                    tonight_rates.append(float(slot.current_rate))
                    cat_rates.setdefault(category, []).append(float(slot.current_rate))

            categories = []
            for category, total in sorted(cat_total.items()):
                booked = cat_booked.get(category, 0)
                rates = cat_rates.get(category, [])
                categories.append({
                    "category": category,
                    "total_rooms": total,
                    "booked_tonight": booked,
                    "empty_tonight": total - booked,
                    "occupancy_pct": round(booked / max(1, total) * 100, 1),
                    "avg_rate_tonight": round(sum(rates) / len(rates), 0) if rates else 0.0,
                    "upgrade_available": total - booked > 0,
                })

            by_room: dict[str, list[Any]] = defaultdict(list)
            for slot in scan_slots:
                by_room[slot.room_id].append(slot)
            orphan_nights = 0
            for rows in by_room.values():
                for idx, row in enumerate(rows):
                    if row.block_type != BlockType.EMPTY:
                        continue
                    before = rows[idx - 1].block_type if idx > 0 else None
                    after = rows[idx + 1].block_type if idx < len(rows) - 1 else None
                    if before not in (None, BlockType.EMPTY) and after not in (None, BlockType.EMPTY):
                        orphan_nights += 1

            recent_by_category: dict[str, int] = {}
            for row in recent_bookings:
                category = str(_enum_value(row.room_category))
                recent_by_category[category] = recent_by_category.get(category, 0) + 1

            return {
                "today": str(today),
                "tonight": {
                    "occupancy_pct": round(tonight_occupied / max(1, total_rooms) * 100, 1),
                    "adr": round(sum(tonight_rates) / len(tonight_rates), 0) if tonight_rates else 0.0,
                    "occupied_rooms": tonight_occupied,
                    "total_rooms": total_rooms,
                },
                "categories": categories,
                "week_revenue_on_books": round(sum(float(row.current_rate) for row in week_slots), 0),
                "week_booked_nights": len(week_slots),
                "orphan_nights_next_20_days": orphan_nights,
                "last_7_day_pickup_by_category": recent_by_category,
                "tonight_channel_mix": channel_counts,
                "market_note": "New Jersey hotel: weekday corporate demand, weekend drive-to leisure, graduation/shore/MetLife seasonality, and NYC overflow can change upgrade and discount strategy.",
            }
        except Exception as exc:
            return _json_error(exc, public_message="Failed to build hotel snapshot")

    @mcp.tool(
        description="Return DB-backed active room categories, room counts, and rate ranges. Use before suggesting categories."
    )
    async def list_active_categories() -> dict[str, Any]:
        try:
            async with AsyncSessionLocal() as db:
                rows = (await db.execute(
                    select(Room.category, Room.base_rate).where(Room.is_active == True)
                )).all()
            stats: dict[str, dict[str, Any]] = {}
            for category, base_rate in rows:
                key = str(_enum_value(category))
                stats.setdefault(key, {"category": key, "room_count": 0, "rates": []})
                stats[key]["room_count"] += 1
                stats[key]["rates"].append(float(base_rate))
            categories = []
            for item in stats.values():
                rates = item.pop("rates")
                categories.append({
                    **item,
                    "avg_base_rate": round(sum(rates) / len(rates), 2),
                    "min_rate": min(rates),
                    "max_rate": max(rates),
                })
            return {"categories": sorted(categories, key=lambda item: item["category"])}
        except Exception as exc:
            return _json_error(exc, public_message="Failed to list active categories")

    @mcp.tool(
        description="Return per-room timeline, floor, base/current rate, status, and first-free date for one category."
    )
    async def get_room_inventory(category: RoomCategory) -> dict[str, Any]:
        try:
            today = date.today()
            window_end = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)
            async with AsyncSessionLocal() as db:
                rooms = (await db.execute(
                    select(Room.id, Room.floor_number, Room.base_rate)
                    .where(Room.category == category, Room.is_active == True)
                    .order_by(Room.floor_number, Room.id)
                )).all()
                if not rooms:
                    return {"error": f"No active rooms in category {category.value}"}
                room_ids = [room_id for room_id, _, _ in rooms]
                slots = (await db.execute(
                    select(Slot.room_id, Slot.date, Slot.block_type, Slot.current_rate)
                    .where(Slot.room_id.in_(room_ids), Slot.date >= today, Slot.date < window_end)
                    .order_by(Slot.room_id, Slot.date)
                )).all()
            slot_map: dict[str, dict[date, tuple[BlockType, float]]] = defaultdict(dict)
            for room_id, slot_date, block_type, current_rate in slots:
                slot_map[room_id][slot_date] = (block_type, float(current_rate))

            dates = [today + timedelta(days=i) for i in range(settings.BOOKING_WINDOW_DAYS)]
            output = []
            for room_id, floor, base_rate in rooms:
                timeline = {}
                for cur in dates:
                    block_type, _ = slot_map[room_id].get(cur, (BlockType.EMPTY, float(base_rate)))
                    timeline[str(cur)] = block_type.value
                today_block, today_rate = slot_map[room_id].get(today, (BlockType.EMPTY, float(base_rate)))
                first_free = str(today)
                booked_until = None
                if today_block != BlockType.EMPTY:
                    previous = today
                    for cur in dates[1:]:
                        block_type, _ = slot_map[room_id].get(cur, (BlockType.EMPTY, float(base_rate)))
                        if block_type != BlockType.EMPTY:
                            previous = cur
                        else:
                            break
                    booked_until = str(previous)
                    next_day = previous + timedelta(days=1)
                    first_free = str(next_day) if next_day < window_end else None
                output.append({
                    "id": room_id,
                    "floor": floor,
                    "base_rate": float(base_rate),
                    "today_status": today_block.value,
                    "today_rate": float(today_rate),
                    "timeline": timeline,
                    "first_free": first_free,
                    "booked_until": booked_until,
                })
            return {"category": category.value, "window": {"start": str(today), "end": str(window_end)}, "rooms": output}
        except Exception as exc:
            return _json_error(exc, public_message="Failed to load room inventory")

    @mcp.tool(
        description="Check exact category/date availability. Returns direct availability, shuffle possibility, or impossible status. Does not write."
    )
    async def check_availability(category: RoomCategory, check_in: date, check_out: date, guest_name: str = "Direct Guest") -> dict[str, Any]:
        try:
            async with AsyncSessionLocal() as db:
                req = BookingRequestIn(category=category, check_in=check_in, check_out=check_out, guest_name=guest_name)
                result = await receptionist_ctrl.check_availability(req, db)
                return _shuffle_payload(result, category.value, check_in, check_out)
        except Exception as exc:
            return _json_error(exc, public_message="Failed to check availability")

    @mcp.tool(
        description="Check a specific room ID for a date range after inventory inspection."
    )
    async def check_room_availability(room_id: str, check_in: date, check_out: date) -> dict[str, Any]:
        try:
            async with AsyncSessionLocal() as db:
                room = (await db.execute(
                    select(Room.id, Room.category, Room.floor_number, Room.base_rate)
                    .where(Room.id == room_id, Room.is_active == True)
                )).first()
                if not room:
                    return {"error": f"Room {room_id} not found or inactive."}
                slots = (await db.execute(
                    select(Slot.date, Slot.block_type)
                    .where(Slot.room_id == room_id, Slot.date >= check_in, Slot.date < check_out)
                )).all()
            r_id, room_category, floor, rate = room
            slot_map = {slot_date: block_type for slot_date, block_type in slots}
            blocked = [
                cur for cur in _date_range(check_in, check_out)
                if slot_map.get(cur, BlockType.EMPTY) != BlockType.EMPTY
            ]
            category_value = str(_enum_value(room_category))
            if blocked:
                return {
                    "state": "OCCUPIED",
                    "room_id": r_id,
                    "floor": floor,
                    "category": category_value,
                    "blocked_dates": [str(cur) for cur in blocked],
                    "message": f"Room {r_id} is blocked from {min(blocked)}.",
                }
            return {
                "state": "DIRECT_AVAILABLE",
                "room_id": r_id,
                "message": f"Room {r_id} on floor {floor} is available {check_in} to {check_out}.",
                "swap_plan": None,
                "comparison": None,
                "infeasible_dates": [],
                "alternatives": [],
                "request": {"category": category_value, "check_in": str(check_in), "check_out": str(check_out)},
                "rate": float(rate),
            }
        except Exception as exc:
            return _json_error(exc, public_message="Failed to check room availability")

    @mcp.tool(
        description="Find a full-stay same-category split option when one continuous room is unavailable."
    )
    async def find_split_stay(category: RoomCategory, check_in: date, check_out: date, guest_name: str = "Direct Guest") -> dict[str, Any]:
        try:
            async with AsyncSessionLocal() as db:
                req = BookingRequestIn(category=category, check_in=check_in, check_out=check_out, guest_name=guest_name)
                result = await receptionist_ctrl.find_split_stay(req, db)
                return _split_payload(result, category.value, check_in, check_out)
        except Exception as exc:
            return _json_error(exc, public_message="Failed to find split stay")

    @mcp.tool(
        description="Find a full-stay mixed-category split option when same-category split fails. Recommendation only; v1 does not confirm mixed-category splits."
    )
    async def find_split_stay_flex(preferred_category: RoomCategory, check_in: date, check_out: date, guest_name: str = "Direct Guest") -> dict[str, Any]:
        try:
            async with AsyncSessionLocal() as db:
                req = BookingRequestIn(category=preferred_category, check_in=check_in, check_out=check_out, guest_name=guest_name)
                result = await receptionist_ctrl.find_split_stay_flex(req, db)
                payload = _split_payload(result, preferred_category.value, check_in, check_out)
                payload["confirmation_support"] = "recommendation_only_for_mixed_category_v1"
                return payload
        except Exception as exc:
            return _json_error(exc, public_message="Failed to find flexible split stay")

    @mcp.tool(
        description="Find the best higher-tier exact-date option and attach pricing intelligence."
    )
    async def suggest_upgrade(preferred_category: RoomCategory, check_in: date, check_out: date) -> dict[str, Any]:
        try:
            preferred = preferred_category.value
            higher = _CATEGORY_ORDER[_CATEGORY_ORDER.index(preferred) + 1:]
            if not higher:
                return {"state": "NO_UPGRADE", "preferred_category": preferred, "message": f"{preferred} is already the highest tier."}
            async with AsyncSessionLocal() as db:
                for category in higher:
                    req = BookingRequestIn(category=RoomCategory(category), check_in=check_in, check_out=check_out, guest_name="Direct Guest")
                    result = await receptionist_ctrl.check_availability(req, db)
                    if result.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                        continue
                    signal = await _pricing_signal(db, category, check_in, check_out)
                    discount_pct = float(signal["discount_pct"]) if signal["action"] == "DISCOUNT" else 0.0
                    return {
                        "state": "UPGRADE_AVAILABLE",
                        "preferred_category": preferred,
                        "upgrades": [{
                            "category": category,
                            "room_id": result.room_id,
                            "state": result.state,
                            "swap_plan": result.swap_plan,
                            "comparison": result.comparison if isinstance(result.comparison, dict) else None,
                            "prob_of_selling": "LOW" if signal["action"] == "DISCOUNT" else "HIGH",
                            "discount_recommended": discount_pct > 0,
                            "discount_pct": discount_pct,
                            "pricing_reason": signal["reason"],
                            "request": {"category": category, "check_in": str(check_in), "check_out": str(check_out)},
                        }],
                    }
            return {"state": "NO_UPGRADE", "preferred_category": preferred, "message": f"No higher-tier rooms available for {check_in} to {check_out}."}
        except Exception as exc:
            return _json_error(exc, public_message="Failed to suggest upgrade")

    @mcp.tool(
        description="Find the strongest same-date option across other categories, ranked by category distance, operational cost, and pricing signal."
    )
    async def search_best_alternative_category(preferred_category: RoomCategory, check_in: date, check_out: date) -> dict[str, Any]:
        try:
            preferred = preferred_category.value
            pref_idx = _CATEGORY_ORDER.index(preferred)
            candidates = [category for category in _CATEGORY_ORDER if category != preferred]
            candidates.sort(key=lambda category: (abs(_CATEGORY_ORDER.index(category) - pref_idx), 0 if _CATEGORY_ORDER.index(category) > pref_idx else 1))
            checked: list[dict[str, Any]] = []
            options: list[dict[str, Any]] = []
            async with AsyncSessionLocal() as db:
                for category in candidates:
                    req = BookingRequestIn(category=RoomCategory(category), check_in=check_in, check_out=check_out, guest_name="Direct Guest")
                    result = await receptionist_ctrl.check_availability(req, db)
                    checked.append({"category": category, "state": result.state})
                    if result.state not in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
                        continue
                    cat_idx = _CATEGORY_ORDER.index(category)
                    distance = abs(cat_idx - pref_idx)
                    upgrade_bonus = 5.0 if cat_idx > pref_idx else -4.0
                    operational_score = 4.0 if result.state == "DIRECT_AVAILABLE" else 1.0
                    signal = await _pricing_signal(db, category, check_in, check_out)
                    rank_score = round((24.0 - distance * 8.0) + upgrade_bonus + operational_score + float(signal["score"]), 2)
                    payload = _shuffle_payload(result, category, check_in, check_out)
                    payload.update({"rank_score": rank_score, "pricing_signal": signal, "alternative_from": preferred})
                    options.append(payload)
            if options:
                best = max(options, key=lambda item: item["rank_score"])
                best["message"] = f"{best['request']['category']} is the best same-date alternative to {preferred}. {best['message']} Pricing signal: {best['pricing_signal']['action']} ({best['pricing_signal']['confidence']})."
                best["evaluated_options"] = [
                    {
                        "category": option["request"]["category"],
                        "state": option["state"],
                        "rank_score": option["rank_score"],
                        "pricing_action": option["pricing_signal"]["action"],
                    }
                    for option in sorted(options, key=lambda item: item["rank_score"], reverse=True)
                ]
                return best
            return {
                "state": "NOT_POSSIBLE",
                "message": f"No nearby category can cover {check_in} to {check_out}.",
                "checked_categories": checked,
                "request": {"category": preferred, "check_in": str(check_in), "check_out": str(check_out)},
            }
        except Exception as exc:
            return _json_error(exc, public_message="Failed to search alternative categories")

    @mcp.tool(
        description="Build final fallback menu after exact, split, upgrade, and alternative paths fail."
    )
    async def build_recovery_options(preferred_category: RoomCategory, check_in: date, check_out: date, infeasible_dates: list[str] | None = None) -> dict[str, Any]:
        try:
            nights = max(1, (check_out - check_in).days)
            async with AsyncSessionLocal() as db:
                preferred_signal = await _pricing_signal(db, preferred_category.value, check_in, check_out)
                discount_pct = float(preferred_signal["discount_pct"]) if preferred_signal["action"] == "DISCOUNT" else 0.0
                preferred_runs = await _longest_free_runs(db, preferred_category, check_in, check_out)
                options: list[dict[str, Any]] = []
                for idx, run in enumerate(preferred_runs):
                    discounted_rate = round(run["base_rate"] * (1 - discount_pct / 100), 2)
                    options.append({
                        "kind": "SHORTEN_STAY",
                        "priority": "BEST" if idx == 0 else "GOOD",
                        "title": f"Shorten in {preferred_category.value}: {run['nights']} nights",
                        "category": preferred_category.value,
                        "room_id": run["room_id"],
                        "check_in": run["check_in"],
                        "check_out": run["check_out"],
                        "nights": run["nights"],
                        "discount_pct": discount_pct,
                        "estimated_total": round(run["nights"] * discounted_rate, 2),
                        "rationale": f"Best available {preferred_category.value} fragment inside the requested window. Covers {run['nights']} of {nights} requested nights.",
                    })
                adjacent = [category for category in _CATEGORY_ORDER if category != preferred_category.value]
                adjacent.sort(key=lambda category: (abs(_CATEGORY_ORDER.index(category) - _CATEGORY_ORDER.index(preferred_category.value)), 0 if _CATEGORY_ORDER.index(category) > _CATEGORY_ORDER.index(preferred_category.value) else 1))
                for category in adjacent[:3]:
                    runs = await _longest_free_runs(db, RoomCategory(category), check_in, check_out, limit=1)
                    if not runs:
                        continue
                    run = runs[0]
                    signal = await _pricing_signal(db, category, check_in, check_out)
                    cat_discount = float(signal["discount_pct"]) if signal["action"] == "DISCOUNT" else 0.0
                    discounted_rate = round(run["base_rate"] * (1 - cat_discount / 100), 2)
                    best_preferred_nights = preferred_runs[0]["nights"] if preferred_runs else 0
                    options.append({
                        "kind": "CATEGORY_FRAGMENT",
                        "priority": "GOOD" if run["nights"] >= best_preferred_nights else "ALT",
                        "title": f"Alternative category fragment: {category}",
                        "category": category,
                        "room_id": run["room_id"],
                        "check_in": run["check_in"],
                        "check_out": run["check_out"],
                        "nights": run["nights"],
                        "discount_pct": cat_discount,
                        "estimated_total": round(run["nights"] * discounted_rate, 2),
                        "pricing_action": signal["action"],
                        "rationale": f"Closest category inventory fragment found after exact {preferred_category.value} failed. Pricing signal is {signal['action']}.",
                    })
            options.append({
                "kind": "CHANGE_CONSTRAINT",
                "priority": "ASK",
                "title": "Ask for one constraint change",
                "category": preferred_category.value,
                "nights": nights,
                "discount_pct": discount_pct,
                "estimated_total": None,
                "rationale": "Ask whether the guest can shorten the stay, shift dates, accept mixed categories, or allow more than two room moves.",
            })
            options = sorted(options, key=lambda item: ({"BEST": 0, "GOOD": 1, "ALT": 2, "ASK": 3}.get(str(item.get("priority")), 9), -int(item.get("nights") or 0)))[:6]
            return {
                "state": "RECOVERY_OPTIONS",
                "preferred_category": preferred_category.value,
                "check_in": str(check_in),
                "check_out": str(check_out),
                "requested_nights": nights,
                "infeasible_dates": infeasible_dates or [],
                "pricing_signal": preferred_signal,
                "options": options,
            }
        except Exception as exc:
            return _json_error(exc, public_message="Failed to build recovery options")

    @mcp.tool(
        description="Return pricing recommendation for one category/date range: INCREASE, MAINTAIN, DISCOUNT, confidence, and reason."
    )
    async def get_pricing_signal(category: RoomCategory, check_in: date, check_out: date) -> dict[str, Any]:
        try:
            async with AsyncSessionLocal() as db:
                return await _pricing_signal(db, category.value, check_in, check_out)
        except Exception as exc:
            return _json_error(exc, public_message="Failed to get pricing signal")

    @mcp.tool(
        description="Return recent booking records with minimized guest details for operational context."
    )
    async def list_recent_bookings(limit: int = 20) -> dict[str, Any]:
        try:
            safe_limit = max(1, min(limit, 50))
            async with AsyncSessionLocal() as db:
                rows = (await db.execute(
                    select(Booking)
                    .order_by(Booking.created_at.desc())
                    .limit(safe_limit)
                )).scalars().all()
            return {
                "bookings": [
                    {
                        "id": booking.id,
                        "guest_label": f"Guest {booking.id[-4:]}",
                        "category": str(_enum_value(booking.room_category)),
                        "room_id": booking.assigned_room_id,
                        "check_in": str(booking.check_in),
                        "check_out": str(booking.check_out),
                        "is_live": booking.is_live,
                        "stay_group_id": booking.stay_group_id,
                        "segment_index": booking.segment_index,
                        "discount_pct": booking.discount_pct,
                    }
                    for booking in rows
                ]
            }
        except Exception as exc:
            return _json_error(exc, public_message="Failed to list recent bookings")

    @mcp.tool(
        description="Write tool. Confirm direct or shuffle booking only after explicit staff approval. Requires confirm_write=true."
    )
    async def confirm_single_booking(
        guest_name: str,
        category: RoomCategory,
        check_in: date,
        check_out: date,
        room_id: str,
        swap_plan: list[SwapStep] | None = None,
        channel: Channel = Channel.DIRECT,
        channel_partner: str | None = None,
        confirm_write: bool = False,
    ) -> dict[str, Any]:
        try:
            if not confirm_write:
                return ConfirmationRequired(
                    message="This tool writes to the database. Ask staff to approve the booking, then call again with confirm_write=true."
                ).model_dump()
            async with AsyncSessionLocal() as db:
                body = BookingConfirm(
                    request=BookingRequestIn(
                        category=category,
                        check_in=check_in,
                        check_out=check_out,
                        guest_name=guest_name,
                        channel=channel,
                        channel_partner=channel_partner,
                    ),
                    room_id=room_id,
                    swap_plan=swap_plan,
                )
                result = await receptionist_ctrl.confirm_booking(body, db)
                return {"state": "CONFIRMED", "data": result}
        except Exception as exc:
            return _json_error(exc, public_message="Failed to confirm single booking")

    @mcp.tool(
        description="Write tool. Confirm same-category split stay segments only after explicit staff approval. Requires confirm_write=true. Mixed-category split confirmation is blocked in MCP v1."
    )
    async def confirm_split_stay(
        guest_name: str,
        category: RoomCategory,
        segments: list[McpSplitSegment],
        discount_pct: float = 0.0,
        channel: Channel = Channel.DIRECT,
        channel_partner: str | None = None,
        confirm_write: bool = False,
    ) -> dict[str, Any]:
        try:
            if not confirm_write:
                return ConfirmationRequired(
                    message="This tool writes to the database. Ask staff to approve the split stay, then call again with confirm_write=true."
                ).model_dump()
            async with AsyncSessionLocal() as db:
                room_ids = {segment.room_id for segment in segments}
                room_rows = await db.execute(
                    select(Room.id, Room.category).where(Room.id.in_(room_ids), Room.is_active == True)
                )
                room_categories = {
                    room_id: str(_enum_value(room_category))
                    for room_id, room_category in room_rows.all()
                }
                missing_rooms = sorted(room_ids - set(room_categories.keys()))
                if missing_rooms:
                    return {
                        "error": "Cannot confirm split stay because one or more rooms are inactive or unknown.",
                        "missing_rooms": missing_rooms,
                    }
                segment_categories = set(room_categories.values())
                if segment_categories - {category.value}:
                    return UnsupportedUntilCoreFix(
                        message="MCP v1 will not confirm mixed-category split stays because the existing core controller stores one category for all segments.",
                        details={"requested_category": category.value, "segment_categories": sorted(segment_categories)},
                    ).model_dump()
                body = SplitStayConfirm(
                    guest_name=guest_name,
                    category=category,
                    discount_pct=discount_pct,
                    channel=channel,
                    channel_partner=channel_partner,
                    segments=[
                        SplitSegmentOut(
                            room_id=segment.room_id,
                            category=segment.category or category,
                            floor=segment.floor,
                            check_in=date.fromisoformat(segment.check_in),
                            check_out=date.fromisoformat(segment.check_out),
                            nights=segment.nights,
                            base_rate=segment.base_rate,
                            discounted_rate=segment.discounted_rate,
                        )
                        for segment in segments
                    ],
                )
                result = await receptionist_ctrl.confirm_split_stay(body, db)
                return {"state": "CONFIRMED", "data": result}
        except Exception as exc:
            return _json_error(exc, public_message="Failed to confirm split stay")

    return mcp
