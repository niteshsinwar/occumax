from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from core.models import RoomCategory
from core.schemas.manager import SwapStep


class DashboardScorecardRequest(BaseModel):
    """
    Request a capacity-recovery scorecard for a calendar slice.

    If `swap_plan` is provided, the response also includes an in-memory "after" scorecard
    computed by applying the plan to the slice (no DB writes).
    """

    start: date
    end: date
    categories: list[RoomCategory] = Field(default_factory=list)
    k_nights: list[int] = Field(default_factory=lambda: [2, 3])
    swap_plan: list[SwapStep] | None = None


class CapacityScore(BaseModel):
    """
    Compact business-facing metrics for the demo storyline.

    - orphan_nights: stranded (unusable) gaps bounded by bookings on both sides
    - revenue_at_risk: expected lost revenue estimate tied to orphan gaps
    - k_windows: total number of k-night bookable windows across the slice (k→count)
    """

    orphan_nights: int
    revenue_at_risk: float
    k_windows: dict[int, int]


class CapacityDelta(BaseModel):
    orphan_nights: int
    revenue_at_risk: float
    k_windows: dict[int, int]


class DashboardScorecardResponse(BaseModel):
    start: date
    end: date
    categories: list[RoomCategory]
    k_nights: list[int]
    before: CapacityScore
    after: CapacityScore | None = None
    delta: CapacityDelta | None = None

