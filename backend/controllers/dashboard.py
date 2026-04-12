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
from core.models import Room, Slot, BlockType
from core.schemas import HeatmapCell, HeatmapRow, HeatmapResponse
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


