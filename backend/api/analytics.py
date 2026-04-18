"""Analytics API routes — occupancy forecast, pace, and event insights.

Additive-only endpoints used by the Bird's Eye Dashboard (`/dashboard`).
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from core.schemas import OccupancyForecastResponse, PaceResponse, EventInsightsResponse, RevenueSummaryResponse
from services.database import get_db
from controllers import analytics as ctrl

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/occupancy-forecast", response_model=OccupancyForecastResponse)
async def get_occupancy_forecast(
    start: date = Query(...),
    end: date = Query(...),
    as_of: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    return await ctrl.get_occupancy_forecast(db=db, start=start, end=end, as_of=as_of)


@router.get("/pace", response_model=PaceResponse)
async def get_pace(
    start: date = Query(...),
    end: date = Query(...),
    as_of: date = Query(...),
    max_lead_days: int = Query(60, ge=0, le=365),
    db: AsyncSession = Depends(get_db),
):
    return await ctrl.get_pace(db=db, start=start, end=end, as_of=as_of, max_lead_days=max_lead_days)


@router.get("/event-insights", response_model=EventInsightsResponse)
async def get_event_insights(
    start: date = Query(...),
    end: date = Query(...),
    as_of: date = Query(...),
    category: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await ctrl.get_event_insights(db=db, start=start, end=end, as_of=as_of, category=category)


@router.get("/revenue-summary", response_model=RevenueSummaryResponse)
async def get_revenue_summary(
    as_of: date | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    from datetime import date as date_type
    effective_as_of = as_of or date_type.today()
    return await ctrl.get_revenue_summary(db=db, as_of=effective_as_of)
