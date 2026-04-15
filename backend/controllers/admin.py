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
from core.models import Room, Slot, BlockType
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
