from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from core.models import RoomCategory
from core.schemas.manager import SwapStep


class DashboardKNightPreviewRequest(BaseModel):
    """
    Request a scoped, in-memory optimisation preview for k-night bookable windows.

    Scope is limited to the provided date window and room categories; nothing is written to the DB.
    """

    start: date
    end: date
    categories: list[RoomCategory] = Field(default_factory=list)
    target_nights: int = 2


class DashboardKNightPreviewResponse(BaseModel):
    """Scoped optimisation result for k-night preview (no DB write)."""

    target_nights: int
    shuffle_count: int
    swap_plan: list[SwapStep]

