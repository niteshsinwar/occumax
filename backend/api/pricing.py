"""
Pricing AI routes — dynamic rate recommendations for manager.

Routes
------
GET  /manager/pricing/analyse  — run AI analysis, return recommendations
POST /manager/pricing/commit   — apply manager-reviewed rate changes to slots
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas.pricing import PricingAnalyseResponse, PricingCommitRequest, PricingCommitResult
from controllers import pricing as ctrl

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/manager/pricing", tags=["pricing"])


@router.get("/analyse", response_model=PricingAnalyseResponse)
async def analyse_pricing():
    """
    Run the pricing AI agent against live occupancy data.

    Reads current slots/bookings, builds an occupancy snapshot, passes it to
    Gemini, and returns a list of PricingRecommendations plus a narrative summary.

    Nothing is written to the database — call POST /commit to apply changes.
    """
    return await ctrl.analyse()


@router.post("/commit", response_model=PricingCommitResult)
async def commit_pricing(body: PricingCommitRequest, db: AsyncSession = Depends(get_db)):
    """
    Apply manager-approved rate changes to the slots table.

    Accepts a list of { category, date, new_rate } items. Each item updates
    current_rate for all active rooms of that category on that date.
    Items where new_rate < floor_rate are silently skipped (floor-rate guard).
    """
    return await ctrl.commit(body, db)
