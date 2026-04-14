"""Seed demo historical data for analytics (pace + final-occupancy prediction).

This is used by:
- Admin endpoint `POST /admin/seed-analytics-history` (UI button)

Safety:
- Inserts demo rows for historical windows (~1y and ~2y back).
- Only updates slots when they are currently EMPTY with no booking_id.
- Demo bookings are tagged by guest_name prefix: "DEMO_ANALYTICS".
"""

from __future__ import annotations

import random
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models import Room, Slot, Booking, BlockType, Channel, RoomCategory


DEMO_PREFIX = "DEMO_ANALYTICS"


def _slot_id(room_id: str, d: date) -> str:
    return f"{room_id}_{d}"


def _as_utc_dt(d: date, hour: int) -> datetime:
    return datetime.combine(d, time(hour=hour))

def _hash_seed(seed: int, s: str) -> int:
    # Stable-ish int hash for per-room randomness without importing hashlib.
    acc = seed
    for ch in s:
        acc = (acc * 131 + ord(ch)) % 2_147_483_647
    return acc


async def seed_analytics_history(
    db: AsyncSession,
    window_days: int = 21,
    target_start: date | None = None,
    target_end: date | None = None,
    seed: int = 42,
) -> dict[str, int]:
    as_of = date.today()
    future_start = target_start or as_of
    future_end = target_end or (future_start + timedelta(days=window_days))
    if future_end <= future_start:
        raise RuntimeError("end date must be after start date")

    run_tag = f"{future_start.isoformat()}..{future_end.isoformat()}"

    hist_offsets = [364, 728]  # approx 1y and 2y
    hist_windows = [(future_start - timedelta(days=o), future_end - timedelta(days=o)) for o in hist_offsets]

    rooms = (await db.execute(
        select(Room).where(Room.is_active == True).order_by(Room.category, Room.id)
    )).scalars().all()
    if not rooms:
        raise RuntimeError("No active rooms found. Seed rooms first via Admin UI.")

    rooms_by_cat: dict[RoomCategory, list[Room]] = defaultdict(list)
    for r in rooms:
        rooms_by_cat[r.category].append(r)

    # If demo data already exists for this requested range, skip to avoid duplicates.
    existing_demo = (await db.execute(
        select(Booking.id).where(
            Booking.guest_name.like(f"{DEMO_PREFIX}[{run_tag}]%"),
            Booking.check_out > min(w[0] for w in hist_windows),
            Booking.check_in < max(w[1] for w in hist_windows),
        )
    )).scalars().first()
    if existing_demo:
        return {"skipped": 1}

    rng = random.Random(seed)

    inserted_bookings = 0
    inserted_slots = 0
    updated_slots = 0

    hist_min = min(w[0] for w in hist_windows)
    hist_max = max(w[1] for w in hist_windows)
    existing_slots = (await db.execute(
        select(Slot).where(Slot.date >= hist_min, Slot.date < hist_max)
    )).scalars().all()
    slot_map: dict[str, Slot] = {s.id: s for s in existing_slots}

    def start_prob_for_day(cat: RoomCategory, d: date, room_rng: random.Random) -> float:
        """
        Probability that a room starts a booking on day d.
        Tuned to avoid near-100% occupancy while still producing believable patterns.
        """
        wd = d.weekday()  # 0=Mon..6=Sun
        weekend = wd in (4, 5, 6)

        base = 0.33 if not weekend else 0.45
        cat_bump = {
            RoomCategory.SUITE: 0.06,
            RoomCategory.DELUXE: 0.04,
            RoomCategory.STANDARD: 0.02,
        }.get(cat, 0.02)

        # Add small per-room/day jitter.
        jitter = room_rng.uniform(-0.06, 0.06)
        return max(0.10, min(0.75, base + cat_bump + jitter))

    for (hstart, hend) in hist_windows:
        # For each room, generate a realistic sequence of bookings/gaps across the window.
        for cat, cat_rooms in rooms_by_cat.items():
            for room in cat_rooms:
                room_rng = random.Random(_hash_seed(seed, f"{room.id}:{hstart.isoformat()}"))
                cur = hstart
                while cur < hend:
                    # Probabilistic booking start with weekday/weekend seasonality and jitter.
                    if room_rng.random() >= start_prob_for_day(cat, cur, room_rng):
                        cur += timedelta(days=1)
                        continue

                    los = room_rng.choices([1, 2, 3, 4], weights=[12, 36, 34, 18], k=1)[0]
                    check_in = cur
                    check_out = min(hend, cur + timedelta(days=los))
                    if check_out <= check_in:
                        cur += timedelta(days=1)
                        continue

                    lead = room_rng.randint(3, 35)
                    created_at = _as_utc_dt(check_in - timedelta(days=lead), hour=room_rng.randint(8, 18))

                    booking = Booking(
                        id=str(uuid.uuid4())[:8].upper(),
                        guest_name=f"{DEMO_PREFIX}[{run_tag}] {cat} {room.id}",
                        room_category=cat,
                        assigned_room_id=room.id,
                        check_in=check_in,
                        check_out=check_out,
                        is_live=True,
                        created_at=created_at,
                    )
                    db.add(booking)
                    inserted_bookings += 1

                    dcur = check_in
                    while dcur < check_out:
                        sid = _slot_id(room.id, dcur)
                        slot = slot_map.get(sid)
                        if slot is None:
                            slot = Slot(
                                id=sid,
                                room_id=room.id,
                                date=dcur,
                                block_type=BlockType.EMPTY,
                                booking_id=None,
                                current_rate=float(room.base_rate),
                                floor_rate=0.0,
                                channel=Channel.OTA,
                                min_stay_active=False,
                                min_stay_nights=1,
                            )
                            db.add(slot)
                            slot_map[sid] = slot
                            inserted_slots += 1

                        if slot.block_type == BlockType.EMPTY and slot.booking_id is None:
                            slot.block_type = BlockType.SOFT
                            slot.booking_id = booking.id
                            slot.channel = Channel.OTA
                            slot.current_rate = float(room.base_rate)
                            updated_slots += 1

                        dcur += timedelta(days=1)

                    # Advance cursor to end of booking (prevents overlapping bookings in same room).
                    gap_days = room_rng.choices([0, 1, 2, 3], weights=[35, 35, 20, 10], k=1)[0]
                    cur = check_out + timedelta(days=gap_days)

    await db.commit()

    return {
        "inserted_bookings": inserted_bookings,
        "inserted_slots": inserted_slots,
        "updated_slots": updated_slots,
    }

