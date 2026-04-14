"""Analytics controller — occupancy forecasting and pace metrics.

These endpoints are additive and used by the Bird's Eye Dashboard only.
They do not mutate DB state.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from statistics import mean, pstdev
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models import Room, Slot, Booking, BlockType, RoomCategory
from core.schemas.analytics import (
    OccupancyForecastResponse,
    OccupancySeries,
    OccupancyPoint,
    PaceResponse,
    PaceSeries,
    PacePoint,
    EventInsightsResponse,
    LosBucket,
)
from services.analytics.forecasting import build_expected_occupancy


def _as_of_dt(as_of: date) -> datetime:
    # Treat `as_of` as end-of-day UTC for pickup cutoffs.
    return datetime.combine(as_of, time.max)


def _date_range(start: date, end: date) -> list[date]:
    days = (end - start).days
    return [start + timedelta(days=i) for i in range(max(0, days))]


@dataclass(frozen=True)
class _RoomTotals:
    total_by_category: dict[RoomCategory, int]
    total_all: int


async def _get_room_totals(db: AsyncSession) -> _RoomTotals:
    rows = (await db.execute(
        select(Room.category, func.count(Room.id))
        .where(Room.is_active == True)
        .group_by(Room.category)
    )).all()
    total_by_category = {cat: int(cnt) for (cat, cnt) in rows}
    total_all = int(sum(total_by_category.values()))
    return _RoomTotals(total_by_category=total_by_category, total_all=total_all)


async def _get_actual_occupied_counts(
    db: AsyncSession,
    start: date,
    end: date,
) -> dict[tuple[date, RoomCategory], int]:
    rows = (await db.execute(
        select(Slot.date, Room.category, func.count(Slot.id))
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= start,
            Slot.date < end,
            Slot.block_type != BlockType.EMPTY,
        )
        .group_by(Slot.date, Room.category)
    )).all()
    return {(d, cat): int(cnt) for (d, cat, cnt) in rows}


async def _get_on_books_occupied_counts(
    db: AsyncSession,
    start: date,
    end: date,
    as_of: date,
) -> dict[tuple[date, RoomCategory], int]:
    cutoff = _as_of_dt(as_of)
    bookings = (await db.execute(
        select(Booking)
        .where(
            Booking.is_live == True,
            Booking.created_at <= cutoff,
            Booking.check_out > start,
            Booking.check_in < end,
        )
    )).scalars().all()

    counts: dict[tuple[date, RoomCategory], int] = defaultdict(int)
    for b in bookings:
        seg_start = max(start, b.check_in)
        seg_end = min(end, b.check_out)
        for d in _date_range(seg_start, seg_end):
            counts[(d, b.room_category)] += 1
    return dict(counts)


def _rollup_counts(
    counts: dict[tuple[date, RoomCategory], int],
) -> dict[date, int]:
    rolled: dict[date, int] = defaultdict(int)
    for (d, _cat), cnt in counts.items():
        rolled[d] += cnt
    return dict(rolled)


async def get_occupancy_forecast(
    db: AsyncSession,
    start: date,
    end: date,
    as_of: date,
) -> OccupancyForecastResponse:
    totals = await _get_room_totals(db)
    days = _date_range(start, end)

    actual_counts = await _get_actual_occupied_counts(db, start=min(start, as_of - timedelta(days=365)), end=min(end, as_of + timedelta(days=1)))
    on_books_counts = await _get_on_books_occupied_counts(db, start=start, end=end, as_of=as_of)

    expected_by_date_cat = await build_expected_occupancy(
        db=db,
        start=start,
        end=end,
        as_of=as_of,
        totals_by_category=totals.total_by_category,
        total_all=totals.total_all,
    )

    series: list[OccupancySeries] = []

    for cat, total_rooms in totals.total_by_category.items():
        points: list[OccupancyPoint] = []
        for d in days:
            expected = expected_by_date_cat.get((d, cat))
            if not expected:
                expected = {"mean": 0.0, "low": 0.0, "high": 0.0}
            points.append(OccupancyPoint(
                date=d,
                total_rooms=total_rooms,
                occupied_rooms_actual=actual_counts.get((d, cat)),
                occupied_rooms_on_books=on_books_counts.get((d, cat)),
                expected_occ_pct=expected["mean"],
                expected_occ_low_pct=expected["low"],
                expected_occ_high_pct=expected["high"],
            ))
        series.append(OccupancySeries(category=cat, points=points))

    # Rollup
    roll_actual = _rollup_counts({k: v for k, v in actual_counts.items() if k[0] in set(days)})
    roll_on_books = _rollup_counts(on_books_counts)
    roll_points: list[OccupancyPoint] = []
    for d in days:
        expected = expected_by_date_cat.get((d, None)) or {"mean": 0.0, "low": 0.0, "high": 0.0}
        roll_points.append(OccupancyPoint(
            date=d,
            total_rooms=totals.total_all,
            occupied_rooms_actual=roll_actual.get(d),
            occupied_rooms_on_books=roll_on_books.get(d),
            expected_occ_pct=expected["mean"],
            expected_occ_low_pct=expected["low"],
            expected_occ_high_pct=expected["high"],
        ))
    series.append(OccupancySeries(category=None, points=roll_points))

    return OccupancyForecastResponse(start=start, end=end, as_of=as_of, series=series)


async def get_pace(
    db: AsyncSession,
    start: date,
    end: date,
    as_of: date,
    max_lead_days: int,
) -> PaceResponse:
    totals = await _get_room_totals(db)

    # Compute pace as average occupied rooms per night across the stay window.
    stay_dates = _date_range(start, end)
    nights = max(1, len(stay_dates))

    async def compute_avg_rooms_at_cutoff(cutoff_dt: datetime) -> tuple[dict[RoomCategory, float], float]:
        bookings = (await db.execute(
            select(Booking)
            .where(
                Booking.is_live == True,
                Booking.created_at <= cutoff_dt,
                Booking.check_out > start,
                Booking.check_in < end,
            )
        )).scalars().all()

        room_nights_cat: dict[RoomCategory, int] = defaultdict(int)
        room_nights_all = 0
        for b in bookings:
            seg_start = max(start, b.check_in)
            seg_end = min(end, b.check_out)
            rn = max(0, (seg_end - seg_start).days)
            room_nights_cat[b.room_category] += rn
            room_nights_all += rn

        avg_by_cat = {cat: (room_nights_cat.get(cat, 0) / nights) for cat in totals.total_by_category.keys()}
        avg_all = room_nights_all / nights
        return avg_by_cat, avg_all

    # Baseline windows: same window one year ago and two years ago if data exists.
    baseline_windows: list[tuple[date, date]] = [
        (start - timedelta(days=364), end - timedelta(days=364)),
        (start - timedelta(days=728), end - timedelta(days=728)),
    ]

    series: list[PaceSeries] = []
    for cat, total_rooms in totals.total_by_category.items():
        points: list[PacePoint] = []
        for lead in range(0, max_lead_days + 1):
            cutoff = _as_of_dt(as_of) - timedelta(days=lead)
            avg_by_cat, _avg_all = await compute_avg_rooms_at_cutoff(cutoff)
            current_avg_rooms = float(avg_by_cat.get(cat, 0.0))
            current_occ_pct = (current_avg_rooms / max(1, total_rooms)) * 100.0

            baseline_samples: list[float] = []
            for (bstart, bend) in baseline_windows:
                bcutoff = datetime.combine(bstart, time.max) - timedelta(days=lead)
                # Reuse the same computation logic, but with shifted window by temporarily calling a local query.
                bookings = (await db.execute(
                    select(Booking)
                    .where(
                        Booking.is_live == True,
                        Booking.created_at <= bcutoff,
                        Booking.check_out > bstart,
                        Booking.check_in < bend,
                        Booking.room_category == cat,
                    )
                )).scalars().all()
                room_nights = 0
                bnights = max(1, (bend - bstart).days)
                for bk in bookings:
                    seg_start = max(bstart, bk.check_in)
                    seg_end = min(bend, bk.check_out)
                    room_nights += max(0, (seg_end - seg_start).days)
                baseline_samples.append(room_nights / bnights)

            expected_avg_rooms = float(mean(baseline_samples)) if baseline_samples else 0.0
            expected_occ_pct = (expected_avg_rooms / max(1, total_rooms)) * 100.0

            points.append(PacePoint(
                lead_days=lead,
                on_books_rooms=int(round(current_avg_rooms)),
                on_books_occ_pct=current_occ_pct,
                expected_on_books_rooms=expected_avg_rooms,
                expected_on_books_occ_pct=expected_occ_pct,
            ))

        series.append(PaceSeries(category=cat, stay_start=start, stay_end=end, points=points))

    # Rollup series
    roll_points: list[PacePoint] = []
    for lead in range(0, max_lead_days + 1):
        cutoff = _as_of_dt(as_of) - timedelta(days=lead)
        _avg_by_cat, avg_all = await compute_avg_rooms_at_cutoff(cutoff)
        current_occ_pct = (avg_all / max(1, totals.total_all)) * 100.0

        baseline_samples: list[float] = []
        for (bstart, bend) in baseline_windows:
            bcutoff = datetime.combine(bstart, time.max) - timedelta(days=lead)
            bookings = (await db.execute(
                select(Booking)
                .where(
                    Booking.is_live == True,
                    Booking.created_at <= bcutoff,
                    Booking.check_out > bstart,
                    Booking.check_in < bend,
                )
            )).scalars().all()
            room_nights = 0
            bnights = max(1, (bend - bstart).days)
            for bk in bookings:
                seg_start = max(bstart, bk.check_in)
                seg_end = min(bend, bk.check_out)
                room_nights += max(0, (seg_end - seg_start).days)
            baseline_samples.append(room_nights / bnights)

        expected_avg_rooms = float(mean(baseline_samples)) if baseline_samples else 0.0
        expected_occ_pct = (expected_avg_rooms / max(1, totals.total_all)) * 100.0

        roll_points.append(PacePoint(
            lead_days=lead,
            on_books_rooms=int(round(avg_all)),
            on_books_occ_pct=current_occ_pct,
            expected_on_books_rooms=expected_avg_rooms,
            expected_on_books_occ_pct=expected_occ_pct,
        ))

    series.append(PaceSeries(category=None, stay_start=start, stay_end=end, points=roll_points))
    return PaceResponse(as_of=as_of, series=series)


async def get_event_insights(
    db: AsyncSession,
    start: date,
    end: date,
    as_of: date,
    category: Optional[str],
) -> EventInsightsResponse:
    cutoff = _as_of_dt(as_of)
    cat_enum: Optional[RoomCategory] = None
    if category:
        try:
            cat_enum = RoomCategory(category)
        except Exception:
            cat_enum = None

    q = select(Booking).where(
        Booking.is_live == True,
        Booking.created_at <= cutoff,
        Booking.check_out > start,
        Booking.check_in < end,
    )
    if cat_enum is not None:
        q = q.where(Booking.room_category == cat_enum)

    bookings = (await db.execute(q)).scalars().all()

    los_counts: dict[int, int] = defaultdict(int)
    arrival_hist = [0] * 7
    for b in bookings:
        nights = max(0, (b.check_out - b.check_in).days)
        if nights <= 0:
            continue
        los_counts[nights] += 1
        arrival_hist[b.check_in.weekday()] += 1

    los_histogram = [LosBucket(nights=n, count=c) for (n, c) in sorted(los_counts.items())]
    most_common_los = max(los_counts.items(), key=lambda kv: kv[1])[0] if los_counts else None
    most_common_arrival = int(max(range(7), key=lambda i: arrival_hist[i])) if sum(arrival_hist) > 0 else None

    return EventInsightsResponse(
        start=start,
        end=end,
        as_of=as_of,
        category=cat_enum,
        most_common_los_nights=most_common_los,
        los_histogram=los_histogram,
        most_common_arrival_weekday=most_common_arrival,
        arrival_weekday_histogram=arrival_hist,
    )

