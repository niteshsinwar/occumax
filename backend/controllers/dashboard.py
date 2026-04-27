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
from core.models import Room, Slot, BlockType, RoomCategory, Channel, Offer, OfferType
from core.schemas import HeatmapCell, HeatmapRow, HeatmapResponse
from core.schemas.dashboard_optimise import DashboardOptimisePreviewResponse
from core.schemas.sandwich_playbook import SandwichPlaybookResponse
from core.schemas.manager import CommitRequest, CommitResult
from controllers import manager as manager_ctrl
from core.schemas.manager import SwapStep
from services.algorithm.calendar_optimiser import GapDetector, SlotInfo
from core.schemas.dashboard_k_optimise import DashboardKNightPreviewResponse
from services.algorithm.k_night_optimiser import KNightWindowOptimiser
from core.schemas.dashboard_scorecard import (
    DashboardScorecardResponse,
    CapacityScore,
    CapacityDelta,
)


def _apply_swap_plan_in_memory(
    slot_infos: list[SlotInfo],
    swap_plan: list[SwapStep] | None,
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

    for step in swap_plan:
        for d_str in step.dates:
            d = date.fromisoformat(d_str)

            src = by_room_date.get((step.from_room, d))
            dst = by_room_date.get((step.to_room, d))
            if not src or not dst:
                continue

            # Mirror frontend `simulateRows` semantics:
            # only move SOFT→EMPTY into EMPTY→SOFT.
            if src.block_type != BlockType.SOFT:
                continue
            if dst.block_type != BlockType.EMPTY:
                continue

            # Keep booking_id alignment if present, but don't over-restrict
            # (some steps may omit matching ids due to synthetic data).
            src.block_type = BlockType.EMPTY
            src.booking_id = None

            dst.block_type = BlockType.SOFT
            dst.booking_id = step.booking_id

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


async def get_scorecard(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
    k_nights: list[int],
    swap_plan: list[SwapStep] | None = None,
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
    slot_infos_before = _slots_to_slotinfo(slots, room_map)

    det_before = GapDetector(slot_infos_before, today)
    gaps_before = det_before.detect_gaps()
    before_k = {k: _count_k_night_windows(slot_infos_before, k) for k in ks}
    before = CapacityScore(
        orphan_nights=sum(g.gap_length for g in gaps_before),
        revenue_at_risk=_calc_revenue_at_risk(gaps_before),
        k_windows=before_k,
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
            min_stay_active=s.min_stay_active,
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

    offer_ids = sorted({s.offer_id for s in slots if s.offer_id})
    offer_map: dict[str, Offer] = {}
    if offer_ids:
        offer_rows = (await db.execute(select(Offer).where(Offer.id.in_(offer_ids)))).scalars().all()
        offer_map = {o.id: o for o in offer_rows}

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

    slot_infos = _slots_to_slotinfo(slots, room_map)
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
    slot_infos = _slots_to_slotinfo(slots, room_map)

    optimiser = KNightWindowOptimiser(slot_infos, today)
    raw = optimiser.run(target_nights=k, categories=cats)
    swap_plan = [SwapStep(**s) for s in raw.swap_steps]

    return DashboardKNightPreviewResponse(
        target_nights=k,
        shuffle_count=len(swap_plan),
        swap_plan=swap_plan,
    )


async def apply_sandwich_playbook(
    db: AsyncSession,
    start: date,
    end: date,
    categories: list[RoomCategory],
) -> SandwichPlaybookResponse:
    """
    Apply the sandwich-night playbook for the given slice:
    - Finds single-night EMPTY slots bounded by non-EMPTY on both sides in the same room.
    - For those dates, relax MinLOS to 1 night (min_stay_active=True, min_stay_nights=1).
    """
    cats = list(dict.fromkeys(categories))  # stable dedupe

    rooms_q = select(Room).where(Room.is_active == True)
    if cats:
        rooms_q = rooms_q.where(Room.category.in_(cats))
    rooms_q = rooms_q.order_by(Room.category, Room.id)
    rooms = (await db.execute(rooms_q)).scalars().all()
    room_map = {r.id: r for r in rooms}
    if not room_map:
        return SandwichPlaybookResponse(
            start=start,
            end=end,
            categories=cats,
            orphan_slots_found=0,
            slots_updated=0,
        )

    slots_q = (
        select(Slot)
        .where(
            Slot.date >= start,
            Slot.date < end,
            Slot.room_id.in_(list(room_map.keys())),
        )
    )
    slots = (await db.execute(slots_q)).scalars().all()
    slot_by_id: dict[str, Slot] = {s.id: s for s in slots}

    orphan_slot_ids: list[str] = []
    slots_updated = 0
    has_writes = False

    scan_dates = []
    cur = start
    while cur < end:
        scan_dates.append(cur)
        cur += timedelta(days=1)

    for room_id in room_map.keys():
        # Build per-date block_type for this room; missing slot = EMPTY
        room_cells: list[tuple[date, BlockType]] = []
        for d in scan_dates:
            sid = f"{room_id}_{d}"
            s = slot_by_id.get(sid)
            room_cells.append((d, s.block_type if s else BlockType.EMPTY))

        # Detect sandwich single nights: EMPTY bounded on both sides
        for i in range(1, len(room_cells) - 1):
            d, bt = room_cells[i]
            if bt != BlockType.EMPTY:
                continue
            before_bt = room_cells[i - 1][1]
            after_bt = room_cells[i + 1][1]
            if before_bt == BlockType.EMPTY or after_bt == BlockType.EMPTY:
                continue

            sid = f"{room_id}_{d}"
            orphan_slot_ids.append(sid)

            slot = slot_by_id.get(sid)
            if not slot:
                room = room_map[room_id]
                original_rate = float(room.base_rate)
                discount_pct = 0.50
                discounted_rate = round(original_rate * (1 - discount_pct), 2)
                offer = Offer(
                    offer_type=OfferType.SANDWICH_ORPHAN,
                    category=room.category,
                    offer_date=d,
                    discount_pct=discount_pct,
                    original_rate=original_rate,
                    discounted_rate=discounted_rate,
                    reason="Auto playbook: sandwich orphan night",
                )
                db.add(offer)
                await db.flush()
                slot = Slot(
                    id=sid,
                    room_id=room_id,
                    date=d,
                    block_type=BlockType.EMPTY,
                    booking_id=None,
                    current_rate=discounted_rate,
                    channel=Channel.DIRECT,
                    channel_partner=None,
                    min_stay_active=True,
                    min_stay_nights=1,
                    offer_id=offer.id,
                )
                db.add(slot)
                slot_by_id[sid] = slot
                slots_updated += 1
                has_writes = True
                continue

            # Only update if not already relaxed
            if (not slot.min_stay_active) or (slot.min_stay_nights != 1):
                slot.min_stay_active = True
                slot.min_stay_nights = 1
                slots_updated += 1
                has_writes = True

            # Apply (or refresh) discount offer for this slot if it's empty
            if slot.block_type == BlockType.EMPTY:
                # Treat base_rate as the pre-offer "rack" rate for this playbook.
                original_rate = float(room_map[room_id].base_rate)
                discount_pct = 0.50
                discounted_rate = round(original_rate * (1 - discount_pct), 2)

                if slot.offer_id:
                    offer = await db.get(Offer, slot.offer_id)
                    if offer:
                        prev = (
                            offer.offer_type,
                            offer.discount_pct,
                            offer.original_rate,
                            offer.discounted_rate,
                            offer.offer_date,
                        )
                        offer.offer_type = OfferType.SANDWICH_ORPHAN
                        offer.category = room_map[room_id].category
                        offer.offer_date = d
                        offer.discount_pct = discount_pct
                        offer.original_rate = original_rate
                        offer.discounted_rate = discounted_rate
                        offer.reason = "Auto playbook: sandwich orphan night"
                        if prev != (
                            offer.offer_type,
                            offer.discount_pct,
                            offer.original_rate,
                            offer.discounted_rate,
                            offer.offer_date,
                        ):
                            has_writes = True
                else:
                    offer = Offer(
                        offer_type=OfferType.SANDWICH_ORPHAN,
                        category=room_map[room_id].category,
                        offer_date=d,
                        discount_pct=discount_pct,
                        original_rate=original_rate,
                        discounted_rate=discounted_rate,
                        reason="Auto playbook: sandwich orphan night",
                    )
                    db.add(offer)
                    await db.flush()
                    slot.offer_id = offer.id
                    has_writes = True

                if slot.current_rate != discounted_rate:
                    slot.current_rate = discounted_rate
                    slots_updated += 1
                    has_writes = True

    if has_writes:
        await db.commit()

    return SandwichPlaybookResponse(
        start=start,
        end=end,
        categories=cats,
        orphan_slots_found=len(orphan_slot_ids),
        slots_updated=slots_updated,
    )


async def commit_shuffle(body: CommitRequest, db: AsyncSession) -> CommitResult:
    """
    Commit a swap plan to the slots table (vacate/fill) without placing a new booking.

    This is reused by the Dashboard "Commit Shuffle" flow so the heatmap can improve
    immediately after a Tetris placement check.
    """
    return await manager_ctrl.commit_plan(body, db)


