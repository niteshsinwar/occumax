from __future__ import annotations
import uuid
from datetime import date, datetime, timedelta
from typing import Union, Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, Booking, BlockType, Channel, RoomCategory
from core.schemas import BookingRequestIn, ShuffleResult, BookingConfirm, SplitStayResult, SplitStayConfirm, SplitSegmentOut
from services.algorithm.calendar_optimiser import SlotInfo
from services.algorithm.booking_placement import ShuffleEngine
from services.algorithm.split_stay import SplitStayEngine
from services.algorithm.split_stay_flex import SplitStayFlexEngine


async def _find_direct_empty_room(
    db: AsyncSession,
    category: RoomCategory,
    check_in: date,
    check_out: date,
) -> Optional[str]:
    """
    Fast path: find any room with no non-EMPTY slots in the requested window.

    Notes
    -----
    The database may not have explicit Slot rows for EMPTY nights. We treat missing
    Slot rows as EMPTY. Therefore, a room is directly available if there does not
    exist any Slot in [check_in, check_out) whose block_type is not EMPTY.
    """
    non_empty_exists = (
        select(Slot.id)
        .where(
            Slot.room_id == Room.id,
            Slot.date >= check_in,
            Slot.date < check_out,
            Slot.block_type != BlockType.EMPTY,
        )
        .exists()
    )

    res = await db.execute(
        select(Room.id)
        .where(
            Room.category == category,
            Room.is_active == True,
            ~non_empty_exists,
        )
        .order_by(Room.floor_number, Room.id)
        .limit(1)
    )
    return res.scalar_one_or_none()


async def _load_slots_for_categories(
    db: AsyncSession,
    categories: list[RoomCategory],
    today: date,
) -> list[SlotInfo]:
    """
    Load all slots across the scan window for the given categories.

    This is used by cross-category split stays; we still load the full scan window
    so blocks spanning outside the request range are visible where needed.
    """
    end = today + timedelta(days=settings.SCAN_WINDOW_DAYS)
    result = await db.execute(
        select(Slot, Room)
        .join(Room, Slot.room_id == Room.id)
        .where(
            Room.category.in_(categories),
            Room.is_active == True,
            Slot.date >= today,
            Slot.date < end,
        )
    )
    rows = result.all()
    return [
        SlotInfo(
            slot_id=slot.id,
            room_id=slot.room_id,
            category=room.category,
            date=slot.date,
            block_type=slot.block_type,
            booking_id=slot.booking_id,
            base_rate=room.base_rate,
            current_rate=slot.current_rate,
            channel=slot.channel,
            min_stay_nights=slot.min_stay_nights,
        )
        for slot, room in rows
    ]


async def _load_category_slots(
    db: AsyncSession,
    category: str,
    today: date,
) -> list[SlotInfo]:
    """
    Load ALL slots for a category across the full scan window.
    Full window is required so blocking booking spans outside the request
    range are visible when checking alt-room availability.
    """
    end = today + timedelta(days=settings.SCAN_WINDOW_DAYS)
    result = await db.execute(
        select(Slot, Room)
        .join(Room, Slot.room_id == Room.id)
        .where(
            Room.category == category,
            Room.is_active == True,
            Slot.date >= today,
            Slot.date < end,
        )
    )
    rows = result.all()
    return [
        SlotInfo(
            slot_id=slot.id,
            room_id=slot.room_id,
            category=room.category,
            date=slot.date,
            block_type=slot.block_type,
            booking_id=slot.booking_id,
            base_rate=room.base_rate,
            current_rate=slot.current_rate,
            channel=slot.channel,
            min_stay_nights=slot.min_stay_nights,
        )
        for slot, room in rows
    ]


def _infeasible_dates(
    slots: list[SlotInfo],
    check_in: date,
    check_out: date,
) -> list[date]:
    """
    Return dates where EVERY room in the category is HARD or SOFT —
    no amount of shuffling can free that date.
    """
    empty_rooms_per_date: dict[date, set[str]] = {}
    cur = check_in
    while cur < check_out:
        empty_rooms_per_date[cur] = set()
        cur += timedelta(days=1)

    for s in slots:
        if s.date in empty_rooms_per_date and s.block_type == BlockType.EMPTY:
            empty_rooms_per_date[s.date].add(s.room_id)

    return [d for d, rooms in sorted(empty_rooms_per_date.items()) if not rooms]


def _build_comparison(
    slots: list[SlotInfo],
    plan,
    check_in: date,
    check_out: date,
) -> dict:
    """Build before/after comparison table for the involved rooms."""
    matrix: dict[str, dict[date, SlotInfo]] = {}
    for s in slots:
        matrix.setdefault(s.room_id, {})[s.date] = s

    target_room = plan.room_id
    swap_steps  = plan.swap_steps or []

    req_dates: list[date] = []
    cur = check_in
    while cur < check_out:
        req_dates.append(cur)
        cur += timedelta(days=1)

    after_target: dict[date, dict] = {d: {"block_type": "SOFT", "booking_id": "NEW"} for d in req_dates}

    receiving: dict[str, dict[date, dict]] = {}
    for step in swap_steps:
        alt_room = step["to_room"]
        if alt_room not in receiving:
            receiving[alt_room] = {}
        for d_str in step["dates"]:
            d = date.fromisoformat(d_str)
            receiving[alt_room][d] = {"block_type": "SOFT", "booking_id": step["booking_id"]}

    def slot_cell(room_id: str, d: date) -> dict:
        s = matrix.get(room_id, {}).get(d)
        if s:
            return {"block_type": s.block_type, "booking_id": s.booking_id}
        return {"block_type": "EMPTY", "booking_id": None}

    rows = []

    target_before = [slot_cell(target_room, d) for d in req_dates]
    target_after  = [after_target[d] for d in req_dates]
    rows.append({
        "room_id": target_room,
        "role": "TARGET",
        "booking_id_received": None,
        "cells": [
            {
                "date": str(d),
                "before_type": target_before[i]["block_type"],
                "before_booking": target_before[i]["booking_id"],
                "after_type": target_after[i]["block_type"],
                "after_booking": target_after[i]["booking_id"],
            }
            for i, d in enumerate(req_dates)
        ],
    })

    for step in swap_steps:
        alt_room = step["to_room"]
        if any(r["room_id"] == alt_room for r in rows):
            continue

        alt_before = [slot_cell(alt_room, d) for d in req_dates]
        alt_after  = [receiving[alt_room].get(d, slot_cell(alt_room, d)) for d in req_dates]
        changed = any(
            alt_before[i]["block_type"] != alt_after[i]["block_type"]
            for i in range(len(req_dates))
        )
        if not changed:
            continue

        rows.append({
            "room_id": alt_room,
            "role": "RECEIVES",
            "booking_id_received": step["booking_id"],
            "cells": [
                {
                    "date": str(d),
                    "before_type": alt_before[i]["block_type"],
                    "before_booking": alt_before[i]["booking_id"],
                    "after_type": alt_after[i]["block_type"],
                    "after_booking": alt_after[i]["booking_id"],
                }
                for i, d in enumerate(req_dates)
            ],
        })

    # Build plain-English move summary for the UI
    summary_lines: list[str] = []
    for step in swap_steps:
        dates_list = step["dates"]
        tail = step["booking_id"][-6:]
        n = len(dates_list)
        date_range = (
            f"{dates_list[0][5:]} – {dates_list[-1][5:]}" if n > 1 else dates_list[0][5:]
        )
        summary_lines.append(
            f"Booking ·{tail} moves {step['from_room']} → {step['to_room']} "
            f"({n} night{'s' if n != 1 else ''}: {date_range})"
        )

    return {"dates": [str(d) for d in req_dates], "rows": rows, "summary": summary_lines}


async def _compute_alternatives(
    db: AsyncSession,
    category: Union[str, RoomCategory],
    check_in: date,
    check_out: date,
    today: date,
) -> list[dict]:
    """Suggest adjacent date windows or alternative categories."""
    category_str = category.value if hasattr(category, "value") else category
    CategoryEnum = type(category) if hasattr(category, "value") else type("Dummy", (), {"value": category}) # needed if category is str for typing, but it's fine
    nights = (check_out - check_in).days
    max_date = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)
    suggestions: list[dict] = []

    for delta in (-1, +1, -2, +2, -3, +3):
        new_ci = check_in + timedelta(days=delta)
        new_co = new_ci + timedelta(days=nights)
        if new_ci < today or new_co > max_date:
            continue

        res = await db.execute(
            select(Slot, Room)
            .join(Room, Slot.room_id == Room.id)
            .where(
                Room.category == category_str,
                Room.is_active == True,
                Slot.date >= new_ci,
                Slot.date < new_co,
                Slot.block_type == BlockType.EMPTY,
            )
        )
        room_counts: dict[str, int] = {}
        for slot, _ in res.all():
            room_counts[slot.room_id] = room_counts.get(slot.room_id, 0) + 1
        for room_id, count in room_counts.items():
            if count >= nights:
                suggestions.append({
                    "type": "ADJACENT_DATE",
                    "category": category,
                    "room_id": room_id,
                    "check_in": str(new_ci),
                    "check_out": str(new_co),
                    "message": (
                        f"Room {room_id} ({category_str}) available "
                        f"{new_ci} → {new_co} "
                        f"({'earlier' if delta < 0 else 'later'} by {abs(delta)} day{'s' if abs(delta)>1 else ''})"
                    ),
                })
                break

        if len(suggestions) >= 3:
            break

    for alt_cat in ["STANDARD", "STUDIO", "DELUXE", "SUITE", "PREMIUM", "ECONOMY"]:
        if len(suggestions) >= 5:
            break
        if alt_cat == category_str:
            continue
        res = await db.execute(
            select(Slot, Room)
            .join(Room, Slot.room_id == Room.id)
            .where(
                Room.category == alt_cat,
                Room.is_active == True,
                Slot.date >= check_in,
                Slot.date < check_out,
                Slot.block_type == BlockType.EMPTY,
            )
        )
        room_counts = {}
        for slot, _ in res.all():
            room_counts[slot.room_id] = room_counts.get(slot.room_id, 0) + 1
        for room_id, count in room_counts.items():
            if count >= nights:
                suggestions.append({
                    "type": "ALT_CATEGORY",
                    "category": alt_cat,
                    "room_id": room_id,
                    "check_in": str(check_in),
                    "check_out": str(check_out),
                    "message": f"Room {room_id} ({alt_cat}) available for same dates",
                })
                break

    return suggestions


async def check_availability(request: BookingRequestIn, db: AsyncSession) -> ShuffleResult:
    today = date.today()
    max_date = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)

    if request.check_in < today:
        raise HTTPException(status_code=400, detail="check_in cannot be in the past")
    if request.check_out <= request.check_in:
        raise HTTPException(status_code=400, detail="check_out must be after check_in")
    if request.check_out > max_date:
        raise HTTPException(
            status_code=400,
            detail=f"Bookings only accepted within {settings.BOOKING_WINDOW_DAYS} days from today (max: {max_date})"
        )

    # Fast path: direct availability without full-window load + shuffle enumeration.
    direct_room_id = await _find_direct_empty_room(db, request.category, request.check_in, request.check_out)
    if direct_room_id:
        nights = (request.check_out - request.check_in).days
        return ShuffleResult(
            state="DIRECT_AVAILABLE",
            room_id=direct_room_id,
            message=(
                f"Room {direct_room_id} is immediately available — no rearrangement needed. "
                f"Guest gets {nights} consecutive night{'s' if nights != 1 else ''} in a {request.category.value} room."
            ),
            swap_plan=None,
            comparison=None,
            infeasible_dates=[],
            alternatives=[],
        )

    slots = await _load_category_slots(db, request.category, today)

    bad_dates = _infeasible_dates(slots, request.check_in, request.check_out)
    if bad_dates:
        alternatives = await _compute_alternatives(
            db, request.category, request.check_in, request.check_out, today
        )
        return ShuffleResult(
            state="NOT_POSSIBLE",
            room_id=None,
            message=(
                f"No {request.category.value} room can be freed — all rooms are hard-blocked on "
                f"{len(bad_dates)} date(s): "
                + ", ".join(str(d) for d in bad_dates[:3])
                + ("…" if len(bad_dates) > 3 else "")
                + ". Even moving soft bookings cannot help."
            ),
            swap_plan=None,
            comparison=None,
            infeasible_dates=[str(d) for d in bad_dates],
            alternatives=alternatives,
        )

    engine = ShuffleEngine(slots)
    plan = engine.search(request.category, request.check_in, request.check_out)

    if plan.state == "NOT_POSSIBLE":
        alternatives = await _compute_alternatives(
            db, request.category, request.check_in, request.check_out, today
        )
        return ShuffleResult(
            state="NOT_POSSIBLE",
            room_id=None,
            message=plan.message,
            swap_plan=None,
            comparison=None,
            infeasible_dates=[],
            alternatives=alternatives,
        )

    comparison = _build_comparison(slots, plan, request.check_in, request.check_out)
    nights  = (request.check_out - request.check_in).days
    n_swaps = len(plan.swap_steps)

    if plan.state == "DIRECT_AVAILABLE":
        summary = (
            f"Room {plan.room_id} is immediately available — no rearrangement needed. "
            f"Guest gets {nights} consecutive night{'s' if nights > 1 else ''} in a {request.category.value} room."
        )
    else:
        summary = (
            f"Room {plan.room_id} can be prepared. "
            f"{n_swaps} existing booking{'s' if n_swaps > 1 else ''} will be moved to "
            f"equivalent {request.category.value} rooms at check-in — no guest impact. "
            f"Guest gets {nights} consecutive night{'s' if nights > 1 else ''} in {plan.room_id}."
        )

    return ShuffleResult(
        state=plan.state,
        room_id=plan.room_id,
        message=summary,
        swap_plan=plan.swap_steps if plan.swap_steps else None,
        comparison=comparison,
        infeasible_dates=[],
        alternatives=[],
    )


async def confirm_booking(body: BookingConfirm, db: AsyncSession) -> dict:
    req = body.request
    today = date.today()
    max_date = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)

    if req.check_in < today:
        raise HTTPException(status_code=400, detail="check_in cannot be in the past")
    if req.check_out > max_date:
        raise HTTPException(
            status_code=400,
            detail=f"Bookings only accepted within {settings.BOOKING_WINDOW_DAYS} days (max: {max_date})"
        )

    booking_id = str(uuid.uuid4())[:8].upper()

    booking = Booking(
        id=booking_id,
        guest_name=req.guest_name,
        room_category=req.category,
        assigned_room_id=body.room_id,
        check_in=req.check_in,
        check_out=req.check_out,
        is_live=False,
        created_at=datetime.utcnow(),
    )
    db.add(booking)
    await db.flush()

    # PASS 1: VACATE all source segments in the shuffle plan.
    # Cache each moved booking's channel/partner BEFORE nulling the slots — PASS 2
    # re-queries by booking_id and would find nothing after the slots are cleared.
    booking_channel_cache: dict[str, tuple] = {}
    if body.swap_plan:
        for swap in body.swap_plan:
            from_room = swap.get("from_room")
            bid       = swap.get("booking_id")
            if not (from_room and bid):
                continue

            slots_result = await db.execute(
                select(Slot).where(Slot.room_id == from_room, Slot.booking_id == bid)
            )
            for slot in slots_result.scalars().all():
                if bid not in booking_channel_cache:
                    booking_channel_cache[bid] = (slot.channel, slot.channel_partner)
                slot.block_type = BlockType.EMPTY
                slot.booking_id = None

    # Resolve channel enum and partner from request
    try:
        req_channel = Channel(req.channel or "DIRECT")
    except ValueError:
        req_channel = Channel.DIRECT
    req_partner = req.channel_partner or None

    # PASS 2: FILL all destination segments in the shuffle plan
    if body.swap_plan:
        for swap in body.swap_plan:
            to_room = swap.get("to_room")
            bid     = swap.get("booking_id")
            if not (to_room and bid):
                continue

            dates = swap.get("dates", [])

            # Use the channel cached in PASS 1 — slots are already vacated so a
            # DB query would return nothing.
            cached = booking_channel_cache.get(bid, (None, None))
            moved_channel = cached[0] if cached[0] else Channel.DIRECT
            moved_partner = cached[1]

            for d_str in dates:
                d = date.fromisoformat(d_str)
                target_slot_id = f"{to_room}_{d}"
                tr = await db.execute(select(Slot).where(Slot.id == target_slot_id))
                target_slot = tr.scalar_one_or_none()

                if target_slot:
                    target_slot.block_type      = BlockType.SOFT
                    target_slot.booking_id      = bid
                    target_slot.channel         = moved_channel
                    target_slot.channel_partner = moved_partner
                else:
                    room_res = await db.execute(select(Room).where(Room.id == to_room))
                    room_obj = room_res.scalar_one_or_none()
                    db.add(Slot(
                        id=target_slot_id,
                        room_id=to_room,
                        date=d,
                        block_type=BlockType.SOFT,
                        booking_id=bid,
                        current_rate=room_obj.base_rate if room_obj else 0.0,
                        channel=moved_channel,
                        channel_partner=moved_partner,
                    ))
            
            # Sync the Booking model for the moved guest
            bk_res = await db.execute(select(Booking).where(Booking.id == bid))
            bk_obj = bk_res.scalar_one_or_none()
            if bk_obj:
                bk_obj.assigned_room_id = to_room

    # PASS 3: Place the NEW booking
    room_result = await db.execute(select(Room).where(Room.id == body.room_id))
    room_obj = room_result.scalar_one_or_none()
    base_rate = room_obj.base_rate if room_obj else 0.0

    cur = req.check_in
    while cur < req.check_out:
        slot_id = f"{body.room_id}_{cur}"
        tr = await db.execute(select(Slot).where(Slot.id == slot_id))
        slot = tr.scalar_one_or_none()
        if slot:
            slot.block_type      = BlockType.SOFT
            slot.booking_id      = booking_id
            slot.channel         = req_channel
            slot.channel_partner = req_partner
        else:
            db.add(Slot(
                id=slot_id,
                room_id=body.room_id,
                date=cur,
                block_type=BlockType.SOFT,
                booking_id=booking_id,
                current_rate=base_rate,
                channel=req_channel,
                channel_partner=req_partner,
            ))
        cur += timedelta(days=1)

    await db.commit()
    return {"booking_id": booking_id, "status": "CONFIRMED", "room_id": body.room_id}


async def find_split_stay(request: BookingRequestIn, db: AsyncSession) -> SplitStayResult:
    """
    Phase 2 — called when ShuffleEngine returned NOT_POSSIBLE.
    Finds a 2–3 segment plan covering all nights across same-category rooms.
    """
    today    = date.today()
    slots    = await _load_category_slots(db, request.category, today)

    # Load floor numbers (SlotInfo is floor-blind — fetch separately)
    rooms_result = await db.execute(
        select(Room.id, Room.floor_number)
        .where(Room.category == request.category, Room.is_active == True)
    )
    floor_map: dict[str, int] = {r[0]: r[1] for r in rooms_result.all()}

    engine = SplitStayEngine(slots, floor_map)
    plan   = engine.search(request.category, request.check_in, request.check_out)

    if plan.state != "SPLIT_POSSIBLE":
        return SplitStayResult(state="NOT_POSSIBLE", message=plan.message)

    return SplitStayResult(
        state        = "SPLIT_POSSIBLE",
        discount_pct = plan.discount_pct,
        total_nights = plan.total_nights,
        total_rate   = plan.total_rate,
        message      = plan.message,
        segments     = [
            SplitSegmentOut(
                room_id         = s.room_id,
                floor           = s.floor,
                check_in        = s.check_in,
                check_out       = s.check_out,
                nights          = s.nights,
                base_rate       = s.base_rate,
                discounted_rate = s.discounted_rate,
            )
            for s in plan.segments
        ],
    )


async def find_split_stay_flex(request: BookingRequestIn, db: AsyncSession) -> SplitStayResult:
    """
    Phase 2 (flex) — propose a split stay across ANY categories, while strongly
    preferring the guest's requested category and adjacent categories (±1).
    """
    today = date.today()

    categories = [
        RoomCategory.ECONOMY,
        RoomCategory.STANDARD,
        RoomCategory.STUDIO,
        RoomCategory.DELUXE,
        RoomCategory.PREMIUM,
        RoomCategory.SUITE,
    ]
    slots = await _load_slots_for_categories(db, categories, today)

    rooms_result = await db.execute(
        select(Room.id, Room.floor_number)
        .where(Room.category.in_(categories), Room.is_active == True)
    )
    floor_map: dict[str, int] = {r[0]: r[1] for r in rooms_result.all()}

    engine = SplitStayFlexEngine(slots, floor_map, request.category)
    plan = engine.search(request.check_in, request.check_out)

    if plan.state != "SPLIT_POSSIBLE":
        return SplitStayResult(state="NOT_POSSIBLE", message=plan.message)

    return SplitStayResult(
        state="SPLIT_POSSIBLE",
        discount_pct=plan.discount_pct,
        total_nights=plan.total_nights,
        total_rate=plan.total_rate,
        message=plan.message,
        segments=[
            SplitSegmentOut(
                room_id=s.room_id,
                category=s.category,
                floor=s.floor,
                check_in=s.check_in,
                check_out=s.check_out,
                nights=s.nights,
                base_rate=s.base_rate,
                discounted_rate=s.discounted_rate,
            )
            for s in plan.segments
        ],
    )


async def confirm_split_stay(body: SplitStayConfirm, db: AsyncSession) -> dict:
    """
    Phase 2 — commit a multi-segment split stay atomically.
    Creates one Booking per segment, all sharing a stay_group_id.
    """
    today    = date.today()
    max_date = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)
    group_id = str(uuid.uuid4())[:8].upper()
    booking_ids: list[str] = []

    try:
        split_channel = Channel(body.channel or "DIRECT")
    except ValueError:
        split_channel = Channel.DIRECT
    split_partner = body.channel_partner or None

    for idx, seg in enumerate(body.segments):
        if seg.check_in < today:
            raise HTTPException(status_code=400, detail="Segment check_in is in the past")
        if seg.check_out > max_date:
            raise HTTPException(status_code=400, detail="Segment check_out exceeds booking window")

        booking_id = str(uuid.uuid4())[:8].upper()
        booking_ids.append(booking_id)

        booking = Booking(
            id              = booking_id,
            guest_name      = body.guest_name,
            room_category   = body.category,
            assigned_room_id= seg.room_id,
            check_in        = seg.check_in,
            check_out       = seg.check_out,
            is_live         = False,
            created_at      = datetime.utcnow(),
            stay_group_id   = group_id,
            segment_index   = idx,
            discount_pct    = body.discount_pct,
        )
        db.add(booking)
        await db.flush()

        # Block the slots for this segment
        room_result = await db.execute(select(Room).where(Room.id == seg.room_id))
        room_obj    = room_result.scalar_one_or_none()
        rate        = seg.discounted_rate if seg.discounted_rate else (room_obj.base_rate if room_obj else 0.0)

        cur = seg.check_in
        while cur < seg.check_out:
            slot_id = f"{seg.room_id}_{cur}"
            tr      = await db.execute(select(Slot).where(Slot.id == slot_id))
            slot    = tr.scalar_one_or_none()
            if slot:
                slot.block_type      = BlockType.SOFT
                slot.booking_id      = booking_id
                slot.channel         = split_channel
                slot.channel_partner = split_partner
            else:
                db.add(Slot(
                    id              = slot_id,
                    room_id         = seg.room_id,
                    date            = cur,
                    block_type      = BlockType.SOFT,
                    booking_id      = booking_id,
                    current_rate    = rate,
                    channel         = split_channel,
                    channel_partner = split_partner,
                ))
            cur += timedelta(days=1)

    await db.commit()
    return {
        "stay_group_id": group_id,
        "booking_ids":   booking_ids,
        "status":        "CONFIRMED",
        "segments":      len(body.segments),
        "discount_pct":  body.discount_pct,
    }


async def list_bookings(db: AsyncSession) -> list[dict]:
    result = await db.execute(
        select(Booking).order_by(Booking.created_at.desc()).limit(50)
    )
    return [
        {
            "id": b.id,
            "guest_name": b.guest_name,
            "category": b.room_category,
            "room_id": b.assigned_room_id,
            "check_in": str(b.check_in),
            "check_out": str(b.check_out),
            "is_live": b.is_live,
        }
        for b in result.scalars().all()
    ]
