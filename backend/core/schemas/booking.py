from datetime import date
from typing import Optional
from pydantic import BaseModel
from core.models.enums import RoomCategory


class BookingRequestIn(BaseModel):
    category: RoomCategory
    check_in: date
    check_out: date
    guest_name: str = "Walk-in Guest"


class ShuffleResult(BaseModel):
    """Result returned by the T2 booking placement engine."""
    state: str  # DIRECT_AVAILABLE | SHUFFLE_POSSIBLE | NOT_POSSIBLE
    room_id: Optional[str] = None
    message: str
    swap_plan: Optional[list[dict]] = None
    comparison: Optional[dict] = None
    infeasible_dates: Optional[list[str]] = None
    alternatives: Optional[list[dict]] = None


class BookingConfirm(BaseModel):
    request: BookingRequestIn
    room_id: str
    swap_plan: Optional[list[dict]] = None


# ── Phase 2: split-stay schemas ───────────────────────────────────────────────

class SplitSegmentOut(BaseModel):
    """One room segment within a split stay."""
    room_id:         str
    floor:           int
    check_in:        date
    check_out:       date
    nights:          int
    base_rate:       float
    discounted_rate: float


class SplitStayResult(BaseModel):
    """Result returned by find_split_stay."""
    state:         str   # SPLIT_POSSIBLE | NOT_POSSIBLE
    segments:      list[SplitSegmentOut] = []
    discount_pct:  float = 0.0
    total_nights:  int   = 0
    total_rate:    float = 0.0
    message:       str   = ""


class SplitStayConfirm(BaseModel):
    """Body sent to POST /receptionist/confirm-split."""
    guest_name:    str
    category:      RoomCategory
    discount_pct:  float
    segments:      list[SplitSegmentOut]
