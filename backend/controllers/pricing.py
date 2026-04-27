"""
Pricing controller — dynamic pricing analysis and commit.

Flow:
  1. GET  /manager/pricing/analyse  → build occupancy snapshot, call AI agent,
                                       return list of PricingRecommendations
  2. POST /manager/pricing/commit   → accept manager-reviewed items, batch-update
                                       slots.current_rate (floor_rate guarded)
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot
from core.models.enums import BlockType
from core.schemas.pricing import (
    PricingCommitItem,
    PricingCommitRequest,
    PricingCommitResult,
    PricingAnalyseResponse,
    PricingRecommendation,
    PricingWhatIfAnalysis,
)
from services.ai.pricing_agent import run_pricing_agent
from services.ai.pricing_what_if_agent import run_pricing_what_if

logger = logging.getLogger(__name__)

CATEGORY_ORDER = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "SUITE", "PREMIUM"]


# ── helpers ───────────────────────────────────────────────────────────────────

async def _build_pricing_context(db: AsyncSession, today: date) -> dict:
    """
    Returns a per-category-per-date occupancy + rate snapshot for the booking
    window.  Shape: { category: { date: { occ_pct, otb, total, avg_rate,
                                          floor_rate, base_rate } } }
    """
    window_end = today + timedelta(days=settings.BOOKING_WINDOW_DAYS)

    rooms_res = await db.execute(
        select(Room.id, Room.category, Room.base_rate, Room.floor_number)
        .where(Room.is_active == True)
    )
    rooms = rooms_res.all()

    # per-category room index
    cat_rooms: dict[str, list[dict]] = defaultdict(list)
    room_cat: dict[str, str] = {}
    for r_id, cat, base_rate, floor in rooms:
        cat_str = cat.value if hasattr(cat, "value") else str(cat)
        cat_rooms[cat_str].append({"id": r_id, "base_rate": base_rate})
        room_cat[r_id] = cat_str

    slots_res = await db.execute(
        select(Slot.room_id, Slot.date, Slot.block_type, Slot.current_rate, Slot.floor_rate)
        .where(Slot.date >= today, Slot.date < window_end)
    )

    # { category: { date: {total, occupied, rate_sum, floor_rates} } }
    agg: dict[str, dict[date, dict]] = defaultdict(lambda: defaultdict(lambda: {
        "total": 0, "occupied": 0, "rate_sum": 0.0, "floor_rate_sum": 0.0,
    }))

    for r_id, d, block_type, cur_rate, floor_rate in slots_res.all():
        cat = room_cat.get(r_id)
        if not cat:
            continue
        agg[cat][d]["total"] += 1
        agg[cat][d]["rate_sum"] += cur_rate
        agg[cat][d]["floor_rate_sum"] += (floor_rate or 0.0)
        if block_type in (BlockType.SOFT, BlockType.HARD):
            agg[cat][d]["occupied"] += 1

    # Fill in total counts from room list for dates with no slots yet
    for cat, rooms_list in cat_rooms.items():
        total_rooms = len(rooms_list)
        base_rate = rooms_list[0]["base_rate"] if rooms_list else 0.0
        for delta in range(settings.BOOKING_WINDOW_DAYS):
            d = today + timedelta(days=delta)
            bucket = agg[cat][d]
            if bucket["total"] == 0:
                bucket["total"] = total_rooms
                bucket["rate_sum"] = total_rooms * base_rate
            bucket["base_rate"] = base_rate

    # Compute derived fields
    snapshot: dict[str, dict[str, dict]] = {}
    for cat, dates in agg.items():
        snapshot[cat] = {}
        for d, b in dates.items():
            total = b["total"] or 1
            occupied = b["occupied"]
            avg_rate = round(b["rate_sum"] / total, 2)
            avg_floor = round(b["floor_rate_sum"] / total, 2)
            snapshot[cat][d.isoformat()] = {
                "occ_pct": round(occupied / total * 100, 1),
                "otb": occupied,
                "total": total,
                "avg_rate": avg_rate,
                "floor_rate": avg_floor,
                "base_rate": b.get("base_rate", avg_rate),
            }

    return snapshot


def _build_context_text(snapshot: dict, today: date) -> str:
    """Convert snapshot dict → readable text for AI system prompt Tier-1."""
    lines = [
        f"Date: {today}  |  Pricing window: {today} – "
        f"{today + timedelta(days=settings.BOOKING_WINDOW_DAYS)}",
        "",
        "Per-category occupancy snapshot (next 14 days):",
    ]
    for cat in CATEGORY_ORDER:
        if cat not in snapshot:
            continue
        # Show next 14 days inline
        rows = []
        for delta in range(14):
            d = (today + timedelta(days=delta)).isoformat()
            if d not in snapshot[cat]:
                continue
            b = snapshot[cat][d]
            rows.append(
                f"  {d}: occ={b['occ_pct']}%  otb={b['otb']}/{b['total']}"
                f"  rate=${b['avg_rate']:,.0f}  floor=${b['floor_rate']:,.0f}"
            )
        if rows:
            lines.append(f"\n[{cat}]")
            lines.extend(rows)

    lines.append(
        "\nUse get_pricing_context(category, start_date, end_date) for the full window."
    )
    return "\n".join(lines)


# ── public API ────────────────────────────────────────────────────────────────

async def analyse(db: AsyncSession) -> PricingAnalyseResponse:
    today = date.today()
    snapshot = await _build_pricing_context(db, today)
    context_text = _build_context_text(snapshot, today)

    result = await run_pricing_agent(
        snapshot=snapshot,
        context_text=context_text,
        today=today,
        db=db,
    )

    recs = [PricingRecommendation(**r) for r in result["recommendations"]]
    what_if_payload = await run_pricing_what_if(snapshot, today)
    what_if = PricingWhatIfAnalysis.model_validate(what_if_payload)

    return PricingAnalyseResponse(
        hotel_name=settings.HOTEL_NAME,
        analysis_date=today,
        recommendations=recs,
        summary=result["summary"],
        what_if=what_if,
    )


async def commit(body: PricingCommitRequest, db: AsyncSession) -> PricingCommitResult:
    """
    Batch-update slots.current_rate for each committed item.
    Skips any item where new_rate < floor_rate.
    """
    updated = 0
    skipped = 0

    for item in body.items:
        # Fetch all slots for this category on this date
        slots_res = await db.execute(
            select(Slot)
            .join(Room, Slot.room_id == Room.id)
            .where(
                Room.category == item.category,
                Slot.date == item.date,
                Room.is_active == True,
            )
        )
        slots = slots_res.scalars().all()

        if not slots:
            skipped += 1
            continue

        for slot in slots:
            floor = slot.floor_rate or 0.0
            if item.new_rate < floor:
                logger.warning(
                    "Pricing commit: $%.0f below floor $%.0f for %s on %s — skipped",
                    item.new_rate, floor, item.category, item.date,
                )
                skipped += 1
                break
            slot.current_rate = item.new_rate
            updated += 1

    await db.commit()
    logger.info("Pricing commit: %d slot rows updated, %d skipped", updated, skipped)
    return PricingCommitResult(updated=updated, skipped=skipped)
