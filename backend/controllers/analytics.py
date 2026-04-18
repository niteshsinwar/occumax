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
    RevenueSummaryResponse,
    EventInsightsResponse,
    LosBucket,
    ChannelStat,
    PartnerStat,
    ChannelPerformanceResponse,
    ChannelRecommendation,
    ChannelRecommendResponse,
)
from services.analytics.forecasting import build_expected_occupancy


def _as_of_dt(as_of: date) -> datetime:
    # Treat `as_of` as end-of-day UTC for pickup cutoffs.
    return datetime.combine(as_of, time.max)


def _cutoff_dt_for_hist_lead(target_date: date, lead_days: int) -> datetime:
    """
    Historical pickup cutoff for a historical stay date, matching the current lead time.
    Example: if today is 10 days before target_date, then for hist_date we use (hist_date - 10 days).
    """
    return datetime.combine(target_date - timedelta(days=lead_days), time.max)


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


async def _get_actual_occupied_counts_rollup(
    db: AsyncSession,
    dates: set[date],
) -> dict[date, int]:
    if not dates:
        return {}
    dmin, dmax = min(dates), max(dates) + timedelta(days=1)
    rows = (await db.execute(
        select(Slot.date, func.count(Slot.id))
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= dmin,
            Slot.date < dmax,
            Slot.block_type != BlockType.EMPTY,
            Slot.date.in_(dates),
        )
        .group_by(Slot.date)
    )).all()
    return {d: int(cnt) for (d, cnt) in rows}


async def _get_on_books_counts_for_specific_dates(
    db: AsyncSession,
    dates: set[date],
    cutoff_dt: datetime,
    category: Optional[RoomCategory] = None,
) -> dict[date, int]:
    """
    Per-night counts of non-EMPTY slots (SOFT + HARD) on the given calendar dates.
    Aligns with the heatmap and ``_get_actual_occupied_counts``; ``cutoff_dt`` is kept for
    call-site compatibility but not applied (slots do not store historical snapshots).
    """
    _ = cutoff_dt
    if not dates:
        return {}
    dmin, dmax = min(dates), max(dates) + timedelta(days=1)
    q = (
        select(Slot.date, func.count(Slot.id))
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= dmin,
            Slot.date < dmax,
            Slot.date.in_(dates),
            Slot.block_type != BlockType.EMPTY,
        )
    )
    if category is not None:
        q = q.where(Room.category == category)
    q = q.group_by(Slot.date)
    rows = (await db.execute(q)).all()
    return {d: int(cnt) for (d, cnt) in rows}


async def _get_on_books_booking_count_for_date(
    db: AsyncSession,
    stay_date: date,
    cutoff_dt: datetime,
    category: Optional[RoomCategory],
) -> int:
    """
    Count rooms on the books for a specific stay date using Booking.created_at as the pickup cutoff.

    This is what we need for historical "on-books at same lead time" calculations. Slot records
    represent the current calendar state and do not preserve past snapshots.
    """
    q = select(func.count(Booking.id)).where(
        Booking.is_live == True,
        Booking.created_at <= cutoff_dt,
        Booking.check_in <= stay_date,
        Booking.check_out > stay_date,
    )
    if category is not None:
        q = q.where(Booking.room_category == category)
    val = (await db.execute(q)).scalar_one()
    return int(val or 0)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _clamp_pct(x: float) -> float:
    return max(0.0, min(100.0, float(x)))


async def _predict_final_occ_pct_for_date(
    db: AsyncSession,
    target_date: date,
    as_of: date,
    total_rooms: int,
    on_books_rooms_now: int,
    category: Optional[RoomCategory],
) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """
    Predict FINAL occupancy for target_date using historical pickup ratio at the same lead time.

    - Final realized occupancy for historical dates comes from slots (SOFT + HARD, i.e. not EMPTY).
    - Historical on-the-books at the same lead time is computed from Booking.created_at cutoffs.

    Using slots for historical on-books would always approximate 100% for past dates because slots
    do not store historical snapshots; that collapses the pickup ratio and makes pred final hug
    current on-books.
    """
    lead_days = max(0, (target_date - as_of).days)
    if total_rooms <= 0:
        return None, None, None, None

    # Historical same-calendar dates (approx) 1y and 2y back.
    hist_dates = [target_date - timedelta(days=364), target_date - timedelta(days=728)]
    hist_set = set(hist_dates)

    # Final realized occupancy (rooms) for historical dates from slots.
    if category is None:
        final_hist = await _get_actual_occupied_counts_rollup(db, hist_set)
        final_hist_cat: dict[date, int] = final_hist
    else:
        final_hist_cat = await _get_actual_occupied_counts(db, start=min(hist_set), end=max(hist_set) + timedelta(days=1))
        final_hist_cat = {d: final_hist_cat.get((d, category), 0) for d in hist_set}

    # On-the-books at same lead time for historical dates.
    pct_samples: list[float] = []
    for hd in hist_dates:
        final_rooms = int(final_hist_cat.get(hd, 0) or 0)
        if final_rooms <= 0:
            continue
        cutoff_dt = _cutoff_dt_for_hist_lead(hd, lead_days)
        on_books_hist = await _get_on_books_booking_count_for_date(
            db=db,
            stay_date=hd,
            cutoff_dt=cutoff_dt,
            category=category,
        )
        pct = on_books_hist / final_rooms
        # Clamp to avoid insane blowups (e.g. data glitches).
        pct_samples.append(_clamp01(pct))

    if not pct_samples:
        return None, None, None, None

    pct_mean = max(0.05, min(0.95, mean(pct_samples)))
    pct_low = max(0.05, min(0.95, min(pct_samples)))
    pct_high = max(0.05, min(0.95, max(pct_samples)))

    # If you're behind typical (smaller pct), final will project higher; so low/high invert.
    final_mean_rooms = on_books_rooms_now / pct_mean if pct_mean > 0 else on_books_rooms_now
    final_low_rooms = on_books_rooms_now / pct_high if pct_high > 0 else on_books_rooms_now
    final_high_rooms = on_books_rooms_now / pct_low if pct_low > 0 else on_books_rooms_now

    # Likelihood heuristic: higher when we have 2 samples and they agree.
    # (With only 1–2 historical samples, keep it simple and explainable.)
    if len(pct_samples) == 1:
        likelihood = 55.0
    else:
        spread = abs(pct_samples[0] - pct_samples[1])
        # If pickup ratios differ by <=5 pts → high confidence; <=12 pts → medium; else low.
        if spread <= 0.05:
            likelihood = 85.0
        elif spread <= 0.12:
            likelihood = 70.0
        else:
            likelihood = 55.0

    mean_pct = _clamp_pct((final_mean_rooms / total_rooms) * 100.0)
    raw_low = _clamp_pct((final_low_rooms / total_rooms) * 100.0)
    raw_high = _clamp_pct((final_high_rooms / total_rooms) * 100.0)
    # Pickup inversion can swap raw room bounds; API always exposes low ≤ high.
    band_lo, band_hi = min(raw_low, raw_high), max(raw_low, raw_high)
    return (mean_pct, band_lo, band_hi, likelihood)


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
    # Calendar occupancy (guest SOFT + blocks HARD); matches heatmap, not Booking.created_at.
    on_books_counts = await _get_actual_occupied_counts(db, start=start, end=end)

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
            on_books_now = int(on_books_counts.get((d, cat), 0) or 0)
            pred_mean, pred_low, pred_high, pred_like = await _predict_final_occ_pct_for_date(
                db=db,
                target_date=d,
                as_of=as_of,
                total_rooms=total_rooms,
                on_books_rooms_now=on_books_now,
                category=cat,
            )
            points.append(OccupancyPoint(
                date=d,
                total_rooms=total_rooms,
                occupied_rooms_actual=actual_counts.get((d, cat)),
                occupied_rooms_on_books=on_books_now,
                expected_occ_pct=expected["mean"],
                expected_occ_low_pct=expected["low"],
                expected_occ_high_pct=expected["high"],
                predicted_final_occ_pct=pred_mean,
                predicted_final_occ_low_pct=pred_low,
                predicted_final_occ_high_pct=pred_high,
                predicted_final_likelihood_pct=pred_like,
            ))
        series.append(OccupancySeries(category=cat, points=points))

    # Rollup
    roll_actual = _rollup_counts({k: v for k, v in actual_counts.items() if k[0] in set(days)})
    roll_on_books = _rollup_counts(on_books_counts)
    roll_points: list[OccupancyPoint] = []
    for d in days:
        expected = expected_by_date_cat.get((d, None)) or {"mean": 0.0, "low": 0.0, "high": 0.0}
        on_books_now = int(roll_on_books.get(d, 0) or 0)
        pred_mean, pred_low, pred_high, pred_like = await _predict_final_occ_pct_for_date(
            db=db,
            target_date=d,
            as_of=as_of,
            total_rooms=totals.total_all,
            on_books_rooms_now=on_books_now,
            category=None,
        )
        roll_points.append(OccupancyPoint(
            date=d,
            total_rooms=totals.total_all,
            occupied_rooms_actual=roll_actual.get(d),
            occupied_rooms_on_books=on_books_now,
            expected_occ_pct=expected["mean"],
            expected_occ_low_pct=expected["low"],
            expected_occ_high_pct=expected["high"],
            predicted_final_occ_pct=pred_mean,
            predicted_final_occ_low_pct=pred_low,
            predicted_final_occ_high_pct=pred_high,
            predicted_final_likelihood_pct=pred_like,
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


async def get_revenue_summary(
    db: AsyncSession,
    as_of: date,
) -> RevenueSummaryResponse:
    """
    Hotel-wide revenue snapshot computed entirely from existing slot + booking tables.
    No schema changes required.
    """
    week_end = as_of + timedelta(days=7)
    month_start = as_of.replace(day=1)

    # ── Total active rooms ────────────────────────────────────────────────────
    total_rooms_row = (await db.execute(
        select(func.count(Room.id)).where(Room.is_active == True)
    )).scalar_one()
    total_rooms = int(total_rooms_row or 0)

    if total_rooms == 0:
        return RevenueSummaryResponse(
            as_of=as_of,
            today_occupancy_pct=0, today_adr=0,
            today_rooms_occupied=0, today_total_rooms=0,
            week_occupancy_pct=0, week_revenue_on_books=0,
            week_rooms_booked=0, week_total_room_nights=total_rooms * 7,
            orphan_nights_at_risk=0, orphan_revenue_at_risk=0,
            mtd_revenue=0, mtd_days=(as_of - month_start).days + 1,
        )

    # ── Today: occupancy + ADR ────────────────────────────────────────────────
    today_slots = (await db.execute(
        select(Slot.current_rate, Slot.block_type)
        .join(Room, Room.id == Slot.room_id)
        .where(Room.is_active == True, Slot.date == as_of)
    )).all()

    today_occupied = [r for r in today_slots if r.block_type != BlockType.EMPTY]
    today_rooms_occupied = len(today_occupied)
    today_adr = float(mean([r.current_rate for r in today_occupied])) if today_occupied else 0.0
    today_occupancy_pct = (today_rooms_occupied / total_rooms) * 100.0

    # ── This week: revenue on-books + occupancy ───────────────────────────────
    week_slots = (await db.execute(
        select(Slot.current_rate, Slot.block_type, Slot.date)
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= as_of,
            Slot.date < week_end,
        )
    )).all()

    week_booked = [r for r in week_slots if r.block_type != BlockType.EMPTY]
    week_rooms_booked = len(week_booked)
    week_revenue_on_books = float(sum(r.current_rate for r in week_booked))
    week_total_room_nights = total_rooms * 7
    week_occupancy_pct = (week_rooms_booked / max(1, week_total_room_nights)) * 100.0

    # ── MTD revenue (booked slots this calendar month up to today) ────────────
    mtd_slots = (await db.execute(
        select(func.sum(Slot.current_rate))
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= month_start,
            Slot.date <= as_of,
            Slot.block_type != BlockType.EMPTY,
        )
    )).scalar_one()
    mtd_revenue = float(mtd_slots or 0.0)
    mtd_days = (as_of - month_start).days + 1

    # ── Orphan nights at risk (next 20 days) ─────────────────────────────────
    # An orphan is an EMPTY slot bounded by non-EMPTY on both sides in the same room.
    scan_end = as_of + timedelta(days=20)
    scan_slots = (await db.execute(
        select(Slot.room_id, Slot.date, Slot.block_type, Slot.current_rate)
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= as_of,
            Slot.date < scan_end,
        )
        .order_by(Slot.room_id, Slot.date)
    )).all()

    # Group by room
    by_room: dict[str, list[tuple]] = defaultdict(list)
    for row in scan_slots:
        by_room[row.room_id].append(row)

    orphan_nights = 0
    orphan_rev = 0.0
    for room_id, rows in by_room.items():
        for i, row in enumerate(rows):
            if row.block_type != BlockType.EMPTY:
                continue
            before = rows[i - 1].block_type if i > 0 else None
            after = rows[i + 1].block_type if i < len(rows) - 1 else None
            if before not in (None, BlockType.EMPTY) and after not in (None, BlockType.EMPTY):
                orphan_nights += 1
                orphan_rev += float(row.current_rate)

    return RevenueSummaryResponse(
        as_of=as_of,
        today_occupancy_pct=round(today_occupancy_pct, 1),
        today_adr=round(today_adr, 0),
        today_rooms_occupied=today_rooms_occupied,
        today_total_rooms=total_rooms,
        week_occupancy_pct=round(week_occupancy_pct, 1),
        week_revenue_on_books=round(week_revenue_on_books, 0),
        week_rooms_booked=week_rooms_booked,
        week_total_room_nights=week_total_room_nights,
        orphan_nights_at_risk=orphan_nights,
        orphan_revenue_at_risk=round(orphan_rev, 0),
        mtd_revenue=round(mtd_revenue, 0),
        mtd_days=mtd_days,
    )


# OTA commission rates by channel (industry standard for India)
_COMMISSION: dict[str, float] = {
    "OTA":    0.18,  # MakeMyTrip/Goibibo avg 18%
    "GDS":    0.10,  # GDS global distribution avg 10%
    "DIRECT": 0.00,  # Direct booking — zero commission
    "WALKIN": 0.00,  # Walk-in — zero commission
    "CLOSED": 0.00,
}


async def get_channel_performance(
    db: AsyncSession,
    as_of: date,
    window_days: int = 30,
) -> ChannelPerformanceResponse:
    """
    Channel revenue breakdown for the past `window_days` days.
    Computes gross revenue, commission-adjusted net revenue, and ADR per channel.
    """
    window_start = as_of - timedelta(days=window_days)

    # Occupied slots with channel + partner info in the window
    rows = (await db.execute(
        select(Slot.channel, Slot.channel_partner, Slot.current_rate)
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.block_type != BlockType.EMPTY,
            Slot.date >= window_start,
            Slot.date <= as_of,
        )
    )).all()

    # Aggregate by (channel, partner)
    channel_nights: dict[str, int] = {}
    channel_gross: dict[str, float] = {}
    partner_nights: dict[str, dict[str, int]] = {}    # {channel: {partner: nights}}
    partner_gross: dict[str, dict[str, float]] = {}   # {channel: {partner: gross}}

    for row in rows:
        ch = row.channel.value if row.channel and hasattr(row.channel, "value") else "DIRECT"
        pt = row.channel_partner or ("Direct" if ch == "DIRECT" else ("Walk-in" if ch == "WALKIN" else ch))
        channel_nights[ch] = channel_nights.get(ch, 0) + 1
        channel_gross[ch] = channel_gross.get(ch, 0.0) + float(row.current_rate)
        _pn = partner_nights.setdefault(ch, {})
        _pn[pt] = _pn.get(pt, 0) + 1
        _pg = partner_gross.setdefault(ch, {})
        _pg[pt] = _pg.get(pt, 0.0) + float(row.current_rate)

    total_nights = sum(channel_nights.values())

    stats: list[ChannelStat] = []
    total_gross = 0.0
    total_net = 0.0

    for ch in sorted(channel_nights.keys()):
        nights = channel_nights[ch]
        gross = channel_gross[ch]
        comm_pct = _COMMISSION.get(ch, 0.0)
        net = gross * (1 - comm_pct)
        avg_rate = round(gross / nights, 0) if nights else 0.0
        share = round((nights / max(1, total_nights)) * 100, 1)

        # Build per-partner breakdown
        ch_partners: list[PartnerStat] = []
        for pt, pt_nights in sorted(partner_nights.get(ch, {}).items(), key=lambda x: -x[1]):
            pt_gross = partner_gross[ch].get(pt, 0.0)
            pt_net = pt_gross * (1 - comm_pct)
            ch_partners.append(PartnerStat(
                partner=pt,
                room_nights=pt_nights,
                gross_revenue=round(pt_gross, 0),
                net_revenue=round(pt_net, 0),
                avg_rate=round(pt_gross / pt_nights, 0) if pt_nights else 0.0,
                share_of_channel_pct=round((pt_nights / nights) * 100, 1),
            ))

        stats.append(ChannelStat(
            channel=ch,
            room_nights=nights,
            gross_revenue=round(gross, 0),
            commission_pct=round(comm_pct * 100, 0),
            net_revenue=round(net, 0),
            avg_rate=avg_rate,
            share_pct=share,
            partners=ch_partners,
        ))
        total_gross += gross
        total_net += net

    # Sort by room nights descending
    stats.sort(key=lambda s: s.room_nights, reverse=True)

    # Generate a recommendation
    ota_share = next((s.share_pct for s in stats if s.channel == "OTA"), 0.0)
    direct_share = next((s.share_pct for s in stats if s.channel == "DIRECT"), 0.0)
    ota_stat = next((s for s in stats if s.channel == "OTA"), None)
    commission_leak = round(total_gross - total_net, 0)

    if ota_share > 60:
        recommendation = (
            f"OTA dependency is high at {ota_share}% of bookings. "
            f"₹{int(commission_leak):,} lost to commissions this period. "
            "Offer a 5% direct booking discount to shift guests off OTA — net revenue improves immediately."
        )
    elif direct_share > 50:
        recommendation = (
            f"Strong direct booking mix at {direct_share}%. "
            f"Net revenue is ₹{int(total_net):,} vs gross ₹{int(total_gross):,} — minimal commission drain. "
            "Keep incentivising direct with loyalty perks or early-bird rates."
        )
    elif ota_stat and ota_stat.avg_rate < (total_gross / max(1, total_nights)) * 0.95:
        recommendation = (
            "OTA bookings are arriving at a lower ADR than other channels. "
            "Review rate parity — OTAs may be discounting without your approval. "
            "Check rate caps in your OTA extranet."
        )
    else:
        recommendation = (
            f"Channel mix is balanced. Commission cost is ₹{int(commission_leak):,} this period. "
            "Focus on pushing direct for high-value room categories (Deluxe/Suite) to maximise net yield."
        )

    return ChannelPerformanceResponse(
        as_of=as_of,
        window_start=window_start,
        window_end=as_of,
        channels=stats,
        total_gross_revenue=round(total_gross, 0),
        total_net_revenue=round(total_net, 0),
        total_room_nights=total_nights,
        recommendation=recommendation,
    )


# ── OTA partner ranked by historical volume (largest first) ──────────────────
_OTA_PARTNERS_RANKED = ["MakeMyTrip", "Goibibo", "Agoda", "Booking.com", "Expedia"]
_GDS_PARTNERS_RANKED = ["Amadeus", "Sabre", "Travelport"]

# Day-of-week labels for reasoning text (Mon=0)
_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


async def get_channel_recommendations(
    db: AsyncSession,
    as_of: date,
    look_ahead_days: int = 14,
    history_days: int = 60,
) -> ChannelRecommendResponse:
    """
    Analyse current occupancy gaps and historical channel mix to recommend
    which booking sources to allocate inventory to, for which dates/categories.

    Logic:
    1. Find EMPTY slots in the next `look_ahead_days` for each category.
    2. Group empty nights into contiguous gaps.
    3. Compute historical OTA/GDS share and average rate per category from
       the past `history_days` of channel-attributed slots.
    4. For each significant gap (≥2 nights), produce a recommendation
       targeting the historically best-performing channel partner for that
       category — with expected gross/net and DOW-aware reasoning.
    """
    look_end = as_of + timedelta(days=look_ahead_days)
    hist_start = as_of - timedelta(days=history_days)

    # ── 1. Empty slots per category in look-ahead window ─────────────────────
    empty_rows = (await db.execute(
        select(Room.category, Slot.date)
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= as_of,
            Slot.date < look_end,
            Slot.block_type == BlockType.EMPTY,
        )
        .order_by(Room.category, Slot.date)
    )).all()

    # Group into {category: sorted list of empty dates}
    cat_empty: dict[str, list[date]] = defaultdict(list)
    for cat, d in empty_rows:
        cat_key = cat.value if hasattr(cat, "value") else str(cat)
        cat_empty[cat_key].append(d)

    # ── 2. Historical channel distribution per category ───────────────────────
    hist_rows = (await db.execute(
        select(Room.category, Slot.channel, Slot.channel_partner, Slot.current_rate)
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= hist_start,
            Slot.date < as_of,
            Slot.block_type != BlockType.EMPTY,
            Slot.channel_partner != None,  # noqa: E711  only named partners
        )
    )).all()

    # {category: {partner: (nights, total_revenue)}}
    hist: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0, 0.0]))
    for cat, ch, partner, rate in hist_rows:
        cat_key = cat.value if hasattr(cat, "value") else str(cat)
        if partner:
            hist[cat_key][partner][0] += 1
            hist[cat_key][partner][1] += float(rate)

    # ── 3. Room base rates per category ──────────────────────────────────────
    rate_rows = (await db.execute(
        select(Room.category, func.avg(Room.base_rate))
        .where(Room.is_active == True)
        .group_by(Room.category)
    )).all()
    base_rates: dict[str, float] = {}
    for cat, avg_r in rate_rows:
        cat_key = cat.value if hasattr(cat, "value") else str(cat)
        base_rates[cat_key] = float(avg_r or 0)

    # ── 4. Build recommendations from contiguous gaps ─────────────────────────
    recommendations: list[ChannelRecommendation] = []

    for cat_key, empty_dates in sorted(cat_empty.items()):
        if not empty_dates:
            continue

        # Find contiguous runs ≥ 2 nights
        runs: list[tuple[date, date]] = []
        sorted_dates = sorted(set(empty_dates))
        seg_start = sorted_dates[0]
        seg_prev  = sorted_dates[0]
        for d in sorted_dates[1:]:
            if (d - seg_prev).days == 1:
                seg_prev = d
            else:
                if (seg_prev - seg_start).days >= 1:
                    runs.append((seg_start, seg_prev + timedelta(days=1)))
                seg_start = d
                seg_prev  = d
        if (seg_prev - seg_start).days >= 1:
            runs.append((seg_start, seg_prev + timedelta(days=1)))

        # Best historical partner for this category
        partners_for_cat = hist.get(cat_key, {})
        best_partner: str | None = None
        best_partner_nights = 0
        for p in _OTA_PARTNERS_RANKED + _GDS_PARTNERS_RANKED:
            n = int(partners_for_cat.get(p, [0, 0])[0])
            if n > best_partner_nights:
                best_partner_nights = n
                best_partner = p

        base_rate = base_rates.get(cat_key, 5000.0)

        for gap_start, gap_end in runs[:3]:  # cap at 3 gaps per category
            nights = (gap_end - gap_start).days
            dow_labels = [_DOW[( gap_start + timedelta(i) ).weekday()] for i in range(nights)]
            has_weekend = any(d in ("Fri", "Sat") for d in dow_labels)
            dow_str = "/".join(dow_labels[:4]) + ("…" if nights > 4 else "")

            # Decide source and confidence
            if best_partner and best_partner_nights >= 5:
                source    = best_partner
                ch_type   = "OTA" if best_partner in _OTA_PARTNERS_RANKED else "GDS"
                comm_rate = 0.18 if ch_type == "OTA" else 0.10
                confidence = "HIGH" if best_partner_nights >= 15 else "MEDIUM"
                reasoning = (
                    f"{cat_key} has {nights} empty nights ({gap_start.isoformat()} → {gap_end.isoformat()}, {dow_str}). "
                    f"{source} drove {best_partner_nights} room-nights historically in this category — "
                    f"{'weekend demand expected' if has_weekend else 'steady weekday fill likely'}. "
                    f"Allocating fills the gap at {comm_rate*100:.0f}% commission cost."
                )
            else:
                source    = "Direct"
                ch_type   = "DIRECT"
                comm_rate = 0.0
                confidence = "MEDIUM"
                reasoning = (
                    f"{cat_key} has {nights} empty nights ({gap_start.isoformat()} → {gap_end.isoformat()}, {dow_str}). "
                    f"No strong OTA history for this category — direct allocation retains full margin. "
                    f"{'Weekend dates are high-value; avoid OTA discounts.' if has_weekend else 'Push via hotel website or corporate rate.'}"
                )

            ota_rate = round(base_rate * 0.95, -1)  # slight OTA discount
            gross = round(ota_rate * nights, 0)
            comm  = round(gross * comm_rate, 0)
            net   = round(gross - comm, 0)

            recommendations.append(ChannelRecommendation(
                booking_source = source,
                channel_type   = ch_type,
                category       = cat_key,
                check_in       = gap_start.isoformat(),
                check_out      = gap_end.isoformat(),
                room_count     = 1,
                expected_gross = gross,
                commission_cost= comm,
                expected_net   = net,
                confidence     = confidence,
                reasoning      = reasoning,
            ))

    # Sort: HIGH confidence first, then largest net revenue
    recommendations.sort(key=lambda r: (0 if r.confidence == "HIGH" else 1 if r.confidence == "MEDIUM" else 2, -r.expected_net))

    total_net = sum(r.expected_net for r in recommendations)
    if not recommendations:
        summary = "No significant inventory gaps found in the next 14 days. Current allocation looks healthy."
    else:
        top = recommendations[0]
        summary = (
            f"{len(recommendations)} allocation opportunit{'y' if len(recommendations)==1 else 'ies'} found "
            f"across the next {look_ahead_days} days. Highest priority: {top.booking_source} for "
            f"{top.category} {top.check_in} → {top.check_out}. "
            f"Total potential net revenue if all committed: ₹{int(total_net):,}."
        )

    return ChannelRecommendResponse(
        as_of=as_of.isoformat(),
        analysis_window_days=look_ahead_days,
        recommendations=recommendations[:8],  # cap at 8 cards
        summary=summary,
    )
