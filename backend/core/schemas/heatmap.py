from __future__ import annotations
from datetime import date
from typing import Optional
from pydantic import BaseModel
from core.models.enums import BlockType, Channel, RoomCategory


class HeatmapCell(BaseModel):
    slot_id: str
    room_id: str
    date: date
    block_type: BlockType
    category: RoomCategory
    current_rate: float
    booking_id: Optional[str] = None
    channel: Optional[Channel] = None
    min_stay_active: bool = False
    min_stay_nights: int = 1
    offer_type: str | None = None


class HeatmapRow(BaseModel):
    room_id: str
    category: RoomCategory
    base_rate: float
    cells: list[HeatmapCell]


class HeatmapResponse(BaseModel):
    dates: list[date]
    rows: list[HeatmapRow]
    summary: dict


