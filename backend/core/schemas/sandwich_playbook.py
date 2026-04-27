from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from core.models import RoomCategory


class SandwichPlaybookRequest(BaseModel):
    """
    Relax MinLOS restrictions for true "sandwich" orphan nights (single EMPTY nights
    bounded by booked/blocked nights on both sides in the same room).
    """

    start: date
    end: date
    categories: list[RoomCategory] = Field(default_factory=list)
    discount_pct: float | None = Field(
        default=None,
        ge=0.05,
        le=0.80,
        description="Optional override for the orphan-night offer discount percentage (0.05–0.80).",
    )


class SandwichPlaybookResponse(BaseModel):
    """
    Result of applying the sandwich-night MinLOS relaxation playbook.
    """

    start: date
    end: date
    categories: list[RoomCategory]
    orphan_slots_found: int
    slots_updated: int
