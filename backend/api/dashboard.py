"""Dashboard API routes — heatmap and summary metrics."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas import HeatmapResponse, SandwichPlaybookRequest, SandwichPlaybookResponse
from core.schemas.dashboard_optimise import DashboardOptimisePreviewRequest, DashboardOptimisePreviewResponse
from core.schemas.manager import CommitRequest, CommitResult
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


@router.post("/sandwich-playbook", response_model=SandwichPlaybookResponse)
async def sandwich_playbook(body: SandwichPlaybookRequest, db: AsyncSession = Depends(get_db)):
    """
    Relax MinLOS restrictions for true sandwich orphan nights in the given slice.
    Writes changes to DB.
    """
    return await ctrl.apply_sandwich_playbook(db=db, start=body.start, end=body.end, categories=body.categories)


@router.post("/commit-shuffle", response_model=CommitResult)
async def commit_shuffle(body: CommitRequest, db: AsyncSession = Depends(get_db)):
    """
    Commit a swap plan without placing a new booking.

    This is the "Room Tetris" opt-in: apply the reshuffle so the heatmap reflects
    more contiguous empty runs immediately.
    """
    return await ctrl.commit_shuffle(body=body, db=db)
