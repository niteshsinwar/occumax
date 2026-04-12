from __future__ import annotations
from typing import Optional
from pydantic import BaseModel
from core.models.enums import RoomCategory


class RoomOut(BaseModel):
    id: str
    category: RoomCategory
    base_rate: float
    floor_number: int
    is_active: bool

    model_config = {"from_attributes": True}


class RoomCreate(BaseModel):
    id: str
    category: RoomCategory
    base_rate: float
    floor_number: int = 1


class RoomUpdate(BaseModel):
    category: Optional[RoomCategory] = None
    base_rate: Optional[float] = None
    floor_number: Optional[int] = None
    is_active: Optional[bool] = None
