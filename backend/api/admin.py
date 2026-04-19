from __future__ import annotations
"""Admin API routes — room management, categories, slot patching."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas import RoomCreate, RoomUpdate
from controllers.admin import SlotPatch, SeedAnalyticsHistoryRequest
from controllers import admin as ctrl
from core.channel_config import OTA_PARTNERS, GDS_PARTNERS, DIRECT_SOURCES

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/rooms")
async def list_rooms(db: AsyncSession = Depends(get_db)):
    return await ctrl.list_rooms(db)


@router.post("/rooms", status_code=201)
async def add_room(body: RoomCreate, db: AsyncSession = Depends(get_db)):
    return await ctrl.add_room(body, db)


@router.patch("/rooms/{room_id}")
async def update_room(
    room_id: str, body: RoomUpdate, db: AsyncSession = Depends(get_db)
):
    return await ctrl.update_room(room_id, body, db)


@router.delete("/rooms/{room_id}")
async def deactivate_room(room_id: str, db: AsyncSession = Depends(get_db)):
    return await ctrl.deactivate_room(room_id, db)


@router.get("/categories")
async def list_categories(db: AsyncSession = Depends(get_db)):
    return await ctrl.list_categories(db)


@router.patch("/slots/{slot_id}")
async def patch_slot(
    slot_id: str, body: SlotPatch, db: AsyncSession = Depends(get_db)
):
    return await ctrl.patch_slot(slot_id, body, db)


@router.post("/seed-analytics-history")
async def seed_analytics_history(body: SeedAnalyticsHistoryRequest, db: AsyncSession = Depends(get_db)):
    return await ctrl.seed_analytics_history(db=db, body=body)


@router.get("/channel-partners")
async def list_channel_partners():
    """
    Return all supported booking channel partners with their commission rates.
    Frontend uses this instead of hardcoding partner names.
    """
    return {
        "ota": OTA_PARTNERS,
        "gds": GDS_PARTNERS,
        "direct": DIRECT_SOURCES,
    }
