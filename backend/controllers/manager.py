"""
Manager controller — stateless T1 calendar optimisation.

Flow:
  1. POST /manager/optimise  → run algorithm, return swap plan in HTTP response (no DB write)
  2. POST /manager/commit    → accept that plan, apply moves to slots table atomically
"""

from __future__ import annotations
import logging
import uuid
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, Booking, BlockType, Channel, RoomCategory
from core.schemas.manager import SwapStep, GapInfo, OptimiseResult, CommitRequest, CommitResult, ChannelAllocateRequest, ChannelAllocateResult
from core.schemas.analytics import ChannelRecommendResponse, ChannelRecommendation
from services.algorithm.calendar_optimiser import GapDetector, SlotInfo
from services.ai.channel_agent import run_channel_agent

logger = logging.getLogger(__name__)


async def _load_slots(db: AsyncSession, today: date) -> list[SlotInfo]:
    end = today + timedelta(days=settings.SCAN_WINDOW_DAYS)
    result = await db.execute(
        select(Slot, Room)
        .join(Room, Slot.room_id == Room.id)
        .where(Slot.date >= today, Slot.date < end)
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


async def run_optimisation(db: AsyncSession) -> OptimiseResult:
    """
    Run the full T1 HHI optimisation pipeline.
    Returns the complete global swap plan in memory — nothing is written to the DB.
    """
    today = date.today()
    slots = await _load_slots(db, today)
    detector = GapDetector(slots, today)
    
    # run() now returns (gaps, all_steps) — 'all_steps' is the global master plan
    gaps, all_steps_raw = detector.run()

    # Convert raw dicts from the algorithm into SwapStep schemas
    full_swap_plan = [SwapStep(**s) for s in all_steps_raw]

    # Map specific steps to specific gaps for UI highlights
    gap_infos: list[GapInfo] = []
    for gap in gaps:
        if not gap.shuffle_possible or not gap.shuffle_plan:
            continue
        gap_infos.append(GapInfo(
            room_id=gap.room_id,
            category=str(gap.category),
            date_range=gap.date_range_str,
            gap_length=gap.gap_length,
            shuffle_plan=[SwapStep(**s) for s in gap.shuffle_plan],
        ))

    shuffle_count = len(full_swap_plan)
    fully_clean = len(gaps) == 0
    # converged: orphan gaps exist but the global optimum has already been reached
    # (no rearrangement can eliminate them — they are structural)
    converged = (not fully_clean) and shuffle_count == 0

    logger.info(
        "T1 optimise: %d gaps found, %d total moves, converged=%s, fully_clean=%s",
        len(gaps), shuffle_count, converged, fully_clean,
    )

    return OptimiseResult(
        gaps_found=len(gaps),
        shuffle_count=shuffle_count,
        converged=converged,
        fully_clean=fully_clean,
        swap_plan=full_swap_plan,
        gaps=gap_infos,
    )


async def commit_plan(body: CommitRequest, db: AsyncSession) -> CommitResult:
    """
    Atomically apply a swap plan to the slots table.
    
    Uses a two-pass approach within a single transaction:
      1. VACATE: Clear all source slots for all bookings in the plan.
      2. FILL: Assign bookings to their new destination slots.
    
    This handles circular dependencies (e.g., A moves to B's room, B moves to C's room).
    """
    applied = 0
    slots_updated = 0

    # PASS 1: VACATE all source slots — capture channel/partner before clearing
    # Maps booking_id → (channel, channel_partner) for use in PASS 2
    booking_channel: dict[str, tuple] = {}

    for step in body.swap_plan:
        for date_str in step.dates:
            d = date.fromisoformat(date_str)
            from_slot_id = f"{step.from_room}_{d}"

            res = await db.execute(select(Slot).where(Slot.id == from_slot_id))
            slot = res.scalar_one_or_none()

            if slot and slot.booking_id == step.booking_id:
                # Capture channel attribution before clearing
                if step.booking_id not in booking_channel:
                    booking_channel[step.booking_id] = (slot.channel, slot.channel_partner)
                slot.block_type      = BlockType.EMPTY
                slot.booking_id      = None
                slot.channel_partner = None
                slots_updated += 1
            else:
                logger.debug("Vacate skipped for %s (already empty or changed)", from_slot_id)

    # PASS 2: FILL all destination slots, restoring original channel attribution
    for step in body.swap_plan:
        to_room    = step.to_room
        booking_id = step.booking_id
        orig_channel, orig_partner = booking_channel.get(booking_id, (None, None))

        for date_str in step.dates:
            d = date.fromisoformat(date_str)
            to_slot_id = f"{to_room}_{d}"

            tr = await db.execute(select(Slot).where(Slot.id == to_slot_id))
            to_slot = tr.scalar_one_or_none()

            if to_slot:
                if to_slot.block_type != BlockType.EMPTY:
                    logger.warning("Collision at %s while filling booking %s", to_slot_id, booking_id)
                    continue

                to_slot.block_type      = BlockType.SOFT
                to_slot.booking_id      = booking_id
                to_slot.channel         = orig_channel
                to_slot.channel_partner = orig_partner
                slots_updated += 1
            else:
                room_res = await db.execute(select(Room).where(Room.id == to_room))
                room_obj = room_res.scalar_one_or_none()
                db.add(Slot(
                    id=to_slot_id,
                    room_id=to_room,
                    date=d,
                    block_type=BlockType.SOFT,
                    booking_id=booking_id,
                    current_rate=room_obj.base_rate if room_obj else 0.0,
                    channel=orig_channel,
                    channel_partner=orig_partner,
                ))
                slots_updated += 1

        # Update Booking model to stay in sync
        bk_r = await db.execute(select(Booking).where(Booking.id == booking_id))
        bk = bk_r.scalar_one_or_none()
        if bk:
            bk.assigned_room_id = to_room

        applied += 1

    await db.commit()
    logger.info("Commit plan: %d steps applied, %d slot rows updated", applied, slots_updated)
    return CommitResult(applied=applied, slots_updated=slots_updated)


# ── Booking source → channel enum mapping ─────────────────────────────────────
_OTA_PARTNERS = {"MakeMyTrip", "Goibibo", "Agoda", "Booking.com", "Expedia"}
_GDS_PARTNERS = {"Amadeus", "Sabre", "Travelport"}


def _resolve_channel(booking_source: str) -> tuple[Channel, str | None]:
    """
    Map a single 'booking source' label to (Channel enum, partner name | None).
    Business rule: there are only two routes — channel (OTA/GDS) or direct.
    """
    if booking_source in _OTA_PARTNERS:
        return Channel.OTA, booking_source
    if booking_source in _GDS_PARTNERS:
        return Channel.GDS, booking_source
    if booking_source == "Walk-in":
        return Channel.WALKIN, None
    return Channel.DIRECT, None  # "Direct" and anything else


async def channel_allocate(body: ChannelAllocateRequest, db: AsyncSession) -> ChannelAllocateResult:
    """
    Pre-allocate inventory to a booking source for a date range.

    For each night in [check_in, check_out) we find up to `room_count` EMPTY
    rooms of the requested category and create a SOFT-blocked placeholder booking
    tagged with the correct channel + partner. The manager can later hand these
    to the OTA allotment or assign real guest names via receptionist.
    """
    try:
        cat = RoomCategory(body.category)
    except ValueError:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=f"Unknown category: {body.category}")

    ch, partner = _resolve_channel(body.booking_source)

    check_in  = date.fromisoformat(body.check_in)
    check_out = date.fromisoformat(body.check_out)
    if check_out <= check_in:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="check_out must be after check_in")

    # Fetch all active rooms of requested category
    rooms_res = await db.execute(
        select(Room).where(Room.category == cat, Room.is_active == True)
    )
    rooms = rooms_res.scalars().all()
    if not rooms:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"No active rooms for category {body.category}")

    # Load existing slots in the window to know which rooms are free each night
    slots_res = await db.execute(
        select(Slot).where(
            Slot.room_id.in_([r.id for r in rooms]),
            Slot.date >= check_in,
            Slot.date < check_out,
            Slot.block_type != BlockType.EMPTY,
        )
    )
    occupied: set[str] = {s.id for s in slots_res.scalars().all()}  # "room_date"

    booking_ids: list[str] = []
    allocated_rooms: set[str] = set()
    total_slots = 0

    # Create one booking per requested room (up to room_count)
    rooms_needed = min(body.room_count, len(rooms))
    nights = list(_iter_nights(check_in, check_out))

    for room in rooms:
        if len(booking_ids) >= rooms_needed:
            break

        # Check if this room is free every night in the range
        if any(f"{room.id}_{n}" in occupied for n in nights):
            continue

        bid = str(uuid.uuid4())[:8].upper()
        label = partner or ("Walk-in" if ch == Channel.WALKIN else "Direct")
        from datetime import datetime as _dt
        booking = Booking(
            id=bid,
            guest_name=f"[{label}] Allotment",
            room_category=cat,
            assigned_room_id=room.id,
            check_in=check_in,
            check_out=check_out,
            is_live=False,
            created_at=_dt.utcnow(),
        )
        db.add(booking)
        await db.flush()

        for night in nights:
            slot_id = f"{room.id}_{night}"
            db.add(Slot(
                id=slot_id,
                room_id=room.id,
                date=night,
                block_type=BlockType.SOFT,
                booking_id=bid,
                current_rate=room.base_rate,
                channel=ch,
                channel_partner=partner,
            ))
            total_slots += 1

        booking_ids.append(bid)
        allocated_rooms.add(room.id)

    await db.commit()

    source_label = partner or ("Walk-in" if ch == Channel.WALKIN else "Direct")
    if not booking_ids:
        msg = f"No free {body.category} rooms found for {body.check_in} → {body.check_out}."
    else:
        msg = (
            f"Allocated {len(booking_ids)} {body.category} room(s) to {source_label} "
            f"for {body.check_in} → {body.check_out} ({len(nights)} nights, {total_slots} slots)."
        )

    return ChannelAllocateResult(
        allocated=total_slots,
        rooms=list(allocated_rooms),
        booking_ids=booking_ids,
        message=msg,
    )


def _iter_nights(start: date, end: date):
    cur = start
    while cur < end:
        yield cur
        cur += timedelta(days=1)


async def get_channel_recommendations(db: AsyncSession) -> ChannelRecommendResponse:
    """
    Build occupancy context snapshot and invoke the Gemini channel agent.
    Returns AI-generated channel allocation recommendations.
    """
    today = date.today()
    look_end = today + timedelta(days=14)

    rows = (await db.execute(
        select(Room.category, Slot.date, Slot.block_type)
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= today,
            Slot.date < look_end,
        )
        .order_by(Slot.date)
    )).all()

    # Build per-category daily occupancy summary
    from collections import defaultdict
    cat_date: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"total": 0, "occupied": 0}))
    for cat, d, block_type in rows:
        ds = d.isoformat()
        cat_date[cat.value][ds]["total"] += 1
        if block_type != BlockType.EMPTY:
            cat_date[cat.value][ds]["occupied"] += 1

    lines = []
    for cat, dates in sorted(cat_date.items()):
        lines.append(f"\n{cat}:")
        for ds in sorted(dates.keys()):
            info = dates[ds]
            occ_pct = round(info["occupied"] / info["total"] * 100) if info["total"] else 0
            empty = info["total"] - info["occupied"]
            dow = date.fromisoformat(ds).strftime("%a")
            lines.append(f"  {ds} ({dow}): {occ_pct}% occ, {empty}/{info['total']} empty")

    context_text = "\n".join(lines) if lines else "No inventory data available."

    raw = await run_channel_agent(context_text, today, db)

    recs = [
        ChannelRecommendation(**r)
        for r in raw.get("recommendations", [])
    ]
    return ChannelRecommendResponse(
        as_of=today.isoformat(),
        analysis_window_days=14,
        recommendations=recs,
        summary=raw.get("summary", ""),
    )
