from __future__ import annotations
from typing import Optional

from pydantic import BaseModel, Field


class PricingContextFactor(BaseModel):
    type: str  # WEATHER | EVENT | FLIGHT | MARKET
    label: str
    value: str
    score: float
    weight: float


class PricingContextItem(BaseModel):
    """
    Context feed item passed from the frontend (mock contextFeed.ts).
    This is the ONLY source of mocked external context for pricing analysis.
    """
    id: str
    kind: str  # WEATHER | TRAVEL | EVENT | MARKET
    title: str
    detail: str
    severity: str  # INFO | ALERT
    location: Optional[str] = None
    factors: list[PricingContextFactor] = []


class PricingAnalyseRequest(BaseModel):
    context_items: list[PricingContextItem]
    window_days: int = Field(default=15, ge=1, le=60, description="Align with Overview occupancy slice.")
    empty_nights_only: bool = Field(
        default=True,
        description="LLM synthesis only on dates with unsold rooms for that category (total > OTB).",
    )


class PricingCalendarCell(BaseModel):
    date: str
    current_rate: float
    suggested_rate: float
    change_pct: float
    action: str           # INCREASE | DISCOUNT | MAINTAIN
    confidence: str       # HIGH | MEDIUM | LOW
    reason: str
    occupancy_pct: float
    otb: int
    floor_rate: float
    is_orphan: bool
    weather_factor: str
    event_factor: str
    news_factor: str


class PricingCalendarRow(BaseModel):
    category: str
    cells: list[PricingCalendarCell]


class PricingRecommendation(BaseModel):
    """Flat per-category-per-date record for the pricing review table."""
    category: str
    date: str
    current_rate: float
    suggested_rate: float
    change_pct: float
    action: str
    confidence: str
    reason: str
    occupancy_pct: float
    otb: int


class PricingAnalyseResponse(BaseModel):
    hotel_name: str
    analysis_date: str
    summary: str
    calendar_rows: list[PricingCalendarRow]
    recommendations: list[PricingRecommendation]  # flat list for review table (INCREASE/DISCOUNT only)
    dates: list[str]          # 20-day window ISO date strings
    rescue_potential: float   # $ recoverable if all AI recs committed


class PricingCommitItem(BaseModel):
    category: str
    date: str
    new_rate: float


class PricingCommitRequest(BaseModel):
    items: list[PricingCommitItem]


class PricingCommitResult(BaseModel):
    updated: int
    skipped: int
