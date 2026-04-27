from __future__ import annotations

from datetime import date
from typing import Optional
from pydantic import BaseModel, Field


class PricingRecommendation(BaseModel):
    category: str
    date: date
    current_rate: float
    suggested_rate: float
    change_pct: float          # positive = increase, negative = discount
    confidence: str            # "HIGH" | "MEDIUM" | "LOW"
    reason: str
    occupancy_pct: float
    otb: int                   # on-the-books rooms count
    floor_rate: float          # AI cannot suggest below this


class PricingWhatIfScenario(BaseModel):
    """
    One row in a discount ladder: predictive simulation output for the Pricing UI.
    Indices are relative to current BAR / avg_rate context (baseline = 100 where noted).
    """

    discount_pct: float
    demand_lift_pct: float
    net_price_index: float
    revenue_index: float
    rationale: str


class PricingWhatIfAnalysis(BaseModel):
    """
    AI-driven what-if discount ladder (Gemini) with heuristic fallback.
    """

    headline: str
    methodology: str
    scenarios: list[PricingWhatIfScenario]
    recommended_index: int = Field(ge=0, le=4, description="Index into scenarios list (0..4).")


class PricingAnalyseResponse(BaseModel):
    hotel_name: str
    analysis_date: date
    recommendations: list[PricingRecommendation]
    summary: str               # AI narrative summary
    what_if: PricingWhatIfAnalysis | None = None


class PricingCommitItem(BaseModel):
    category: str
    date: date
    new_rate: float            # manager may override the suggested rate


class PricingCommitRequest(BaseModel):
    items: list[PricingCommitItem]


class PricingCommitResult(BaseModel):
    updated: int
    skipped: int               # items below floor_rate or not found
