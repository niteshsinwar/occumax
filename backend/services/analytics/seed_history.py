"""Seed demo historical data for analytics (pace + final-occupancy prediction).

This is used by:
- Admin endpoint `POST /admin/seed-analytics-history` (UI button)

Safety:
- Inserts demo rows for historical windows (~1y and ~2y back).
- Only updates slots when they are currently EMPTY with no booking_id.
- Demo bookings are tagged by guest_name prefix: "DEMO_ANALYTICS".

Realism model (v2):
- Weekends (Fri/Sat) target 78–88% occupancy, weekdays 38–52%
- Seasonal multipliers: summer peak (Jul–Aug 1.25×), Christmas (Dec 1.15×),
  shoulder (Apr–Jun, Sep–Oct 1.05×), low (Jan–Mar, Nov 0.85×)
- LOS mix: 1n 10%, 2n 28%, 3n 30%, 4n 18%, 5–7n 14%
- Channel mix: OTA 60%, DIRECT 25%, GDS 10%, WALKIN 5%
- Lead time: short stays (1–2n) booked 2–12 days out; long stays 14–60 days
"""

from __future__ import annotations

import random
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.models import Room, Slot, Booking, BlockType, Channel, RoomCategory
from core.channel_config import OTA_PARTNER_NAMES_LIST, GDS_PARTNER_NAMES_LIST


DEMO_PREFIX = "DEMO_ANALYTICS"

# Weekday base fill rates: Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
_DOW_RATE = {0: 0.42, 1: 0.40, 2: 0.43, 3: 0.48, 4: 0.78, 5: 0.85, 6: 0.62}

# Monthly seasonal multiplier (1-indexed)
_MONTH_MUL = {
    1: 0.82, 2: 0.84, 3: 0.88,  # Jan–Mar: low season
    4: 1.05, 5: 1.08, 6: 1.10,  # Apr–Jun: shoulder/spring
    7: 1.25, 8: 1.22,            # Jul–Aug: summer peak
    9: 1.08, 10: 1.05,           # Sep–Oct: autumn shoulder
    11: 0.86, 12: 1.15,          # Nov low, Dec Christmas peak
}

# LOS distribution: (nights, weight)
_LOS_CHOICES  = [1, 2, 3, 4, 5, 6, 7]
_LOS_WEIGHTS  = [10, 28, 30, 18, 7, 4, 3]

# Channel distribution
_CHANNELS     = [Channel.OTA, Channel.DIRECT, Channel.GDS, Channel.WALKIN]
_CHAN_WEIGHTS  = [60, 25, 10, 5]

# Named partners per channel — imported from single source of truth
_OTA_PARTNERS   = OTA_PARTNER_NAMES_LIST   # ["MakeMyTrip", "Goibibo", "Agoda", "Booking.com", "Expedia"]
_OTA_P_WEIGHTS  = [35, 25, 20, 15, 5]
_GDS_PARTNERS   = GDS_PARTNER_NAMES_LIST   # ["Amadeus", "Sabre", "Travelport"]
_GDS_P_WEIGHTS  = [55, 30, 15]


def _target_fill(d: date) -> float:
    """Per-day target occupancy fraction, driven by DoW and season."""
    base = _DOW_RATE[d.weekday()]
    mul  = _MONTH_MUL[d.month]
    return min(0.97, base * mul)


def _slot_id(room_id: str, d: date) -> str:
    return f"{room_id}_{d}"


def _as_utc_dt(d: date, hour: int) -> datetime:
    return datetime.combine(d, time(hour=hour))


def _hash_seed(seed: int, s: str) -> int:
    acc = seed
    for ch in s:
        acc = (acc * 131 + ord(ch)) % 2_147_483_647
    return acc


def _rand_created_at(check_in: date, los: int, room_rng: random.Random) -> datetime:
    # Short stays booked last-minute; long stays booked further out
    if los <= 2:
        lead = room_rng.randint(1, 12)
    elif los <= 4:
        lead = room_rng.randint(5, 30)
    else:
        lead = room_rng.randint(14, 60)
    lead = min(lead, (check_in - date(check_in.year - 1, 1, 1)).days)
    hour = room_rng.randint(7, 22)
    return _as_utc_dt(check_in - timedelta(days=lead), hour=hour)


def _iter_days(start: date, end: date):
    cur = start
    while cur < end:
        yield cur
        cur += timedelta(days=1)


async def seed_analytics_history(
    db: AsyncSession,
    window_days: int = 21,
    target_start: date | None = None,
    target_end: date | None = None,
    seed: int = 42,
    fill_pct: int = 35,  # scales the realistic model: 35 = default, 60 = busier hotel
) -> dict[str, int]:
    as_of = date.today()
    future_start = target_start or as_of
    future_end   = target_end or (future_start + timedelta(days=window_days))
    if future_end <= future_start:
        raise RuntimeError("end date must be after start date")

    run_tag = f"{future_start.isoformat()}..{future_end.isoformat()}"

    hist_offsets = [364, 728]  # ~1y and ~2y back
    hist_windows = [
        (future_start - timedelta(days=o), future_end - timedelta(days=o))
        for o in hist_offsets
    ]

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

    # Clear any previous demo data in this historical window (regardless of run_tag).
    # This ensures the selected date range is always fully regenerated.
    existing_booking_ids = (await db.execute(
        select(Booking.id).where(
            Booking.guest_name.like(f"{DEMO_PREFIX}%"),
            Booking.check_out > hist_min,
            Booking.check_in  < hist_max,
        )
    )).scalars().all()

    deleted_bookings = 0
    cleared_slots    = 0
    if existing_booking_ids:
        clear_res = await db.execute(
            update(Slot)
            .where(Slot.booking_id.in_(existing_booking_ids))
            .values(
                block_type=BlockType.EMPTY,
                booking_id=None,
                channel=Channel.DIRECT,
                channel_partner=None,
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
    # fill_pct 35 = neutral baseline; higher = busier hotel, lower = quieter
    fill_scale = fill_pct / 35.0

    inserted_bookings = 0
    inserted_slots    = 0
    updated_slots     = 0

    existing_slots = (await db.execute(
        select(Slot).where(Slot.date >= hist_min, Slot.date < hist_max)
    )).scalars().all()
    slot_map: dict[str, Slot] = {s.id: s for s in existing_slots}

    for (hstart, hend) in hist_windows:
        if (hend - hstart).days <= 0:
            continue

        # Build per-room, per-day occupancy decisions using realistic fill targets
        # For each day, decide which rooms are occupied based on target fill rate
        chosen_by_room: dict[str, list[date]] = defaultdict(list)
        room_meta: dict[str, tuple[RoomCategory, float]] = {}

        all_days = list(_iter_days(hstart, hend))

        for d in all_days:
            target = _target_fill(d)
            # Add hotel-level noise per day (±6%)
            noise = rng.uniform(-0.06, 0.06)
            effective = min(0.97, max(0.05, target * fill_scale + noise))

            # Decide per-room based on roll
            for room in rooms:
                # Per-room bias: some rooms consistently book slightly better
                room_bias = (_hash_seed(seed, room.id) % 13 - 6) / 100.0
                if rng.random() < (effective + room_bias):
                    chosen_by_room[room.id].append(d)
                    room_meta[room.id] = (room.category, float(room.base_rate))

        # Convert chosen days into contiguous bookings
        for room_id, days_list in chosen_by_room.items():
            cat, base_rate = room_meta[room_id]
            room_rng = random.Random(_hash_seed(seed, f"{room_id}:{hstart.isoformat()}"))

            days_sorted = sorted(days_list)
            i = 0
            while i < len(days_sorted):
                seg_start = days_sorted[i]
                seg_end   = seg_start + timedelta(days=1)
                i += 1
                while i < len(days_sorted) and days_sorted[i] == seg_end:
                    seg_end += timedelta(days=1)
                    i += 1

                # Split contiguous run into realistic LOS bookings
                cur = seg_start
                while cur < seg_end:
                    remaining = (seg_end - cur).days
                    los = min(remaining, room_rng.choices(_LOS_CHOICES, weights=_LOS_WEIGHTS, k=1)[0])
                    check_in  = cur
                    check_out = cur + timedelta(days=los)
                    channel   = room_rng.choices(_CHANNELS, weights=_CHAN_WEIGHTS, k=1)[0]
                    if channel == Channel.OTA:
                        partner = room_rng.choices(_OTA_PARTNERS, weights=_OTA_P_WEIGHTS, k=1)[0]
                    elif channel == Channel.GDS:
                        partner = room_rng.choices(_GDS_PARTNERS, weights=_GDS_P_WEIGHTS, k=1)[0]
                    else:
                        partner = None

                    # Rate variation: OTA/GDS gets slight discount, DIRECT/WALKIN can go higher
                    rate_mul = {
                        Channel.OTA:    room_rng.uniform(0.92, 1.00),
                        Channel.DIRECT: room_rng.uniform(0.97, 1.08),
                        Channel.GDS:    room_rng.uniform(0.88, 0.96),
                        Channel.WALKIN: room_rng.uniform(1.00, 1.12),
                    }.get(channel, 1.0)
                    effective_rate = round(base_rate * rate_mul, -1)  # round to nearest 10

                    booking = Booking(
                        id=str(uuid.uuid4())[:8].upper(),
                        guest_name=(
                            f"{DEMO_PREFIX}[{run_tag}] {cat} {room_id} "
                            f"{channel.value if hasattr(channel, 'value') else channel}"
                        ),
                        room_category=cat,
                        assigned_room_id=room_id,
                        check_in=check_in,
                        check_out=check_out,
                        is_live=True,
                        created_at=_rand_created_at(check_in, los, room_rng),
                    )
                    db.add(booking)
                    inserted_bookings += 1

                    dcur = check_in
                    while dcur < check_out:
                        sid  = _slot_id(room_id, dcur)
                        slot = slot_map.get(sid)
                        if slot is None:
                            slot = Slot(
                                id=sid,
                                room_id=room_id,
                                date=dcur,
                                block_type=BlockType.EMPTY,
                                booking_id=None,
                                current_rate=effective_rate,
                                floor_rate=0.0,
                                channel=channel,
                                channel_partner=partner,
                                min_stay_active=False,
                                min_stay_nights=1,
                            )
                            db.add(slot)
                            slot_map[sid] = slot
                            inserted_slots += 1

                        if slot.block_type == BlockType.EMPTY and slot.booking_id is None:
                            slot.block_type      = BlockType.SOFT
                            slot.booking_id      = booking.id
                            slot.channel         = channel
                            slot.channel_partner = partner
                            slot.current_rate    = effective_rate
                            updated_slots    += 1

                        dcur += timedelta(days=1)

                    cur = check_out

    await db.commit()

    return {
        "deleted_bookings": deleted_bookings,
        "cleared_slots":    cleared_slots,
        "inserted_bookings": inserted_bookings,
        "inserted_slots":    inserted_slots,
        "updated_slots":     updated_slots,
    }
