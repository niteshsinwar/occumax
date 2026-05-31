"""Request / response for Poly AI–backed optimal length-of-stay prediction (Occupancy tab)."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from core.models import RoomCategory


class PredictOptimalLosRequest(BaseModel):
    """Hotel slice used for context + optimisation alignment."""

    start: date
    end: date
    categories: list[RoomCategory] = Field(default_factory=list)


class PredictOptimalLosResponse(BaseModel):
    """AI recommendation for demand-aligned average length of stay (integer nights)."""

    recommended_los_nights: int = Field(ge=2, le=7)
    confidence: str = "MEDIUM"
    rationale: str = ""
