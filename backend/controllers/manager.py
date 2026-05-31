"""
Manager controller — stateless T1 calendar optimisation.

Flow:
  1. POST /manager/optimise  → run algorithm, return swap plan in HTTP response (no DB write)
  2. POST /manager/commit    → accept that plan, apply moves to slots table atomically
"""

from __future__ import annotations

import logging
import copy
import hashlib
import json
import time
import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot, Booking, BlockType, Channel, RoomCategory
from core.schemas.manager import SwapStep, GapInfo, OptimiseResult, CommitRequest, CommitResult, ChannelAllocateRequest, ChannelAllocateResult
from core.schemas.analytics import ChannelRecommendResponse, ChannelRecommendation, ChannelPartnerInsight
from core.channel_config import OTA_PARTNER_NAMES, OTA_PARTNER_NAMES_LIST
from services.algorithm.calendar_optimiser import GapDetector, SlotInfo
from services.ai.channel_agent import run_channel_agent
from services.database import AsyncSessionLocal

logger = logging.getLogger(__name__)
_CHANNEL_CACHE_TTL_SECONDS = 15 * 60
_CHANNEL_RECOMMEND_CACHE: dict[str, tuple[float, dict]] = {}


def _stable_hash(payload: object) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


async def _load_slots(db: AsyncSession, today: date) -> list[SlotInfo]:
    end = today + timedelta(days=settings.SCAN_WINDOW_DAYS)
    result = await db.execute(
        select(Slot, Room)
        .join(Room, Slot.room_id == Room.id)
        .where(Slot.date >= today, Slot.date < end)
    )
    rows = result.all()
    return [
        SlotInfo(
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
        )
        for slot, room in rows
    ]


async def run_optimisation(db: AsyncSession) -> OptimiseResult:
    """
    Run the full T1 HHI optimisation pipeline.
    Returns the complete global swap plan in memory — nothing is written to the DB.
    """
    today = date.today()
    slots = await _load_slots(db, today)
    detector = GapDetector(slots, today)
    
    # run() now returns (gaps, all_steps) — 'all_steps' is the global master plan
    gaps, all_steps_raw = detector.run()

    # Convert raw dicts from the algorithm into SwapStep schemas
    full_swap_plan = [SwapStep(**s) for s in all_steps_raw]

    # Map specific steps to specific gaps for UI highlights
    gap_infos: list[GapInfo] = []
    for gap in gaps:
        if not gap.shuffle_possible or not gap.shuffle_plan:
            continue
        gap_infos.append(GapInfo(
            room_id=gap.room_id,
            category=str(gap.category),
            date_range=gap.date_range_str,
            gap_length=gap.gap_length,
            shuffle_plan=[SwapStep(**s) for s in gap.shuffle_plan],
        ))

    shuffle_count = len(full_swap_plan)
    fully_clean = len(gaps) == 0
    # converged: orphan gaps exist but the global optimum has already been reached
    # (no rearrangement can eliminate them — they are structural)
    converged = (not fully_clean) and shuffle_count == 0

    logger.info(
        "T1 optimise: %d gaps found, %d total moves, converged=%s, fully_clean=%s",
        len(gaps), shuffle_count, converged, fully_clean,
    )

    return OptimiseResult(
        gaps_found=len(gaps),
        shuffle_count=shuffle_count,
        converged=converged,
        fully_clean=fully_clean,
        swap_plan=full_swap_plan,
        gaps=gap_infos,
    )


async def commit_plan(body: CommitRequest, db: AsyncSession) -> CommitResult:
    """
    Atomically apply a swap plan to the slots table.
    
    Uses a two-pass approach within a single transaction:
      1. VACATE: Clear all source slots for all bookings in the plan.
      2. FILL: Assign bookings to their new destination slots.
    
    This handles circular dependencies (e.g., A moves to B's room, B moves to C's room).
    """
    applied = 0
    slots_updated = 0
    parsed_dates: dict[tuple[str, str, str], list[date]] = {}
    source_slot_ids: set[str] = set()
    destination_slot_ids: set[str] = set()

    for step in body.swap_plan:
        dates: list[date] = []
        for date_str in step.dates:
            try:
                d = date.fromisoformat(date_str)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid swap date: {date_str}") from None
            dates.append(d)
            source_slot_ids.add(f"{step.from_room}_{d}")
            destination_slot_ids.add(f"{step.to_room}_{d}")
        parsed_dates[(step.from_room, step.to_room, step.booking_id)] = dates

    slot_ids = source_slot_ids | destination_slot_ids
    if slot_ids:
        slot_rows = await db.execute(select(Slot).where(Slot.id.in_(slot_ids)).with_for_update())
        slots_by_id = {slot.id: slot for slot in slot_rows.scalars().all()}
    else:
        slots_by_id = {}

    for step in body.swap_plan:
        for d in parsed_dates[(step.from_room, step.to_room, step.booking_id)]:
            source_id = f"{step.from_room}_{d}"
            source_slot = slots_by_id.get(source_id)
            if not source_slot or source_slot.booking_id != step.booking_id:
                raise HTTPException(status_code=409, detail=f"Swap plan is stale at {source_id}")

            target_id = f"{step.to_room}_{d}"
            target_slot = slots_by_id.get(target_id)
            if target_slot and target_slot.block_type != BlockType.EMPTY and target_id not in source_slot_ids:
                raise HTTPException(status_code=409, detail=f"Target slot {target_id} is no longer empty")

    room_ids = {step.from_room for step in body.swap_plan} | {step.to_room for step in body.swap_plan}
    room_rows = await db.execute(select(Room.id, Room.base_rate).where(Room.id.in_(room_ids))) if room_ids else None
    room_rates = {rid: rate for rid, rate in room_rows.all()} if room_rows else {}

    # PASS 1: VACATE all source slots — capture channel/partner before clearing
    booking_channel: dict[str, tuple] = {}
    booking_rates: dict[tuple[str, date], float] = {}
    for step in body.swap_plan:
        for d in parsed_dates[(step.from_room, step.to_room, step.booking_id)]:
            source_slot = slots_by_id[f"{step.from_room}_{d}"]
            if step.booking_id not in booking_channel:
                booking_channel[step.booking_id] = (source_slot.channel, source_slot.channel_partner)
            booking_rates[(step.booking_id, d)] = source_slot.current_rate
            source_slot.block_type      = BlockType.EMPTY
            source_slot.booking_id      = None
            source_slot.channel_partner = None
            source_slot.current_rate    = room_rates.get(step.from_room, source_slot.current_rate)
            slots_updated += 1

    # PASS 2: FILL all destination slots, restoring original channel attribution
    for step in body.swap_plan:
        orig_channel, orig_partner = booking_channel.get(step.booking_id, (Channel.DIRECT, None))

        for d in parsed_dates[(step.from_room, step.to_room, step.booking_id)]:
            to_slot_id = f"{step.to_room}_{d}"
            to_slot = slots_by_id.get(to_slot_id)

            if to_slot:
                to_slot.block_type      = BlockType.SOFT
                to_slot.booking_id      = step.booking_id
                to_slot.channel         = orig_channel
                to_slot.channel_partner = orig_partner
                to_slot.current_rate    = booking_rates.get((step.booking_id, d), to_slot.current_rate)
                slots_updated += 1
            else:
                db.add(Slot(
                    id=to_slot_id,
                    room_id=step.to_room,
                    date=d,
                    block_type=BlockType.SOFT,
                    booking_id=step.booking_id,
                    current_rate=booking_rates.get((step.booking_id, d), room_rates.get(step.to_room, 0.0)),
                    channel=orig_channel,
                    channel_partner=orig_partner,
                ))
                slots_updated += 1

        # Update Booking model to stay in sync
        bk_r = await db.execute(select(Booking).where(Booking.id == step.booking_id))
        bk = bk_r.scalar_one_or_none()
        if bk:
            bk.assigned_room_id = step.to_room

        applied += 1

    await db.commit()
    logger.info("Commit plan: %d steps applied, %d slot rows updated", applied, slots_updated)
    return CommitResult(applied=applied, slots_updated=slots_updated)


# ── Booking source → channel enum mapping ─────────────────────────────────────

def _resolve_channel(booking_source: str) -> tuple[Channel, Optional[str]]:
    """
    Map a single 'booking source' label to (Channel enum, partner Optional[name]).
    Business rule: channel allocation only pushes inventory to OTA partners.
    Anything not explicitly allocated to an OTA remains direct hotel/front-desk inventory.
    Partner lists come from core.channel_config — single source of truth.
    """
    if booking_source in OTA_PARTNER_NAMES:
        return Channel.OTA, booking_source

    return Channel.DIRECT, None


async def channel_allocate(body: ChannelAllocateRequest, db: AsyncSession) -> ChannelAllocateResult:
    """
    Pre-allocate inventory to a booking source for a date range.

    For each night in [check_in, check_out) we find up to `room_count` EMPTY
    rooms of the requested category and create a SOFT-blocked placeholder booking
    tagged with the correct channel + partner. The manager can later hand these
    to the OTA allotment or assign real guest names via receptionist.
    """
    cat = body.category

    ch, partner = _resolve_channel(body.booking_source)
    if ch != Channel.OTA or not partner:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=400,
            detail="Channel allocation only supports configured US/global OTA partners. Unallocated inventory remains Direct Hotel Front Desk.",
        )

    check_in = body.check_in
    check_out = body.check_out
    if check_out <= check_in:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="check_out must be after check_in")

    # Fetch all active rooms of requested category
    rooms_res = await db.execute(
        select(Room).where(Room.category == cat, Room.is_active == True)
    )
    rooms = rooms_res.scalars().all()
    if not rooms:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"No active rooms for category {body.category}")

    # Lock existing slots in the window to avoid double-allocation races.
    slots_res = await db.execute(
        select(Slot).where(
            Slot.room_id.in_([r.id for r in rooms]),
            Slot.date >= check_in,
            Slot.date < check_out,
        ).with_for_update()
    )
    slots_by_id = {s.id: s for s in slots_res.scalars().all()}
    occupied: set[str] = {s.id for s in slots_by_id.values() if s.block_type != BlockType.EMPTY}

    booking_ids: list[str] = []
    allocated_rooms: set[str] = set()
    total_slots = 0

    # Create one booking per requested room (up to room_count)
    rooms_needed = min(body.room_count, len(rooms))
    nights = list(_iter_nights(check_in, check_out))

    for room in rooms:
        if len(booking_ids) >= rooms_needed:
            break

        # Check if this room is free every night in the range
        if any(f"{room.id}_{n}" in occupied for n in nights):
            continue

        bid = str(uuid.uuid4())[:8].upper()
        label = partner or "Direct Hotel Front Desk"
        from datetime import datetime as _dt
        booking = Booking(
            id=bid,
            guest_name=f"[{label}] Allotment",
            room_category=cat,
            assigned_room_id=room.id,
            check_in=check_in,
            check_out=check_out,
            is_live=False,
            created_at=_dt.utcnow(),
        )
        db.add(booking)
        await db.flush()

        for night in nights:
            slot_id = f"{room.id}_{night}"
            slot = slots_by_id.get(slot_id)
            if slot:
                slot.block_type = BlockType.SOFT
                slot.booking_id = bid
                slot.channel = ch
                slot.channel_partner = partner
                if not slot.current_rate:
                    slot.current_rate = room.base_rate
            else:
                db.add(Slot(
                    id=slot_id,
                    room_id=room.id,
                    date=night,
                    block_type=BlockType.SOFT,
                    booking_id=bid,
                    current_rate=room.base_rate,
                    channel=ch,
                    channel_partner=partner,
                ))
            total_slots += 1

        booking_ids.append(bid)
        allocated_rooms.add(room.id)

    await db.commit()

    source_label = partner or "Direct Hotel Front Desk"
    if not booking_ids:
        msg = f"No free {body.category.value} rooms found for {body.check_in} → {body.check_out}."
    else:
        msg = (
            f"Allocated {len(booking_ids)} {body.category.value} room(s) to {source_label} "
            f"for {body.check_in} → {body.check_out} ({len(nights)} nights, {total_slots} slots)."
        )

    return ChannelAllocateResult(
        allocated=total_slots,
        rooms=list(allocated_rooms),
        booking_ids=booking_ids,
        message=msg,
    )


def _iter_nights(start: date, end: date):
    cur = start
    while cur < end:
        yield cur
        cur += timedelta(days=1)


def _channel_news_context_lines(today: date) -> list[str]:
    """
    Mock OTA news and campaign context for the Channel Strategy agent.
    Occupancy, inventory, booking history, and channel performance are not mocked.
    """
    from services.ai.channel_news import get_partner_news

    lines = [
        f"Channel intelligence context as of {today.isoformat()}:",
        "",
        "Mock OTA news and campaign feed:",
    ]
    for partner in OTA_PARTNER_NAMES_LIST:
        news = get_partner_news(partner, today=today)
        active = news.get("recent_events") or []
        if active:
            event_bits = []
            for event in active:
                event_bits.append(
                    f"{event.get('start_date')}..{event.get('end_date')} | {event.get('headline')}"
                )
            lines.append(
                f"  {partner} | signal={news.get('signal')} | {'; '.join(event_bits)} | {news.get('signal_reason')}"
            )
        else:
            lines.append(f"  {partner} | signal=NEUTRAL | no active OTA campaign or partner-health issue today.")
    return lines


def _confidence_rank(confidence: str | None) -> int:
    if confidence == "HIGH":
        return 90
    if confidence == "MEDIUM":
        return 70
    if confidence == "LOW":
        return 50
    return 35


def _normalise_partner_insights(raw: dict, recs: list[ChannelRecommendation], today: date) -> list[ChannelPartnerInsight]:
    valid_preferences = {"PREFER", "WATCH", "HOLD", "AVOID"}
    valid_health = {"GREEN", "AMBER", "RED"}
    valid_confidence = {"HIGH", "MEDIUM", "LOW"}
    insights: list[ChannelPartnerInsight] = []
    seen: set[str] = set()

    for item in raw.get("partner_insights", []) or []:
        if not isinstance(item, dict):
            continue
        partner = str(item.get("partner", "")).strip()
        if partner not in OTA_PARTNER_NAMES or partner in seen:
            continue
        preference = str(item.get("preference", "HOLD")).strip().upper()
        health = str(item.get("health", "GREEN")).strip().upper()
        confidence = str(item.get("confidence", "LOW")).strip().upper()
        if preference not in valid_preferences:
            preference = "HOLD"
        if health not in valid_health:
            health = "GREEN"
        if confidence not in valid_confidence:
            confidence = "LOW"
        try:
            score = float(item.get("score", _confidence_rank(confidence)))
        except (TypeError, ValueError):
            score = float(_confidence_rank(confidence))
        category = item.get("category")
        insights.append(ChannelPartnerInsight(
            partner=partner,
            preference=preference,
            health=health,
            confidence=confidence,
            score=score,
            reasoning=str(item.get("reasoning", "YieldIQ did not provide partner-specific reasoning.")).strip(),
            category=str(category).upper() if category else None,
            check_in=item.get("check_in") or None,
            check_out=item.get("check_out") or None,
            room_count=item.get("room_count") or None,
            expected_net=item.get("expected_net") or None,
        ))
        seen.add(partner)

    best_by_partner: dict[str, ChannelRecommendation] = {}
    for rec in recs:
        prev = best_by_partner.get(rec.booking_source)
        prev_score = _confidence_rank(prev.confidence) + (prev.expected_net or 0) / 10000 if prev else -1
        next_score = _confidence_rank(rec.confidence) + (rec.expected_net or 0) / 10000
        if prev is None or next_score > prev_score:
            best_by_partner[rec.booking_source] = rec

    expedia_downtime_active = date(2026, 5, 8) <= today < date(2026, 5, 9)
    hotels_watch_active = date(2026, 5, 8) <= today < date(2026, 5, 9)

    for partner in OTA_PARTNER_NAMES_LIST:
        if partner in seen:
            continue
        rec = best_by_partner.get(partner)
        if rec:
            preference = "PREFER" if rec.confidence == "HIGH" else "WATCH" if rec.confidence == "MEDIUM" else "HOLD"
            insights.append(ChannelPartnerInsight(
                partner=partner,
                preference=preference,
                health="GREEN",
                confidence=rec.confidence,
                score=_confidence_rank(rec.confidence) + (rec.expected_net or 0) / 10000,
                reasoning=rec.reasoning,
                category=rec.category,
                check_in=rec.check_in,
                check_out=rec.check_out,
                room_count=rec.room_count,
                expected_net=rec.expected_net,
            ))
        elif partner == "Expedia" and expedia_downtime_active:
            insights.append(ChannelPartnerInsight(
                partner=partner,
                preference="AVOID",
                health="RED",
                confidence="HIGH",
                score=0,
                reasoning="OTA news feed shows Expedia API downtime on May 8-9; avoid incremental slot pushes until connectivity clears.",
            ))
        elif partner == "Hotels.com" and hotels_watch_active:
            insights.append(ChannelPartnerInsight(
                partner=partner,
                preference="WATCH",
                health="AMBER",
                confidence="MEDIUM",
                score=55,
                reasoning="Hotels.com loyalty campaign is active, but shared Expedia Group connectivity keeps it on watch during the downtime window.",
            ))
        else:
            insights.append(ChannelPartnerInsight(
                partner=partner,
                preference="HOLD",
                health="GREEN",
                confidence="LOW",
                score=35,
                reasoning="YieldIQ found no stronger date/category fit for this partner from current gaps, booking history, and OTA news.",
            ))

    return insights


async def get_channel_recommendations() -> ChannelRecommendResponse:
    """
    Build occupancy context snapshot and invoke the AI channel agent.
    Returns AI-generated channel allocation recommendations.
    """
    today = date.today()
    look_end = today + timedelta(days=14)

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(Room.category, Slot.date, Slot.block_type)
            .join(Room, Room.id == Slot.room_id)
            .where(
                Room.is_active == True,
                Slot.date >= today,
                Slot.date < look_end,
            )
            .order_by(Slot.date)
        )).all()
    # session closed — AI agent runs below without holding a connection

    # Build per-category daily occupancy summary
    from collections import defaultdict
    cat_date: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"total": 0, "occupied": 0}))
    for cat, d, block_type in rows:
        ds = d.isoformat()
        cat_date[cat.value][ds]["total"] += 1
        if block_type != BlockType.EMPTY:
            cat_date[cat.value][ds]["occupied"] += 1

    lines = []
    for cat, dates in sorted(cat_date.items()):
        lines.append(f"\n{cat}:")
        for ds in sorted(dates.keys()):
            info = dates[ds]
            occ_pct = round(info["occupied"] / info["total"] * 100) if info["total"] else 0
            empty = info["total"] - info["occupied"]
            dow = date.fromisoformat(ds).strftime("%a")
            lines.append(f"  {ds} ({dow}): {occ_pct}% occ, {empty}/{info['total']} empty")

    inventory_text = "\n".join(lines) if lines else "No inventory data available."
    context_text = "\n".join([
        *_channel_news_context_lines(today),
        "",
        "Current inventory snapshot (next 14 days):",
        inventory_text,
    ])

    context_hash = _stable_hash({
        "today": today.isoformat(),
        "context": context_text,
    })
    now = time.time()
    cached = _CHANNEL_RECOMMEND_CACHE.get(context_hash)
    if cached and now - cached[0] <= _CHANNEL_CACHE_TTL_SECONDS:
        payload = copy.deepcopy(cached[1])
        payload["cache_hit"] = True
        return ChannelRecommendResponse(**payload)

    for key, (created_at, _) in list(_CHANNEL_RECOMMEND_CACHE.items()):
        if now - created_at > _CHANNEL_CACHE_TTL_SECONDS:
            _CHANNEL_RECOMMEND_CACHE.pop(key, None)

    raw = await run_channel_agent(context_text, today, AsyncSessionLocal)

    recs = []
    for r in raw.get("recommendations", []):
        booking_source = str(r.get("booking_source", "")).strip()
        channel_type = str(r.get("channel_type", "")).strip().upper()
        if booking_source not in OTA_PARTNER_NAMES or channel_type != "OTA":
            continue
        recs.append(ChannelRecommendation(**{**r, "category": str(r.get("category", "")).upper(), "channel_type": "OTA"}))
    partner_insights = _normalise_partner_insights(raw, recs, today)
    response = ChannelRecommendResponse(
        as_of=today.isoformat(),
        analysis_window_days=14,
        recommendations=recs,
        partner_insights=partner_insights,
        summary=raw.get("summary", ""),
        run_id=uuid.uuid4().hex,
        cache_hit=False,
        context_hash=context_hash,
    )
    _CHANNEL_RECOMMEND_CACHE[context_hash] = (time.time(), response.model_dump())
    return response
