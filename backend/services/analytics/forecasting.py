"""Phase 2 occupancy forecasting (lightweight, heuristic).

Approach:
- Compute a seasonal baseline from realized historical occupancy in `slots` for similar days.
- Apply a damped recent-trend adjustment.
- Emit a simple empirical confidence band from historical dispersion.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from statistics import mean, pstdev
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, BlockType, RoomCategory


def _clamp_pct(x: float) -> float:
    return max(0.0, min(100.0, float(x)))


def _date_range(start: date, end: date) -> list[date]:
    days = (end - start).days
    return [start + timedelta(days=i) for i in range(max(0, days))]


def _similarity_key(d: date) -> tuple[int, int]:
    # (weekday, week-of-year-ish bucket) for loose seasonality.
    return (d.weekday(), int(d.timetuple().tm_yday // 7))


async def _historical_realized_occ_pct(
    db: AsyncSession,
    hist_start: date,
    hist_end: date,
    totals_by_category: dict[RoomCategory, int],
    total_all: int,
) -> tuple[dict[tuple[date, RoomCategory], float], dict[date, float]]:
    rows = (await db.execute(
        select(Slot.date, Room.category, func.count(Slot.id))
        .join(Room, Room.id == Slot.room_id)
        .where(
            Room.is_active == True,
            Slot.date >= hist_start,
            Slot.date < hist_end,
            Slot.block_type != BlockType.EMPTY,
        )
        .group_by(Slot.date, Room.category)
    )).all()

    occ_pct_by_date_cat: dict[tuple[date, RoomCategory], float] = {}
    occ_rooms_by_date: dict[date, int] = defaultdict(int)

    for d, cat, cnt in rows:
        denom = max(1, int(totals_by_category.get(cat, 0)))
        occ_pct_by_date_cat[(d, cat)] = (int(cnt) / denom) * 100.0
        occ_rooms_by_date[d] += int(cnt)

    occ_pct_rollup: dict[date, float] = {}
    for d, occ_rooms in occ_rooms_by_date.items():
        occ_pct_rollup[d] = (occ_rooms / max(1, int(total_all))) * 100.0

    return occ_pct_by_date_cat, occ_pct_rollup


async def build_expected_occupancy(
    db: AsyncSession,
    start: date,
    end: date,
    as_of: date,
    totals_by_category: dict[RoomCategory, int],
    total_all: int,
) -> dict[tuple[date, Optional[RoomCategory]], dict[str, float]]:
    lookback_days = int(getattr(settings, "ANALYTICS_LOOKBACK_DAYS", 365))
    trend_days = int(getattr(settings, "ANALYTICS_TREND_DAYS", 28))
    season_weeks = int(getattr(settings, "ANALYTICS_SEASON_WEEKS", 4))

    hist_end = as_of
    hist_start = as_of - timedelta(days=lookback_days)

    occ_pct_by_date_cat, occ_pct_rollup = await _historical_realized_occ_pct(
        db=db,
        hist_start=hist_start,
        hist_end=hist_end,
        totals_by_category=totals_by_category,
        total_all=total_all,
    )

    # Index historical occupancy by loose seasonality key.
    hist_index_cat: dict[tuple[RoomCategory, tuple[int, int]], list[tuple[date, float]]] = defaultdict(list)
    hist_index_roll: dict[tuple[int, int], list[tuple[date, float]]] = defaultdict(list)

    for (d, cat), pct in occ_pct_by_date_cat.items():
        hist_index_cat[(cat, _similarity_key(d))].append((d, pct))
    for d, pct in occ_pct_rollup.items():
        hist_index_roll[_similarity_key(d)].append((d, pct))

    # Recent trend: compare recent realized mean to its own baseline mean.
    recent_start = as_of - timedelta(days=trend_days)
    recent_dates = [d for d in _date_range(recent_start, as_of) if d < as_of]

    def compute_trend_multiplier_cat(cat: RoomCategory) -> float:
        recent_vals = [occ_pct_by_date_cat.get((d, cat)) for d in recent_dates]
        recent_vals = [v for v in recent_vals if v is not None]
        if not recent_vals:
            return 1.0

        # Baseline for the same recent dates, using their seasonal bucket.
        base_vals: list[float] = []
        for d in recent_dates:
            key = (cat, _similarity_key(d))
            base_samples = [v for (_dd, v) in hist_index_cat.get(key, []) if _dd < d]
            if base_samples:
                base_vals.append(mean(base_samples))
        if not base_vals:
            return 1.0

        recent_mean = mean(recent_vals)
        base_mean = mean(base_vals)
        if base_mean <= 0:
            return 1.0

        # Damped adjustment (kept conservative).
        damp = 0.5
        ratio = recent_mean / base_mean
        return max(0.8, min(1.2, 1.0 + damp * (ratio - 1.0)))

    def compute_trend_multiplier_roll() -> float:
        recent_vals = [occ_pct_rollup.get(d) for d in recent_dates]
        recent_vals = [v for v in recent_vals if v is not None]
        if not recent_vals:
            return 1.0

        base_vals: list[float] = []
        for d in recent_dates:
            key = _similarity_key(d)
            base_samples = [v for (_dd, v) in hist_index_roll.get(key, []) if _dd < d]
            if base_samples:
                base_vals.append(mean(base_samples))
        if not base_vals:
            return 1.0

        recent_mean = mean(recent_vals)
        base_mean = mean(base_vals)
        if base_mean <= 0:
            return 1.0

        damp = 0.5
        ratio = recent_mean / base_mean
        return max(0.8, min(1.2, 1.0 + damp * (ratio - 1.0)))

    trend_mult_by_cat = {cat: compute_trend_multiplier_cat(cat) for cat in totals_by_category.keys()}
    trend_mult_roll = compute_trend_multiplier_roll()

    target_dates = _date_range(start, end)
    out: dict[tuple[date, Optional[RoomCategory]], dict[str, float]] = {}

    def pick_bucket_neighbors(bucket: int) -> set[int]:
        return {bucket + i for i in range(-season_weeks, season_weeks + 1)}

    for cat in totals_by_category.keys():
        for d in target_dates:
            wd, bucket = _similarity_key(d)
            neighbor_buckets = pick_bucket_neighbors(bucket)
            samples: list[float] = []
            for b in neighbor_buckets:
                key = (cat, (wd, b))
                samples.extend([v for (_dd, v) in hist_index_cat.get(key, [])])
            if not samples:
                mu = 0.0
                sigma = 0.0
            else:
                mu = mean(samples)
                sigma = pstdev(samples) if len(samples) > 1 else 0.0

            mu_adj = _clamp_pct(mu * trend_mult_by_cat.get(cat, 1.0))
            low = _clamp_pct(mu_adj - sigma)
            high = _clamp_pct(mu_adj + sigma)
            out[(d, cat)] = {"mean": mu_adj, "low": low, "high": high}

    # Rollup
    for d in target_dates:
        wd, bucket = _similarity_key(d)
        neighbor_buckets = pick_bucket_neighbors(bucket)
        samples: list[float] = []
        for b in neighbor_buckets:
            key = (wd, b)
            samples.extend([v for (_dd, v) in hist_index_roll.get(key, [])])
        if not samples:
            mu = 0.0
            sigma = 0.0
        else:
            mu = mean(samples)
            sigma = pstdev(samples) if len(samples) > 1 else 0.0

        mu_adj = _clamp_pct(mu * trend_mult_roll)
        low = _clamp_pct(mu_adj - sigma)
        high = _clamp_pct(mu_adj + sigma)
        out[(d, None)] = {"mean": mu_adj, "low": low, "high": high}

    return out

