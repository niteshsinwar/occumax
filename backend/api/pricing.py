"""
Pricing AI routes — dynamic rate recommendations for manager.

Routes
------
GET  /manager/pricing/analyse  — run multi-call AI analysis, return 20-day calendar
POST /manager/pricing/commit   — apply manager-reviewed rate changes to slots
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas.pricing import (
    PricingAnalyseRequest,
    PricingAnalyseResponse,
    PricingCommitRequest,
    PricingCommitResult,
)
from controllers import pricing as ctrl

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/manager/pricing", tags=["pricing"])


@router.get("/analyse", response_model=PricingAnalyseResponse)
async def analyse_pricing():
    """
    Run the multi-call AI pricing analysis against live occupancy data.

    Makes 4 parallel LLM calls (weather, events, market, historical) then a
    synthesis call to produce a 20-day pricing calendar per room category.
    Results are persisted to the pricing_recs table.
    Nothing is written to slots — call POST /commit to apply changes.
    """
    return await ctrl.analyse()


@router.post("/analyse-context", response_model=PricingAnalyseResponse)
async def analyse_pricing_with_context(body: PricingAnalyseRequest):
    """
    Run pricing analysis using ONLY the provided context feed bundle (frontend mock contextFeed.ts).
    This avoids backend-side mock external events/news/weather.
    """
    return await ctrl.analyse_with_context(body)


@router.post("/commit", response_model=PricingCommitResult)
async def commit_pricing(body: PricingCommitRequest, db: AsyncSession = Depends(get_db)):
    """
    Apply manager-approved rate changes to the slots table.

    Accepts a list of { category, date, new_rate } items. Each item updates
    current_rate for all active rooms of that category on that date.
    Items where new_rate < floor_rate are silently skipped (floor-rate guard).
    """
    return await ctrl.commit(body, db)
