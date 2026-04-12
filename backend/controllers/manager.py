"""
Manager controller — stateless T1 calendar optimisation.

Flow:
  1. POST /manager/optimise  → run algorithm, return swap plan in HTTP response (no DB write)
  2. POST /manager/commit    → accept that plan, apply moves to slots table atomically
"""

from __future__ import annotations
import logging
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, Booking, BlockType
from core.schemas.manager import SwapStep, GapInfo, OptimiseResult, CommitRequest, CommitResult
from services.algorithm.calendar_optimiser import GapDetector, SlotInfo

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

    # PASS 1: VACATE all source slots
    # We clear the booking_id from the 'from_room' for each step in the plan.
    for step in body.swap_plan:
        for date_str in step.dates:
            d = date.fromisoformat(date_str)
            from_slot_id = f"{step.from_room}_{d}"
            
            res = await db.execute(select(Slot).where(Slot.id == from_slot_id))
            slot = res.scalar_one_or_none()
            
            # Only vacate if it currently holds the booking we expect to move
            if slot and slot.booking_id == step.booking_id:
                slot.block_type = BlockType.EMPTY
                slot.booking_id = None
                slots_updated += 1
            else:
                # If the slot is already empty or held by someone else, we just log it.
                # In a consistent state, it should hold step.booking_id.
                logger.debug("Vacate skipped for %s (already empty or changed)", from_slot_id)

    # PASS 2: FILL all destination slots
    # We assign the booking_id to the 'to_room' for each step in the plan.
    for step in body.swap_plan:
        to_room    = step.to_room
        booking_id = step.booking_id

        for date_str in step.dates:
            d = date.fromisoformat(date_str)
            to_slot_id = f"{to_room}_{d}"

            tr = await db.execute(select(Slot).where(Slot.id == to_slot_id))
            to_slot = tr.scalar_one_or_none()

            if to_slot:
                # Slot already exists in DB
                if to_slot.block_type != BlockType.EMPTY:
                    # Safety check: if it's NOT empty now, it means it wasn't vacated 
                    # in Pass 1 or some other booking occupied it. 
                    logger.warning("Collision at %s while filling booking %s", to_slot_id, booking_id)
                    continue
                
                to_slot.block_type = BlockType.SOFT
                to_slot.booking_id = booking_id
                slots_updated += 1
            else:
                # Slot row doesn't exist yet — create it
                room_res = await db.execute(select(Room).where(Room.id == to_room))
                room_obj = room_res.scalar_one_or_none()
                db.add(Slot(
                    id=to_slot_id,
                    room_id=to_room,
                    date=d,
                    block_type=BlockType.SOFT,
                    booking_id=booking_id,
                    current_rate=room_obj.base_rate if room_obj else 0.0,
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
