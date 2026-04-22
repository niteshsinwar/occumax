"""
Admin controller — room CRUD, slot manual patching, category stats.

No price overrides. No WebSocket.
"""

from datetime import date, timedelta
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, BlockType, Booking, Channel
from core.schemas import RoomCreate, RoomUpdate
from services.analytics.seed_history import seed_analytics_history as seedAnalyticsHistory


async def list_rooms(db: AsyncSession) -> list[dict]:
    result = await db.execute(select(Room).order_by(Room.category, Room.id))
    rooms = result.scalars().all()

    today = date.today()
    end = today + timedelta(days=settings.SCAN_WINDOW_DAYS)
    slots_result = await db.execute(
        select(Slot).where(Slot.date >= today, Slot.date < end)
    )
    slots = slots_result.scalars().all()
    slot_map: dict[str, list] = {}
    for s in slots:
        slot_map.setdefault(s.room_id, []).append(s)

    out = []
    for r in rooms:
        room_slots = slot_map.get(r.id, [])
        empty  = sum(1 for s in room_slots if s.block_type == BlockType.EMPTY)
        booked = sum(1 for s in room_slots if s.block_type == BlockType.SOFT)
        out.append({
            "id": r.id,
            "category": r.category,
            "base_rate": r.base_rate,
            "floor_number": r.floor_number,
            "is_active": r.is_active,
            "stats": {
                "total_slots": len(room_slots),
                "empty_nights": empty,
                "booked_nights": booked,
                "occupancy_pct": round(booked / len(room_slots) * 100, 1) if room_slots else 0,
            },
        })
    return out


async def add_room(body: RoomCreate, db: AsyncSession) -> dict:
    existing = await db.execute(select(Room).where(Room.id == body.id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Room {body.id} already exists")

    room = Room(
        id=body.id,
        category=body.category,
        base_rate=body.base_rate,
        floor_number=body.floor_number,
        is_active=True,
    )
    db.add(room)

    today = date.today()
    for i in range(settings.SCAN_WINDOW_DAYS):
        d = today + timedelta(days=i)
        db.add(Slot(
            id=f"{body.id}_{d}",
            room_id=body.id,
            date=d,
            block_type=BlockType.EMPTY,
            current_rate=body.base_rate,
        ))

    await db.commit()
    return {"status": "created", "room_id": body.id}


async def update_room(room_id: str, body: RoomUpdate, db: AsyncSession) -> dict:
    result = await db.execute(select(Room).where(Room.id == room_id))
    room = result.scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if body.category is not None:
        room.category = body.category
    if body.base_rate is not None:
        room.base_rate = body.base_rate
    if body.floor_number is not None:
        room.floor_number = body.floor_number
    if body.is_active is not None:
        room.is_active = body.is_active

    await db.commit()
    return {"status": "updated", "room_id": room_id}


async def deactivate_room(room_id: str, db: AsyncSession) -> dict:
    result = await db.execute(select(Room).where(Room.id == room_id))
    room = result.scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    room.is_active = False
    await db.commit()
    return {"status": "deactivated", "room_id": room_id}


async def list_categories(db: AsyncSession) -> list[dict]:
    result = await db.execute(select(Room).where(Room.is_active == True))
    rooms = result.scalars().all()

    stats: dict[str, dict] = {}
    for r in rooms:
        if r.category not in stats:
            stats[r.category] = {"count": 0, "rates": []}
        stats[r.category]["count"] += 1
        stats[r.category]["rates"].append(r.base_rate)

    return [
        {
            "name": cat,
            "room_count": data["count"],
            "avg_base_rate": round(sum(data["rates"]) / len(data["rates"]), 2),
            "min_rate": min(data["rates"]),
            "max_rate": max(data["rates"]),
        }
        for cat, data in sorted(stats.items())
    ]


class SlotPatch(BaseModel):
    block_type: str  # EMPTY | HARD
    reason: Optional[str] = None


async def patch_slot(slot_id: str, body: SlotPatch, db: AsyncSession) -> dict:
    """Manually open (EMPTY) or hard-block (HARD) a slot. SOFT slots cannot be patched."""
    if body.block_type not in ("EMPTY", "HARD"):
        raise HTTPException(status_code=400, detail="block_type must be EMPTY or HARD")

    result = await db.execute(select(Slot).where(Slot.id == slot_id))
    slot = result.scalar_one_or_none()
    if not slot:
        raise HTTPException(status_code=404, detail=f"Slot {slot_id} not found")

    if slot.block_type == BlockType.SOFT:
        raise HTTPException(
            status_code=409,
            detail="Cannot manually change a SOFT slot — guest booking exists."
        )

    prev = slot.block_type
    slot.block_type = body.block_type
    await db.commit()

    return {
        "status": "updated",
        "slot_id": slot_id,
        "prev": prev,
        "new": body.block_type,
    }


class SeedAnalyticsHistoryRequest(BaseModel):
    start: date
    end: date
    fill_pct: int = 35


async def seed_analytics_history(db: AsyncSession, body: SeedAnalyticsHistoryRequest) -> dict:
    """
    Seed historical demo data for analytics predictions.

    This is intended for demos/dev environments so the Bird's Eye AI forecast has
    1y/2y-back data to compute predicted final occupancy and likelihood.
    """
    try:
        fillPct = max(0, min(100, int(body.fill_pct)))
        result = await seedAnalyticsHistory(
            db=db,
            target_start=body.start,
            target_end=body.end,
            window_days=21,
            fill_pct=fillPct,
        )
        return {
            "status": "ok",
            "start": str(body.start),
            "end": str(body.end),
            "fill_pct": fillPct,
            **result,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class AdminBookingUpdate(BaseModel):
    guest_name: Optional[str] = None
    room_id: Optional[str] = None
    check_in: Optional[date] = None
    check_out: Optional[date] = None
    category: Optional[str] = None


def _parse_iso_date(value: str | None, name: str) -> Optional[date]:
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except Exception:
        raise HTTPException(status_code=400, detail=f"{name} must be an ISO date (YYYY-MM-DD)")


async def admin_list_bookings(db: AsyncSession, start: str | None, end: str | None) -> list[dict]:
    """
    Admin list bookings with an optional stay-date overlap filter.

    Filter semantics:
    - If both start/end provided: booking overlaps [start, end)
      (check_in < end) AND (check_out > start)
    - If only start: booking.check_out > start
    - If only end: booking.check_in < end
    """
    start_d = _parse_iso_date(start, "start")
    end_d = _parse_iso_date(end, "end")
    if start_d and end_d and end_d <= start_d:
        raise HTTPException(status_code=400, detail="end must be after start")

    stmt = select(Booking).order_by(Booking.created_at.desc())
    if start_d and end_d:
        stmt = stmt.where(Booking.check_in < end_d, Booking.check_out > start_d)
    elif start_d:
        stmt = stmt.where(Booking.check_out > start_d)
    elif end_d:
        stmt = stmt.where(Booking.check_in < end_d)

    result = await db.execute(stmt.limit(500))
    bookings = result.scalars().all()

    return [
        {
            "id": b.id,
            "guest_name": b.guest_name,
            "category": b.room_category,
            "room_id": b.assigned_room_id,
            "check_in": str(b.check_in),
            "check_out": str(b.check_out),
            "created_at": b.created_at.isoformat() if b.created_at else None,
            "stay_group_id": b.stay_group_id,
            "segment_index": b.segment_index,
            "discount_pct": b.discount_pct,
        }
        for b in bookings
    ]


async def admin_delete_booking(booking_id: str, db: AsyncSession) -> dict:
    """
    Delete a booking row and free any slots referencing it.
    """
    bk_res = await db.execute(select(Booking).where(Booking.id == booking_id))
    booking = bk_res.scalar_one_or_none()
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")

    slots_res = await db.execute(select(Slot).where(Slot.booking_id == booking_id))
    slots = slots_res.scalars().all()
    for s in slots:
        s.block_type = BlockType.EMPTY
        s.booking_id = None

    await db.delete(booking)
    await db.commit()
    return {"status": "deleted", "booking_id": booking_id, "slots_freed": len(slots)}


async def admin_update_booking(booking_id: str, body: AdminBookingUpdate, db: AsyncSession) -> dict:
    """
    Update a booking. If dates or room change, slots are re-synced for this booking_id.

    Constraints:
    - New stay window must have check_out > check_in.
    - Target slots in [check_in, check_out) must not be HARD or booked by a different booking.
    """
    bk_res = await db.execute(select(Booking).where(Booking.id == booking_id))
    booking = bk_res.scalar_one_or_none()
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")

    prev_room_id = booking.assigned_room_id
    prev_ci = booking.check_in
    prev_co = booking.check_out

    next_room_id = body.room_id if body.room_id is not None else booking.assigned_room_id
    next_ci = body.check_in if body.check_in is not None else booking.check_in
    next_co = body.check_out if body.check_out is not None else booking.check_out

    if next_ci and next_co and next_co <= next_ci:
        raise HTTPException(status_code=400, detail="check_out must be after check_in")

    if body.guest_name is not None:
        booking.guest_name = body.guest_name
    if body.category is not None:
        booking.room_category = body.category

    must_resync = (next_room_id != prev_room_id) or (next_ci != prev_ci) or (next_co != prev_co)

    if not must_resync:
        await db.commit()
        return {"status": "updated", "booking_id": booking_id}

    if not next_room_id:
        raise HTTPException(status_code=400, detail="room_id is required for re-sync")

    room_res = await db.execute(select(Room).where(Room.id == next_room_id))
    room = room_res.scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="Target room not found")

    # Preserve channel attribution from any existing slot on this booking (best effort).
    prev_slots_res = await db.execute(select(Slot).where(Slot.booking_id == booking_id))
    prev_slots = prev_slots_res.scalars().all()
    ch = prev_slots[0].channel if prev_slots else Channel.DIRECT
    partner = prev_slots[0].channel_partner if prev_slots else None

    # Validate target window availability.
    cur = next_ci
    while cur < next_co:
        target_slot_id = f"{next_room_id}_{cur}"
        tr = await db.execute(select(Slot).where(Slot.id == target_slot_id))
        slot = tr.scalar_one_or_none()
        if slot:
            if slot.block_type == BlockType.HARD:
                raise HTTPException(status_code=409, detail=f"Target slot {target_slot_id} is HARD blocked")
            if slot.booking_id and slot.booking_id != booking_id:
                raise HTTPException(status_code=409, detail=f"Target slot {target_slot_id} is booked by another booking")
        cur += timedelta(days=1)

    # Clear previous slots for this booking.
    for s in prev_slots:
        s.block_type = BlockType.EMPTY
        s.booking_id = None

    # Apply new slot blocks.
    cur = next_ci
    updated = 0
    created = 0
    while cur < next_co:
        target_slot_id = f"{next_room_id}_{cur}"
        tr = await db.execute(select(Slot).where(Slot.id == target_slot_id))
        slot = tr.scalar_one_or_none()
        if slot:
            slot.block_type = BlockType.SOFT
            slot.booking_id = booking_id
            slot.channel = ch
            slot.channel_partner = partner
            if not slot.current_rate:
                slot.current_rate = room.base_rate
            updated += 1
        else:
            db.add(Slot(
                id=target_slot_id,
                room_id=next_room_id,
                date=cur,
                block_type=BlockType.SOFT,
                booking_id=booking_id,
                current_rate=room.base_rate,
                channel=ch,
                channel_partner=partner,
            ))
            created += 1
        cur += timedelta(days=1)

    booking.assigned_room_id = next_room_id
    booking.check_in = next_ci
    booking.check_out = next_co

    await db.commit()
    return {
        "status": "updated",
        "booking_id": booking_id,
        "slots_cleared": len(prev_slots),
        "slots_updated": updated,
        "slots_created": created,
    }
