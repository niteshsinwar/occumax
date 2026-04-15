"""Dashboard API routes — heatmap and summary metrics."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas import HeatmapResponse
from core.schemas.dashboard_optimise import DashboardOptimisePreviewRequest, DashboardOptimisePreviewResponse
from controllers import dashboard as ctrl

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/heatmap", response_model=HeatmapResponse)
async def get_heatmap(db: AsyncSession = Depends(get_db)):
    return await ctrl.get_heatmap(db)


@router.post("/optimise-preview", response_model=DashboardOptimisePreviewResponse)
async def optimise_preview(body: DashboardOptimisePreviewRequest, db: AsyncSession = Depends(get_db)):
    """
    Run a scoped, in-memory optimisation preview for the Bird's Eye Dashboard.

    Nothing is written to the database.
    """
    return await ctrl.optimise_preview(db=db, start=body.start, end=body.end, categories=body.categories)
