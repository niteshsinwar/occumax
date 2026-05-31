from __future__ import annotations
from typing import Optional
"""
Dashboard controller — heatmap and live gap summary.

All data is computed live from the slots table.
No recommendation or trigger_run tables involved.
"""

from collections import Counter
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from controllers import analytics as analytics_ctrl
from core.models import Booking, Room, Slot, BlockType, RoomCategory, Offer
from core.schemas import HeatmapCell, HeatmapRow, HeatmapResponse, PaceResponse
from core.schemas.dashboard_optimise import DashboardOptimisePreviewResponse
from core.schemas.manager import CommitRequest, CommitResult
from controllers import manager as manager_ctrl
from core.schemas.manager import SwapStep
from services.algorithm.calendar_optimiser import GapDetector, SlotInfo
from core.schemas.dashboard_k_optimise import DashboardKNightPreviewResponse
from core.schemas.dashboard_predict_los import PredictOptimalLosResponse
from services.algorithm.k_night_optimiser import KNightWindowOptimiser
from core.schemas.dashboard_scorecard import (
    DashboardScorecardResponse,
    CapacityScore,
    CapacityDelta,
)
from services.ai.occupancy_predictive_los import run_predict_optimal_los_llm
def _apply_swap_plan_in_memory(
    slot_infos: list[SlotInfo],
    swap_plan: Optional[list[SwapStep]],
) -> list[SlotInfo]:
    """
    Apply swap steps to SlotInfo list in-memory (no DB writes).

    SwapStep semantics:
      - move one SOFT booking_id from from_room to to_room across `dates`
      - vacate source dates (become EMPTY)
      - fill destination dates (become SOFT)

    This is intentionally minimal: it is used only for demo KPI deltas and should
    match the dashboard's swap-plan commit semantics.
    """
    if not swap_plan:
        return slot_infos

    # Build a mutable map keyed by (room_id, date)
    by_room_date: dict[tuple[str, date], SlotInfo] = {(s.room_id, s.date): s for s in slot_infos}

    source_keys = {
        (step.from_room, date.fromisoformat(d_str))
        for step in swap_plan
        for d_str in step.dates
    }
    moves: list[tuple[tuple[str, date], tuple[str, date], str, float, object]] = []

    for step in swap_plan:
        for d_str in step.dates:
            d = date.fromisoformat(d_str)
            src_key = (step.from_room, d)
            dst_key = (step.to_room, d)

            src = by_room_date.get(src_key)
            dst = by_room_date.get(dst_key)
            if not src or not dst:
                continue

            if src.block_type != BlockType.SOFT:
                continue
            if src.booking_id != step.booking_id:
                continue
            if dst.block_type != BlockType.EMPTY and dst_key not in source_keys:
                continue
            moves.append((src_key, dst_key, step.booking_id, src.current_rate, src.channel))

    # Mirror commit semantics: vacate every source first, then fill destinations.
    # This supports circular room swaps where a target cell is occupied until pass 1.
    for src_key, _, _, _, _ in moves:
        src = by_room_date[src_key]
        src.block_type = BlockType.EMPTY
        src.booking_id = None
        src.channel = None

    for _, dst_key, booking_id, current_rate, channel in moves:
        dst = by_room_date[dst_key]
        dst.block_type = BlockType.SOFT
        dst.booking_id = booking_id
        dst.current_rate = current_rate
        dst.channel = channel

    return list(by_room_date.values())


def _count_k_night_windows(slot_infos: list[SlotInfo], k: int) -> int:
    """
    Count bookable windows of length k across the slice.

    Definition: for each room, if it has an EMPTY run of length L, it contributes
    max(0, L - k + 1) windows.
    """
    if k <= 0:
        return 0

    by_room: dict[str, list[SlotInfo]] = {}
    for s in slot_infos:
        by_room.setdefault(s.room_id, []).append(s)

    total = 0
    for _, cells in by_room.items():
        cells.sort(key=lambda x: x.date)
        run = 0
        for c in cells:
            if c.block_type == BlockType.EMPTY:
                run += 1
            else:
                if run >= k:
                    total += run - k + 1
                run = 0
        if run >= k:
            total += run - k + 1

    return int(total)


def _calc_revenue_at_risk(gaps: list) -> float:
    return round(sum(
        (1 - _fill_prob(g.gap_length)) * g.current_rate * g.gap_length
        for g in gaps
    ), 2)


def _revenue_weighted_fill_pct(gaps: list) -> Optional[float]:
    """
    Average implied fill probability weighted by each gap's contribution to revenue_at_risk.

    For gap g: risk_weight = (1 - p(L)) * rate * L, contribution to numerator = p(L) * risk_weight.
    """
    num = 0.0
    den = 0.0
    for g in gaps:
        gl = int(getattr(g, "gap_length", 0))
        rate = float(getattr(g, "current_rate", 0) or 0)
        if gl <= 0 or rate <= 0:
            continue
        p = _fill_prob(gl)
        w = (1 - p) * rate * gl
        if w > 0:
            num += p * w
            den += w
    if den <= 0:
        return None
    return round(100.0 * num / den, 1)


async def get_scorecard(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
    k_nights: list[int],
    swap_plan: Optional[list[SwapStep]] = None,
) -> DashboardScorecardResponse:
    """
    Compute before/after capacity KPIs for the hackathon storyline.

    - before: live DB state over the slice
    - after: optional in-memory application of a swap plan (no DB writes)
    """
    today = date.today()
    cats = list(dict.fromkeys(categories or []))
    ks = [int(k) for k in (k_nights or [2, 3]) if 1 <= int(k) <= 14]
    ks = list(dict.fromkeys(ks)) or [2, 3]

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
    slot_infos_before = _complete_slotinfos_for_window(rooms, slots, start, end)

    det_before = GapDetector(slot_infos_before, today)
    gaps_before = det_before.detect_gaps()
    before_k = {k: _count_k_night_windows(slot_infos_before, k) for k in ks}
    before = CapacityScore(
        orphan_nights=sum(g.gap_length for g in gaps_before),
        revenue_at_risk=_calc_revenue_at_risk(gaps_before),
        k_windows=before_k,
        revenue_weighted_fill_pct=_revenue_weighted_fill_pct(gaps_before),
    )

    if not swap_plan:
        return DashboardScorecardResponse(
            start=start,
            end=end,
            categories=cats,
            k_nights=ks,
            before=before,
            after=None,
            delta=None,
        )

    slot_infos_after = _apply_swap_plan_in_memory(list(slot_infos_before), swap_plan)
    det_after = GapDetector(slot_infos_after, today)
    gaps_after = det_after.detect_gaps()
    after_k = {k: _count_k_night_windows(slot_infos_after, k) for k in ks}
    after = CapacityScore(
        orphan_nights=sum(g.gap_length for g in gaps_after),
        revenue_at_risk=_calc_revenue_at_risk(gaps_after),
        k_windows=after_k,
        revenue_weighted_fill_pct=_revenue_weighted_fill_pct(gaps_after),
    )

    delta = CapacityDelta(
        orphan_nights=after.orphan_nights - before.orphan_nights,
        revenue_at_risk=round(after.revenue_at_risk - before.revenue_at_risk, 2),
        k_windows={k: after.k_windows.get(k, 0) - before.k_windows.get(k, 0) for k in ks},
    )

    return DashboardScorecardResponse(
        start=start,
        end=end,
        categories=cats,
        k_nights=ks,
        before=before,
        after=after,
        delta=delta,
    )


def _fill_prob(gap_length: int) -> float:
    """Deterministic fill probability by gap length."""
    return {1: 0.10, 2: 0.30, 3: 0.55, 4: 0.70}.get(gap_length, 0.75)


def _complete_slotinfos_for_window(
    rooms: list[Room],
    slots: list[Slot],
    start: date,
    end: date,
) -> list[SlotInfo]:
    """
    Build the same room/date matrix rendered by the heatmap.

    Missing Slot rows are valid available inventory in this app; the heatmap
    renders them as EMPTY cells. Capacity KPIs must use the same virtual EMPTY
    cells or dashboard numbers drift from what operators see on screen.
    """
    slot_map = {(s.room_id, s.date): s for s in slots}
    out: list[SlotInfo] = []
    cur = start
    dates: list[date] = []
    while cur < end:
        dates.append(cur)
        cur += timedelta(days=1)

    for room in rooms:
        for d in dates:
            slot = slot_map.get((room.id, d))
            if slot:
                out.append(SlotInfo(
                    slot_id=slot.id,
                    room_id=slot.room_id,
                    category=room.category,
                    date=slot.date,
                    block_type=slot.block_type,
                    booking_id=slot.booking_id,
                    base_rate=room.base_rate,
                    current_rate=slot.current_rate,
                    channel=slot.channel,
                    min_stay_active=slot.min_stay_active,
                    min_stay_nights=slot.min_stay_nights,
                ))
            else:
                out.append(SlotInfo(
                    slot_id=f"{room.id}_{d}",
                    room_id=room.id,
                    category=room.category,
                    date=d,
                    block_type=BlockType.EMPTY,
                    booking_id=None,
                    base_rate=room.base_rate,
                    current_rate=room.base_rate,
                    channel=None,
                    min_stay_active=False,
                    min_stay_nights=1,
                ))
    return out


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

    offer_ids = sorted({s.offer_id for s in slots if s.offer_id})
    offer_map: dict[str, Offer] = {}
    if offer_ids:
        offer_rows = (await db.execute(select(Offer).where(Offer.id.in_(offer_ids)))).scalars().all()
        offer_map = {o.id: o for o in offer_rows}

    # Live gap metrics must include virtual EMPTY cells, matching rendered rows.
    slot_infos = _complete_slotinfos_for_window(
        rooms=rooms,
        slots=slots,
        start=today,
        end=today + timedelta(days=settings.SCAN_WINDOW_DAYS),
    )
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
            offer = offer_map.get(slot.offer_id) if slot and slot.offer_id else None
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
                offer_type=(offer.offer_type.value if offer else None),
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


def _summarize_pace_for_los(pace: PaceResponse) -> str:
    """Compress PaceResponse rollup into one sentence for LLM context."""
    rollup = next((s for s in pace.series if s.category is None), None)
    if not rollup or not rollup.points:
        return "Pace rollup unavailable — insufficient analytics series."
    pts = rollup.points[:12]
    deltas = [p.on_books_occ_pct - p.expected_on_books_occ_pct for p in pts]
    avg_delta = sum(deltas) / max(len(deltas), 1)
    return (
        f"Hotel-wide booking pace vs two-year same-calendar-window baseline: average Δ occupancy "
        f"(on-books minus expected) ≈ {avg_delta:.1f} pts across lead_days 0–{len(pts) - 1} "
        f"for stay window {rollup.stay_start} → {rollup.stay_end}."
    )


async def _booking_los_histogram(db: AsyncSession, start: date, end: date) -> dict[int, int]:
    """
    Count overlapping bookings by overlapping night-span inside [start, end).

    Does **not** filter `Booking.is_live` — that flag is not authoritative in current flows.
    """
    q = select(Booking).where(Booking.check_out > start, Booking.check_in < end)
    bookings = (await db.execute(q)).scalars().all()
    hist: Counter[int] = Counter()
    for b in bookings:
        seg_start = max(start, b.check_in)
        seg_end = min(end, b.check_out)
        nights = max(0, (seg_end - seg_start).days)
        if nights <= 0:
            continue
        hist[nights] += 1
    return dict(sorted(hist.items()))


def _current_event_awareness(start: date, end: date) -> list[dict]:
    """
    Deterministic current-event context for the demo occupancy agent.

    It is intentionally passed as explicit context, separate from DB analytics,
    so the model can cite it without inventing unsupported events.
    """
    signals = [
        {
            "kind": "EVENT",
            "date_window": f"{start.isoformat()}..{min(end, start + timedelta(days=5)).isoformat()}",
            "title": "Weekday technology convention compression",
            "detail": "Corporate arrivals cluster around Tue-Thu, making 3-night Tue-Fri inventory more valuable.",
            "recommended_los_bias": 3,
            "confidence": "HIGH",
        },
        {
            "kind": "TRAVEL",
            "date_window": f"{start.isoformat()}..{min(end, start + timedelta(days=4)).isoformat()}",
            "title": "Airport disruption spillover",
            "detail": "Short-notice displacement demand can absorb 1-2 night fragments but should not drive the main recovery target.",
            "recommended_los_bias": 2,
            "confidence": "MEDIUM",
        },
        {
            "kind": "MARKET",
            "date_window": f"{start.isoformat()}..{end.isoformat()}",
            "title": "Strong on-books pace",
            "detail": "When pace is ahead, prioritize reshaping inventory into sellable multi-night runs instead of preserving single-night fragments.",
            "recommended_los_bias": 3,
            "confidence": "HIGH",
        },
    ]
    return signals


async def predict_optimal_los(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
) -> PredictOptimalLosResponse:
    """
    Poly AI-backed optimal recovery length-of-stay recommendation for the Occupancy pillar.

    Context mixes DB analytics pace summaries, overlapping booking LOS histogram,
    and explicit current-event awareness.
    """
    cats = list(dict.fromkeys(categories))
    today = date.today()
    lead_span = max(1, min(14, (end - start).days))
    pace = await analytics_ctrl.get_pace(db, start, end, today, max_lead_days=lead_span)
    pace_summary = _summarize_pace_for_los(pace)
    los_hist = await _booking_los_histogram(db, start, end)

    context = {
        "stay_window": {"start": str(start), "end": str(end)},
        "filtered_room_categories": [c.value for c in cats] if cats else "ALL_ACTIVE",
        "historical_signals": {
            "pace_vs_two_year_baseline_summary": pace_summary,
            "booking_length_histogram_overlapping_stays_nights_to_count": los_hist,
        },
        "current_event_awareness": _current_event_awareness(start, end),
        "instruction": (
            "Choose ONE recovery target length of stay. Balance DB-derived pace and booking LOS "
            "with the explicit current_event_awareness feed. Do not choose 1 night because it "
            "does not improve recovery shuffles; single-night demand can already use fragments."
        ),
    }
    raw = await run_predict_optimal_los_llm(context)
    k = int(raw.get("recommended_los_nights", 3))
    k = max(2, min(7, k))
    confidence = str(raw.get("confidence", "MEDIUM"))
    rationale = str(raw.get("rationale", "")).strip() or "No rationale returned."
    return PredictOptimalLosResponse(
        recommended_los_nights=k,
        confidence=confidence,
        rationale=rationale,
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

    slot_infos = _complete_slotinfos_for_window(rooms, slots, start, end)
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


async def optimise_k_night_preview(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
    target_nights: int,
) -> DashboardKNightPreviewResponse:
    """
    Preview optimiser that maximizes the number of k-night bookable windows across the slice.

    Returns a swap plan only (no DB writes). Commit using /dashboard/commit-shuffle.
    """
    today = date.today()
    cats = list(dict.fromkeys(categories))  # stable dedupe
    k = max(1, min(14, int(target_nights or 1)))

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
    slot_infos = _complete_slotinfos_for_window(rooms, slots, start, end)

    optimiser = KNightWindowOptimiser(slot_infos, today)
    raw = optimiser.run(target_nights=k, categories=cats)
    swap_plan = [SwapStep(**s) for s in raw.swap_steps]

    return DashboardKNightPreviewResponse(
        target_nights=k,
        shuffle_count=len(swap_plan),
        swap_plan=swap_plan,
    )


async def commit_shuffle(body: CommitRequest, db: AsyncSession) -> CommitResult:
    """
    Commit a swap plan to the slots table (vacate/fill) without placing a new booking.

    This is reused by the Dashboard "Commit Shuffle" flow so the heatmap can improve
    immediately after a Tetris placement check.
    """
    return await manager_ctrl.commit_plan(body, db)
