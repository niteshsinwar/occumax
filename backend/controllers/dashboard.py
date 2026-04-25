"""
Dashboard controller — heatmap and live gap summary.

All data is computed live from the slots table.
No recommendation or trigger_run tables involved.
"""

from __future__ import annotations
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, BlockType, RoomCategory, Channel
from core.schemas import HeatmapCell, HeatmapRow, HeatmapResponse
from core.schemas.dashboard_optimise import DashboardOptimisePreviewResponse
from core.schemas.sandwich_playbook import SandwichPlaybookResponse
from core.schemas.manager import SwapStep
from services.algorithm.calendar_optimiser import GapDetector, SlotInfo


def _fill_prob(gap_length: int) -> float:
    """Deterministic fill probability by gap length."""
    return {1: 0.10, 2: 0.30, 3: 0.55, 4: 0.70}.get(gap_length, 0.75)


def _slots_to_slotinfo(slots: list, room_map: dict) -> list[SlotInfo]:
    result = []
    for s in slots:
        room = room_map.get(s.room_id)
        if not room:
            continue
        result.append(SlotInfo(
            slot_id=s.id,
            room_id=s.room_id,
            category=room.category,
            date=s.date,
            block_type=s.block_type,
            booking_id=s.booking_id,
            base_rate=room.base_rate,
            current_rate=s.current_rate,
            channel=s.channel,
            min_stay_active=s.min_stay_active,
            min_stay_nights=s.min_stay_nights,
        ))
    return result


async def get_heatmap(db: AsyncSession) -> HeatmapResponse:
    today = date.today()
    dates = [today + timedelta(days=i) for i in range(settings.SCAN_WINDOW_DAYS)]

    rooms_result = await db.execute(
        select(Room).where(Room.is_active == True).order_by(Room.category, Room.id)
    )
    rooms = rooms_result.scalars().all()
    room_map = {r.id: r for r in rooms}

    slots_result = await db.execute(
        select(Slot).where(
            Slot.date >= today,
            Slot.date < today + timedelta(days=settings.SCAN_WINDOW_DAYS),
        )
    )
    slots = slots_result.scalars().all()
    slot_map: dict[str, Slot] = {s.id: s for s in slots}

    # Live gap metrics
    slot_infos = _slots_to_slotinfo(slots, room_map)
    detector   = GapDetector(slot_infos, today)
    gaps       = detector.detect_gaps()
    orphan_nights = sum(g.gap_length for g in gaps)
    est_lost = round(sum(
        (1 - _fill_prob(g.gap_length)) * g.current_rate * g.gap_length
        for g in gaps
    ), 2)

    rows = []
    for room in rooms:
        cells = []
        for d in dates:
            slot_id = f"{room.id}_{d}"
            slot = slot_map.get(slot_id)
            cells.append(HeatmapCell(
                slot_id=slot_id,
                room_id=room.id,
                date=d,
                block_type=slot.block_type if slot else BlockType.EMPTY,
                category=room.category,
                current_rate=slot.current_rate if slot else room.base_rate,
                booking_id=slot.booking_id if slot else None,
                channel=slot.channel if slot else None,
                min_stay_active=slot.min_stay_active if slot else False,
                min_stay_nights=slot.min_stay_nights if slot else 1,
            ))
        rows.append(HeatmapRow(
            room_id=room.id,
            category=room.category,
            base_rate=room.base_rate,
            cells=cells,
        ))

    return HeatmapResponse(
        dates=dates,
        rows=rows,
        summary={
            "total_orphan_nights": orphan_nights,
            "estimated_lost_revenue": est_lost,
        },
    )


async def optimise_preview(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
) -> DashboardOptimisePreviewResponse:
    """
    Run the calendar optimiser in memory for a scoped slice of the hotel calendar.

    - Scope is limited to the provided date window and categories.
    - Nothing is written to the DB; the response is meant for UI simulation only.
    """
    today = date.today()
    cats = list(dict.fromkeys(categories))  # stable dedupe

    rooms_q = select(Room).where(Room.is_active == True)
    if cats:
        rooms_q = rooms_q.where(Room.category.in_(cats))
    rooms_q = rooms_q.order_by(Room.category, Room.id)
    rooms = (await db.execute(rooms_q)).scalars().all()
    room_map = {r.id: r for r in rooms}

    slots_q = (
        select(Slot)
        .where(
            Slot.date >= start,
            Slot.date < end,
            Slot.room_id.in_(list(room_map.keys())) if room_map else False,
        )
    )
    slots = (await db.execute(slots_q)).scalars().all()

    slot_infos = _slots_to_slotinfo(slots, room_map)
    detector = GapDetector(slot_infos, today)
    gaps, all_steps_raw = detector.run()

    swap_plan = [SwapStep(**s) for s in all_steps_raw]
    shuffle_count = len(swap_plan)
    fully_clean = len(gaps) == 0
    converged = (not fully_clean) and shuffle_count == 0

    return DashboardOptimisePreviewResponse(
        gaps_found=len(gaps),
        shuffle_count=shuffle_count,
        converged=converged,
        fully_clean=fully_clean,
        swap_plan=swap_plan,
    )


async def apply_sandwich_playbook(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
) -> SandwichPlaybookResponse:
    """
    Apply the sandwich-night playbook for the given slice:
    - Finds single-night EMPTY slots bounded by non-EMPTY on both sides in the same room.
    - For those dates, relax MinLOS to 1 night (min_stay_active=True, min_stay_nights=1).
    """
    cats = list(dict.fromkeys(categories))  # stable dedupe

    rooms_q = select(Room).where(Room.is_active == True)
    if cats:
        rooms_q = rooms_q.where(Room.category.in_(cats))
    rooms_q = rooms_q.order_by(Room.category, Room.id)
    rooms = (await db.execute(rooms_q)).scalars().all()
    room_map = {r.id: r for r in rooms}
    if not room_map:
        return SandwichPlaybookResponse(
            start=start,
            end=end,
            categories=cats,
            orphan_slots_found=0,
            slots_updated=0,
        )

    slots_q = (
        select(Slot)
        .where(
            Slot.date >= start,
            Slot.date < end,
            Slot.room_id.in_(list(room_map.keys())),
        )
    )
    slots = (await db.execute(slots_q)).scalars().all()
    slot_by_id: dict[str, Slot] = {s.id: s for s in slots}

    orphan_slot_ids: list[str] = []
    slots_updated = 0

    scan_dates = []
    cur = start
    while cur < end:
        scan_dates.append(cur)
        cur += timedelta(days=1)

    for room_id in room_map.keys():
        # Build per-date block_type for this room; missing slot = EMPTY
        room_cells: list[tuple[date, BlockType]] = []
        for d in scan_dates:
            sid = f"{room_id}_{d}"
            s = slot_by_id.get(sid)
            room_cells.append((d, s.block_type if s else BlockType.EMPTY))

        # Detect sandwich single nights: EMPTY bounded on both sides
        for i in range(1, len(room_cells) - 1):
            d, bt = room_cells[i]
            if bt != BlockType.EMPTY:
                continue
            before_bt = room_cells[i - 1][1]
            after_bt = room_cells[i + 1][1]
            if before_bt == BlockType.EMPTY or after_bt == BlockType.EMPTY:
                continue

            sid = f"{room_id}_{d}"
            orphan_slot_ids.append(sid)

            slot = slot_by_id.get(sid)
            if not slot:
                room = room_map[room_id]
                slot = Slot(
                    id=sid,
                    room_id=room_id,
                    date=d,
                    block_type=BlockType.EMPTY,
                    booking_id=None,
                    current_rate=room.base_rate,
                    channel=Channel.DIRECT,
                    channel_partner=None,
                    min_stay_active=True,
                    min_stay_nights=1,
                )
                db.add(slot)
                slot_by_id[sid] = slot
                slots_updated += 1
                continue

            # Only update if not already relaxed
            if (not slot.min_stay_active) or (slot.min_stay_nights != 1):
                slot.min_stay_active = True
                slot.min_stay_nights = 1
                slots_updated += 1

    if slots_updated:
        await db.commit()

    return SandwichPlaybookResponse(
        start=start,
        end=end,
        categories=cats,
        orphan_slots_found=len(orphan_slot_ids),
        slots_updated=slots_updated,
    )


