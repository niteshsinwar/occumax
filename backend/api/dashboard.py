"""Dashboard API routes — heatmap and summary metrics."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas import (
    HeatmapResponse,
    SandwichPlaybookRequest,
    SandwichPlaybookResponse,
    DashboardScorecardRequest,
    DashboardScorecardResponse,
    RecoveryEstimateRequest,
    RecoveryEstimateResponse,
)
from core.schemas.dashboard_optimise import DashboardOptimisePreviewRequest, DashboardOptimisePreviewResponse
from core.schemas.dashboard_k_optimise import DashboardKNightPreviewRequest, DashboardKNightPreviewResponse
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


@router.post("/optimise-k-night-preview", response_model=DashboardKNightPreviewResponse)
async def optimise_k_night_preview(body: DashboardKNightPreviewRequest, db: AsyncSession = Depends(get_db)):
    """
    Preview optimiser that maximizes k-night bookable windows across the slice.
    Nothing is written to the DB.
    """
    return await ctrl.optimise_k_night_preview(
        db=db,
        start=body.start,
        end=body.end,
        categories=body.categories,
        target_nights=body.target_nights,
    )


@router.post("/sandwich-playbook", response_model=SandwichPlaybookResponse)
async def sandwich_playbook(body: SandwichPlaybookRequest, db: AsyncSession = Depends(get_db)):
    """
    Relax MinLOS restrictions for true sandwich orphan nights in the given slice.
    Writes changes to DB.
    """
    return await ctrl.apply_sandwich_playbook(
        db=db,
        start=body.start,
        end=body.end,
        categories=body.categories,
        discount_pct=body.discount_pct,
    )


@router.post("/commit-shuffle", response_model=CommitResult)
async def commit_shuffle(body: CommitRequest, db: AsyncSession = Depends(get_db)):
    """
    Commit a swap plan without placing a new booking.

    This is the "Room Tetris" opt-in: apply the reshuffle so the heatmap reflects
    more contiguous empty runs immediately.
    """
    return await ctrl.commit_shuffle(body=body, db=db)


@router.post("/scorecard", response_model=DashboardScorecardResponse)
async def scorecard(body: DashboardScorecardRequest, db: AsyncSession = Depends(get_db)):
    """
    Compute a single KPI object for hackathon "before → after" storytelling.

    If `swap_plan` is provided, computes an in-memory "after" state by applying the plan
    to the slice (no DB writes) and returns deltas.
    """
    return await ctrl.get_scorecard(
        db=db,
        start=body.start,
        end=body.end,
        categories=body.categories,
        k_nights=body.k_nights,
        swap_plan=body.swap_plan,
    )


@router.post("/recovery-estimate", response_model=RecoveryEstimateResponse)
async def recovery_estimate(body: RecoveryEstimateRequest, db: AsyncSession = Depends(get_db)):
    """
    Demo-friendly recovery estimate:
    - deterministic shuffle recovery from swap_plan simulation
    - AI-assisted orphan-night offer discount + estimated incremental recovery
    """
    data = await ctrl.get_recovery_estimate(
        db=db,
        start=body.start,
        end=body.end,
        categories=body.categories,
        swap_plan=body.swap_plan,
    )
    return RecoveryEstimateResponse(**data)
