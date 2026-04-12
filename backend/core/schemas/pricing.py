from __future__ import annotations

from datetime import date
from typing import Optional
from pydantic import BaseModel


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


class PricingAnalyseResponse(BaseModel):
    hotel_name: str
    analysis_date: date
    recommendations: list[PricingRecommendation]
    summary: str               # AI narrative summary


class PricingCommitItem(BaseModel):
    category: str
    date: date
    new_rate: float            # manager may override the suggested rate


class PricingCommitRequest(BaseModel):
    items: list[PricingCommitItem]


class PricingCommitResult(BaseModel):
    updated: int
    skipped: int               # items below floor_rate or not found
