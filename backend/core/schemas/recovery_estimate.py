from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from core.models import RoomCategory
from core.schemas.manager import SwapStep


class RecoveryEstimateRequest(BaseModel):
    """
    Estimate recovery impact for a slice:
    - deterministic shuffle impact (via scorecard deltas with optional swap_plan)
    - AI-assisted orphan-night offer strategy (discount suggestion + uplift estimate)
    """

    start: date
    end: date
    categories: list[RoomCategory] = Field(default_factory=list)
    swap_plan: list[SwapStep] | None = None


class RecoveryEstimateResponse(BaseModel):
    start: date
    end: date
    categories: list[RoomCategory]

    # Deterministic (simulation-based) recovery from swap_plan.
    shuffle_recovered: float = Field(ge=0.0, description="Projected recovered revenue from shuffle (USD).")

    # AI-assisted offer strategy
    offer_discount_pct: float = Field(ge=0.05, le=0.80, description="Recommended orphan-night offer discount.")
    offer_fill_prob_before: float = Field(ge=0.0, le=1.0)
    offer_fill_prob_after: float = Field(ge=0.0, le=1.0)
    offer_recovered_estimated: float = Field(ge=0.0, description="Estimated incremental recovered revenue from applying orphan-night offers (USD).")

    total_recovered_projected: float = Field(ge=0.0)
    notes: str | None = None

