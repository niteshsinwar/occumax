from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from core.models import RoomCategory
from core.schemas.manager import SwapStep


class DashboardOptimisePreviewRequest(BaseModel):
    """
    Request a scoped, in-memory optimisation preview for the Bird's Eye Dashboard.

    Scope is limited to the provided date window and room categories; nothing is written to the DB.
    """

    start: date
    end: date
    categories: list[RoomCategory] = Field(default_factory=list)


class DashboardOptimisePreviewResponse(BaseModel):
    """Scoped optimisation result for Dashboard preview (no DB write)."""

    gaps_found: int
    shuffle_count: int
    converged: bool
    fully_clean: bool
    swap_plan: list[SwapStep]

