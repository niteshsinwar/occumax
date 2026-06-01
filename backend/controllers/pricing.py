"""
Pricing controller — dynamic pricing analysis and commit.

Flow:
  1. GET  /manager/pricing/analyse  → build occupancy snapshot, run multi-call AI agent,
                                       return calendar recommendations + summary cards data
  2. POST /manager/pricing/commit   → accept manager-reviewed items, batch-update
                                       slots.current_rate (floor_rate guarded)
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Booking, Room, Slot
from core.models.enums import BlockType, Channel
from core.schemas.pricing import (
    PricingAnalyseRequest,
    PricingAnalyseResponse,
    PricingCalendarCell,
    PricingCalendarRow,
    PricingCommitRequest,
    PricingCommitResult,
    PricingRecommendation,
)
from services.ai.pricing_agent import WINDOW_DAYS, run_pricing_agent
from services.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

CATEGORY_ORDER = ["ECONOMY", "STANDARD", "DELUXE", "SUITE"]


# ── Snapshot builder ──────────────────────────────────────────────────────────

async def _build_pricing_context(db: AsyncSession, today: date) -> dict:
    """
    Returns a per-category-per-date occupancy + rate snapshot for the booking window.
    Shape: { category: { date_iso: { occ_pct, otb, total, avg_rate, floor_rate, base_rate } } }
    """
    window_end = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)

    rooms_res = await db.execute(
        select(Room.id, Room.category, Room.base_rate, Room.floor_number)
        .where(Room.is_active == True)
    )
    rooms = rooms_res.all()

    cat_rooms: dict[str, list[dict]] = defaultdict(list)
    for r_id, cat, base_rate, floor in rooms:
        cat_str = cat.value if hasattr(cat, "value") else str(cat)
        cat_rooms[cat_str].append({"id": r_id, "base_rate": float(base_rate or 0.0)})

    slots_res = await db.execute(
        select(Slot.room_id, Slot.date, Slot.block_type, Slot.current_rate, Slot.floor_rate)
        .where(Slot.date >= today, Slot.date < window_end)
    )
    slot_map = {(room_id, d): (block_type, float(cur_rate or 0.0), float(floor_rate or 0.0))
                for room_id, d, block_type, cur_rate, floor_rate in slots_res.all()}

    agg: dict[str, dict[date, dict]] = defaultdict(dict)
    for cat, rooms_list in cat_rooms.items():
        for delta in range(settings.BOOKING_WINDOW_DAYS):
            d = today + timedelta(days=delta)
            total = len(rooms_list)
            occupied = 0
            rate_sum = 0.0
            floor_rate_sum = 0.0
            base_rate_sum = 0.0

            for room in rooms_list:
                base_rate = float(room["base_rate"] or 0.0)
                base_rate_sum += base_rate
                slot = slot_map.get((room["id"], d))
                if slot:
                    block_type, current_rate, floor_rate = slot
                    rate_sum += current_rate
                    floor_rate_sum += floor_rate
                    if block_type in (BlockType.SOFT, BlockType.HARD):
                        occupied += 1
                else:
                    rate_sum += base_rate

            agg[cat][d] = {
                "total": total,
                "occupied": occupied,
                "rate_sum": rate_sum,
                "floor_rate_sum": floor_rate_sum,
                "base_rate": base_rate_sum / total if total else 0.0,
            }

    snapshot: dict[str, dict[str, dict]] = {}
    for cat, dates in agg.items():
        snapshot[cat] = {}
        for d, b in dates.items():
            total = b["total"] or 1
            occupied = b["occupied"]
            snapshot[cat][d.isoformat()] = {
                "occ_pct": round(occupied / total * 100, 1),
                "otb": occupied,
                "total": total,
                "avg_rate": round(b["rate_sum"] / total, 2),
                "floor_rate": round(b["floor_rate_sum"] / total, 2),
                "base_rate": b.get("base_rate", 0.0),
            }

    return snapshot


def _build_context_text(snapshot: dict, today: date) -> str:
    """Compact occupancy text for agent context. Shows next 14 days for STANDARD/DELUXE/SUITE."""
    lines = [f"Date: {today}  |  Pricing window: {today} – {today + timedelta(days=WINDOW_DAYS)}", ""]
    for cat in ["STANDARD", "DELUXE", "SUITE"]:
        if cat not in snapshot:
            continue
        rows = []
        for delta in range(14):
            d = (today + timedelta(days=delta)).isoformat()
            b = snapshot[cat].get(d)
            if b:
                rows.append(f"  {d}: occ={b['occ_pct']}%  otb={b['otb']}/{b['total']}  rate=${b['avg_rate']:,.0f}")
        if rows:
            lines.append(f"\n[{cat}]")
            lines.extend(rows)
    return "\n".join(lines)


# ── Cards data builder ────────────────────────────────────────────────────────

async def _build_cards_data(db: AsyncSession, today: date, snapshot: dict) -> dict:
    """Compute raw numbers for the 4 summary cards from DB."""
    window_end = today + timedelta(days=WINDOW_DAYS)
    week_ago = today - timedelta(days=7)

    bookings_res = await db.execute(
        select(Booking.id)
        .where(Booking.created_at >= week_ago)
    )
    bookings_this_week = len(bookings_res.all())

    orphan_nights = 0
    orphan_categories: set[str] = set()
    unsold_rooms = 0
    revenue_at_risk = 0.0
    revenue_this_week = 0.0
    rooms_discounted = 0

    for cat, dates_data in snapshot.items():
        sorted_items = sorted(dates_data.items())
        for i, (d_str, b) in enumerate(sorted_items):
            d = date.fromisoformat(d_str)
            if d < today or d >= window_end:
                continue

            empty = b.get("total", 0) - b.get("otb", 0)
            if empty > 0:
                unsold_rooms += empty
                revenue_at_risk += empty * b.get("avg_rate", 0.0)

            # Discounted: current avg_rate is more than 5% below base_rate
            if b.get("base_rate", 0.0) > 0 and b.get("avg_rate", 0.0) < b["base_rate"] * 0.95:
                rooms_discounted += 1

            # Revenue on books for the coming week
            if today <= d < today + timedelta(days=7):
                revenue_this_week += b.get("otb", 0) * b.get("avg_rate", 0.0)

            # Orphan night: isolated low-occ slot between two high-occ dates
            if 0 < i < len(sorted_items) - 1:
                prev_occ = sorted_items[i - 1][1].get("occ_pct", 0)
                next_occ = sorted_items[i + 1][1].get("occ_pct", 0)
                cur_occ = b.get("occ_pct", 0)
                if cur_occ < 30 and prev_occ > 70 and next_occ > 70:
                    orphan_nights += 1
                    orphan_categories.add(cat)

    return {
        "orphan_nights": orphan_nights,
        "orphan_categories": sorted(orphan_categories),
        "unsold_rooms": unsold_rooms,
        "bookings_this_week": bookings_this_week,
        "revenue_at_risk": round(revenue_at_risk),
        "revenue_this_week": round(revenue_this_week),
        "rooms_discounted": rooms_discounted,
    }


def _compute_rescue_potential(calendar_map: dict, snapshot: dict) -> float:
    """
    Estimate $ value recoverable if all AI recommendations are committed.
    - Discounts: fills empty orphan rooms → 40% assumed conversion × discounted rate
    - Increases: uplift on already-booked rooms (suggested - current) × otb
    """
    rescue = 0.0
    for cat, cells in calendar_map.items():
        snap_cat = snapshot.get(cat.upper(), {})
        for cell in (cells if isinstance(cells, list) else []):
            if not isinstance(cell, dict):
                continue
            change = float(cell.get("change_pct", 0.0))
            if abs(change) < 2:
                continue
            d = cell.get("date", "")
            snap_day = snap_cat.get(d, {})
            current = snap_day.get("avg_rate", 0.0)
            suggested = float(cell.get("suggested_rate", current))
            empty = snap_day.get("total", 0) - snap_day.get("otb", 0)
            otb = snap_day.get("otb", 0)

            if change < 0 and empty > 0:
                # Discount fills empty rooms at 40% conversion assumption
                rescue += suggested * empty * 0.4
            elif change > 0 and otb > 0:
                # Rate increase captured on already-committed bookings
                rescue += (suggested - current) * otb

    return round(rescue)


# ── Public API ────────────────────────────────────────────────────────────────

async def analyse() -> PricingAnalyseResponse:
    today = date.today()
    async with AsyncSessionLocal() as db:
        snapshot = await _build_pricing_context(db, today)

    context_text = _build_context_text(snapshot, today)
    dates = [(today + timedelta(days=i)).isoformat() for i in range(WINDOW_DAYS)]

    result = await run_pricing_agent(
        snapshot=snapshot,
        context_text=context_text,
        today=today,
        session_factory=AsyncSessionLocal,
    )

    calendar_map = result.get("calendar", {})

    # Build calendar rows — one row per category, one cell per date
    calendar_rows: list[PricingCalendarRow] = []
    for cat in CATEGORY_ORDER:
        snap_cat = snapshot.get(cat, {})
        if not snap_cat:
            continue

        cells_by_date = {
            cell.get("date"): cell
            for cell in (calendar_map.get(cat) or [])
            if isinstance(cell, dict) and cell.get("date")
        }

        cells: list[PricingCalendarCell] = []
        for d in dates:
            snap_day = snap_cat.get(d, {})
            avg_rate = snap_day.get("avg_rate", 0.0)
            floor_rate = snap_day.get("floor_rate", 0.0)
            cell = cells_by_date.get(d, {})

            suggested = float(cell.get("suggested_rate", avg_rate))
            # Hard floor-rate guard — AI must not go below floor
            if floor_rate > 0 and suggested < floor_rate:
                suggested = floor_rate

            action = cell.get("action", "MAINTAIN")
            # Reconcile action with actual rate change to avoid mismatch
            if suggested > avg_rate * 1.02:
                action = "INCREASE"
            elif suggested < avg_rate * 0.98:
                action = "DISCOUNT"
            else:
                action = "MAINTAIN"

            cells.append(PricingCalendarCell(
                date=d,
                current_rate=avg_rate,
                suggested_rate=round(suggested / 5) * 5,  # nearest $5
                change_pct=round((suggested - avg_rate) / avg_rate * 100, 1) if avg_rate else 0.0,
                action=action,
                confidence=cell.get("confidence", "MEDIUM"),
                reason=cell.get("reason", ""),
                occupancy_pct=snap_day.get("occ_pct", 0.0),
                otb=int(snap_day.get("otb", 0)),
                floor_rate=floor_rate,
                is_orphan=False,
                weather_factor=cell.get("weather_factor", "") or "",
                event_factor=cell.get("event_factor", "") or "",
                news_factor=cell.get("news_factor", "") or "",
            ))

        if any(c.current_rate > 0 for c in cells):
            calendar_rows.append(PricingCalendarRow(category=cat, cells=cells))

    rescue_potential = _compute_rescue_potential(calendar_map, snapshot)
    meta = result.get("_meta", {})

    # Flat list for the review table — only actionable days (INCREASE or DISCOUNT)
    recommendations: list[PricingRecommendation] = [
        PricingRecommendation(
            category=row.category,
            date=cell.date,
            current_rate=cell.current_rate,
            suggested_rate=cell.suggested_rate,
            change_pct=cell.change_pct,
            action=cell.action,
            confidence=cell.confidence,
            reason=cell.reason,
            occupancy_pct=cell.occupancy_pct,
            otb=cell.otb,
        )
        for row in calendar_rows
        for cell in row.cells
        if cell.action != "MAINTAIN"
    ]

    return PricingAnalyseResponse(
        hotel_name=settings.HOTEL_NAME,
        analysis_date=today.isoformat(),
        summary=result.get("summary", ""),
        calendar_rows=calendar_rows,
        recommendations=recommendations,
        dates=dates,
        rescue_potential=rescue_potential,
        run_id=str(meta.get("run_id", "")),
        cache_hit=bool(meta.get("cache_hit", False)),
        llm_call_count=int(meta.get("llm_call_count", 0) or 0),
        context_hash=str(meta.get("context_hash", "")),
    )


async def analyse_with_context(body: PricingAnalyseRequest) -> PricingAnalyseResponse:
    """
    Same as analyse(), but the AI agent consumes ONLY the provided context feed bundle
    (frontend mock contextFeed.ts) for external signal inputs.
    """
    today = date.today()
    wd = min(max(body.window_days, 1), 60)
    async with AsyncSessionLocal() as db:
        snapshot = await _build_pricing_context(db, today)

    context_text = _build_context_text(snapshot, today)
    dates = [(today + timedelta(days=i)).isoformat() for i in range(wd)]

    result = await run_pricing_agent(
        snapshot=snapshot,
        context_text=context_text,
        today=today,
        session_factory=AsyncSessionLocal,
        context_items=[ci.model_dump() for ci in body.context_items],
        analysis_window_days=wd,
        empty_nights_only=body.empty_nights_only,
    )

    calendar_map = result.get("calendar", {})

    calendar_rows: list[PricingCalendarRow] = []
    for cat in CATEGORY_ORDER:
        snap_cat = snapshot.get(cat, {})
        if not snap_cat:
            continue

        cells_by_date = {
            cell.get("date"): cell
            for cell in (calendar_map.get(cat) or [])
            if isinstance(cell, dict) and cell.get("date")
        }

        cells: list[PricingCalendarCell] = []
        for d in dates:
            snap_day = snap_cat.get(d, {})
            avg_rate = snap_day.get("avg_rate", 0.0)
            floor_rate = snap_day.get("floor_rate", 0.0)
            cell = cells_by_date.get(d, {})

            suggested = float(cell.get("suggested_rate", avg_rate))
            if floor_rate > 0 and suggested < floor_rate:
                suggested = floor_rate

            action = cell.get("action", "MAINTAIN")
            if suggested > avg_rate * 1.02:
                action = "INCREASE"
            elif suggested < avg_rate * 0.98:
                action = "DISCOUNT"
            else:
                action = "MAINTAIN"

            cells.append(PricingCalendarCell(
                date=d,
                current_rate=avg_rate,
                suggested_rate=round(suggested / 5) * 5,
                change_pct=round((suggested - avg_rate) / avg_rate * 100, 1) if avg_rate else 0.0,
                action=action,
                confidence=cell.get("confidence", "MEDIUM"),
                reason=cell.get("reason", ""),
                occupancy_pct=snap_day.get("occ_pct", 0.0),
                otb=int(snap_day.get("otb", 0)),
                floor_rate=floor_rate,
                is_orphan=False,
                weather_factor=cell.get("weather_factor", "") or "",
                event_factor=cell.get("event_factor", "") or "",
                news_factor=cell.get("news_factor", "") or "",
            ))

        if any(c.current_rate > 0 for c in cells):
            calendar_rows.append(PricingCalendarRow(category=cat, cells=cells))

    rescue_potential = _compute_rescue_potential(calendar_map, snapshot)
    meta = result.get("_meta", {})

    recommendations: list[PricingRecommendation] = [
        PricingRecommendation(
            category=row.category,
            date=cell.date,
            current_rate=cell.current_rate,
            suggested_rate=cell.suggested_rate,
            change_pct=cell.change_pct,
            action=cell.action,
            confidence=cell.confidence,
            reason=cell.reason,
            occupancy_pct=cell.occupancy_pct,
            otb=cell.otb,
        )
        for row in calendar_rows
        for cell in row.cells
        if cell.action != "MAINTAIN"
    ]

    return PricingAnalyseResponse(
        hotel_name=settings.HOTEL_NAME,
        analysis_date=today.isoformat(),
        summary=result.get("summary", ""),
        calendar_rows=calendar_rows,
        recommendations=recommendations,
        dates=dates,
        rescue_potential=rescue_potential,
        run_id=str(meta.get("run_id", "")),
        cache_hit=bool(meta.get("cache_hit", False)),
        llm_call_count=int(meta.get("llm_call_count", 0) or 0),
        context_hash=str(meta.get("context_hash", "")),
    )


async def commit(body: PricingCommitRequest, db: AsyncSession) -> PricingCommitResult:
    """Batch-update unsold slots.current_rate for committed items. Skips booked/stale slots and floor breaches."""
    updated = 0
    skipped = 0

    categories = {item.category for item in body.items}
    dates = {item.date for item in body.items}

    room_rows = await db.execute(
        select(Room.id, Room.category, Room.base_rate)
        .where(
            Room.category.in_(categories),
            Room.is_active == True,
        )
    )
    rooms_by_category: dict[str, list[tuple[str, float]]] = defaultdict(list)
    room_ids: list[str] = []
    for room_id, category, base_rate in room_rows.all():
        cat = category.value if hasattr(category, "value") else str(category)
        rooms_by_category[cat].append((room_id, float(base_rate or 0.0)))
        room_ids.append(room_id)

    slot_rows = await db.execute(
        select(Slot)
        .where(
            Slot.room_id.in_(room_ids) if room_ids else False,
            Slot.date.in_(dates),
        )
        .with_for_update()
    )
    slots_by_room_date = {(slot.room_id, slot.date): slot for slot in slot_rows.scalars().all()}

    for item in body.items:
        rooms = rooms_by_category.get(item.category, [])
        if not rooms:
            skipped += 1
            continue

        for room_id, base_rate in rooms:
            slot = slots_by_room_date.get((room_id, item.date))
            if slot:
                if slot.block_type != BlockType.EMPTY:
                    skipped += 1
                    continue
                if item.new_rate < (slot.floor_rate or 0.0):
                    logger.warning(
                        "Pricing commit: $%.0f below floor $%.0f for %s/%s on %s - skipped",
                        item.new_rate, slot.floor_rate or 0.0, item.category, room_id, item.date,
                    )
                    skipped += 1
                    continue
                slot.current_rate = item.new_rate
                updated += 1
            else:
                db.add(Slot(
                    id=f"{room_id}_{item.date}",
                    room_id=room_id,
                    date=item.date,
                    block_type=BlockType.EMPTY,
                    booking_id=None,
                    current_rate=item.new_rate,
                    floor_rate=0.0,
                    channel=Channel.DIRECT,
                    channel_partner=None,
                ))
                updated += 1

    await db.commit()
    logger.info("Pricing commit: %d slot rows updated, %d skipped", updated, skipped)
    return PricingCommitResult(updated=updated, skipped=skipped)
