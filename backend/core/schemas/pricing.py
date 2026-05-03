from __future__ import annotations

from pydantic import BaseModel


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


class PricingAnalyseResponse(BaseModel):
    hotel_name: str
    analysis_date: str
    summary: str
    calendar_rows: list[PricingCalendarRow]
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
