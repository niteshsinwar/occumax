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

from sqlalchemy import delete, select, update
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
    fill_pct: int = 35,
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

    hist_min = min(w[0] for w in hist_windows)
    hist_max = max(w[1] for w in hist_windows)

    # If demo data already exists for this requested run_tag, delete it and reseed.
    # This keeps the admin tool idempotent for a given chosen range.
    existing_booking_ids = (await db.execute(
        select(Booking.id).where(
            Booking.guest_name.like(f"{DEMO_PREFIX}[{run_tag}]%"),
            Booking.check_out > hist_min,
            Booking.check_in < hist_max,
        )
    )).scalars().all()

    deleted_bookings = 0
    cleared_slots = 0
    if existing_booking_ids:
        clear_res = await db.execute(
            update(Slot)
            .where(Slot.booking_id.in_(existing_booking_ids))
            .values(
                block_type=BlockType.EMPTY,
                booking_id=None,
                channel=Channel.OTA,
            )
            .execution_options(synchronize_session=False)
        )
        cleared_slots = int(clear_res.rowcount or 0)

        del_res = await db.execute(
            delete(Booking)
            .where(Booking.id.in_(existing_booking_ids))
            .execution_options(synchronize_session=False)
        )
        deleted_bookings = int(del_res.rowcount or 0)

        await db.commit()

    rng = random.Random(seed)

    inserted_bookings = 0
    inserted_slots = 0
    updated_slots = 0

    existing_slots = (await db.execute(
        select(Slot).where(Slot.date >= hist_min, Slot.date < hist_max)
    )).scalars().all()
    slot_map: dict[str, Slot] = {s.id: s for s in existing_slots}

    def _iter_days(start: date, end: date):
        cur = start
        while cur < end:
            yield cur
            cur += timedelta(days=1)

    def _rand_created_at(check_in: date, room_rng: random.Random) -> datetime:
        lead = room_rng.randint(3, 35)
        return _as_utc_dt(check_in - timedelta(days=lead), hour=room_rng.randint(8, 18))

    fill_pct = max(0, min(100, int(fill_pct)))

    for (hstart, hend) in hist_windows:
        window_days_count = (hend - hstart).days
        if window_days_count <= 0:
            continue

        # Target occupancy is expressed as % of room-nights in this window.
        target_room_nights = int(round(len(rooms) * window_days_count * (fill_pct / 100.0)))
        if target_room_nights <= 0:
            continue

        # Randomly pick the specific room-nights to fill, then group them into bookings.
        candidates: list[tuple[str, RoomCategory, float, date]] = []
        for room in rooms:
            for d in _iter_days(hstart, hend):
                candidates.append((room.id, room.category, float(room.base_rate), d))

        rng.shuffle(candidates)
        chosen = candidates[:target_room_nights]

        # Index chosen days per room, then create bookings over contiguous runs.
        chosen_by_room: dict[str, set[date]] = defaultdict(set)
        room_meta: dict[str, tuple[RoomCategory, float]] = {}
        for (room_id, cat, base_rate, d) in chosen:
            chosen_by_room[room_id].add(d)
            room_meta[room_id] = (cat, base_rate)

        for room_id, days_set in chosen_by_room.items():
            cat, base_rate = room_meta[room_id]
            room_rng = random.Random(_hash_seed(seed, f"{room_id}:{hstart.isoformat()}:{fill_pct}"))

            days_sorted = sorted(days_set)
            i = 0
            while i < len(days_sorted):
                start = days_sorted[i]
                end = start + timedelta(days=1)
                i += 1
                while i < len(days_sorted) and days_sorted[i] == end:
                    end += timedelta(days=1)
                    i += 1

                # Split long contiguous runs into 1–4 night bookings.
                cur = start
                while cur < end:
                    remaining = (end - cur).days
                    los = min(remaining, room_rng.choices([1, 2, 3, 4], weights=[12, 36, 34, 18], k=1)[0])
                    check_in = cur
                    check_out = cur + timedelta(days=los)

                    booking = Booking(
                        id=str(uuid.uuid4())[:8].upper(),
                        guest_name=f"{DEMO_PREFIX}[{run_tag}] {fill_pct}% {cat} {room_id}",
                        room_category=cat,
                        assigned_room_id=room_id,
                        check_in=check_in,
                        check_out=check_out,
                        is_live=True,
                        created_at=_rand_created_at(check_in, room_rng),
                    )
                    db.add(booking)
                    inserted_bookings += 1

                    dcur = check_in
                    while dcur < check_out:
                        sid = _slot_id(room_id, dcur)
                        slot = slot_map.get(sid)
                        if slot is None:
                            slot = Slot(
                                id=sid,
                                room_id=room_id,
                                date=dcur,
                                block_type=BlockType.EMPTY,
                                booking_id=None,
                                current_rate=float(base_rate),
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
                            slot.current_rate = float(base_rate)
                            updated_slots += 1

                        dcur += timedelta(days=1)

                    cur = check_out

    await db.commit()

    return {
        "deleted_bookings": deleted_bookings,
        "cleared_slots": cleared_slots,
        "inserted_bookings": inserted_bookings,
        "inserted_slots": inserted_slots,
        "updated_slots": updated_slots,
    }

