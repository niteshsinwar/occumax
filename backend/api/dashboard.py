"""Dashboard API routes — heatmap and summary metrics."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas import HeatmapResponse
from controllers import dashboard as ctrl

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/heatmap", response_model=HeatmapResponse)
async def get_heatmap(db: AsyncSession = Depends(get_db)):
    return await ctrl.get_heatmap(db)
