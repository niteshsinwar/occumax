"""Receptionist API routes — T2 booking placement."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import get_db
from core.schemas import BookingRequestIn, ShuffleResult, BookingConfirm, SplitStayResult, SplitStayConfirm
from controllers import receptionist as ctrl

router = APIRouter(prefix="/receptionist", tags=["receptionist"])


@router.post("/check", response_model=ShuffleResult)
async def check_availability(
    request: BookingRequestIn,
    db: AsyncSession = Depends(get_db),
):
    """Check if a booking can be placed and return the placement plan."""
    return await ctrl.check_availability(request, db)


@router.post("/confirm")
async def confirm_booking(
    body: BookingConfirm,
    db: AsyncSession = Depends(get_db),
):
    """Confirm a booking and apply any required room swaps."""
    return await ctrl.confirm_booking(body, db)


@router.post("/find-split", response_model=SplitStayResult)
async def find_split_stay(
    request: BookingRequestIn,
    db: AsyncSession = Depends(get_db),
):
    """Phase 2 — find a multi-segment split stay when single-room allocation failed."""
    return await ctrl.find_split_stay(request, db)


@router.post("/confirm-split")
async def confirm_split_stay(
    body: SplitStayConfirm,
    db: AsyncSession = Depends(get_db),
):
    """Phase 2 — commit a split stay; creates one Booking per segment under a shared stay_group_id."""
    return await ctrl.confirm_split_stay(body, db)


@router.get("/bookings")
async def list_bookings(db: AsyncSession = Depends(get_db)):
    return await ctrl.list_bookings(db)
