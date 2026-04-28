"""Manager API routes — stateless T1 calendar optimisation."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas.manager import OptimiseResult, CommitRequest, CommitResult, ChannelAllocateRequest, ChannelAllocateResult
from core.schemas.analytics import ChannelRecommendResponse
from controllers import manager as ctrl

router = APIRouter(prefix="/manager", tags=["manager"])


@router.post("/optimise", response_model=OptimiseResult)
async def trigger_optimisation(db: AsyncSession = Depends(get_db)):
    """
    Run T1 calendar optimisation synchronously.

    Returns the full swap plan and gap list in the response body.
    Nothing is written to the database — call /manager/commit to apply.
    """
    return await ctrl.run_optimisation(db)


@router.post("/commit", response_model=CommitResult)
async def commit_plan(body: CommitRequest, db: AsyncSession = Depends(get_db)):
    """
    Apply a swap plan returned by /manager/optimise to the slots table.

    Atomically moves bookings between rooms as specified. Safe to call
    only once per plan — re-applying an already-committed plan is a no-op
    because source slots will already be EMPTY.
    """
    return await ctrl.commit_plan(body, db)


@router.post("/channel-allocate", response_model=ChannelAllocateResult)
async def channel_allocate(body: ChannelAllocateRequest, db: AsyncSession = Depends(get_db)):
    """
    Pre-allocate inventory to a booking source (OTA partner or Direct) for a date range.
    Creates placeholder SOFT-blocked bookings tagged with the correct channel attribution.
    """
    return await ctrl.channel_allocate(body, db)


@router.get("/channel-recommend", response_model=ChannelRecommendResponse)
async def channel_recommend():
    """
    Run the Gemini channel allocation AI agent.
    Analyses 14-day occupancy gaps and historical partner performance to return
    ranked recommendations for which OTA/GDS partners should receive inventory.
    """
    return await ctrl.get_channel_recommendations()
