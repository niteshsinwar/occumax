from datetime import date
from typing import Optional
from pydantic import BaseModel, Field, model_validator
from core.models.enums import Channel, RoomCategory
from core.schemas.manager import SwapStep


class BookingRequestIn(BaseModel):
    category: RoomCategory
    check_in: date
    check_out: date
    guest_name: str = Field(default="Direct Guest", min_length=1, max_length=120)
    channel: Optional[Channel] = Channel.DIRECT
    channel_partner: Optional[str] = None    # Expedia, Hotels.com, Booking.com, Priceline, etc.

    @model_validator(mode="after")
    def _valid_stay_window(self):
        if self.check_out <= self.check_in:
            raise ValueError("check_out must be after check_in")
        return self


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
    room_id: str = Field(min_length=1, max_length=64)
    swap_plan: Optional[list[SwapStep]] = None


# ── Phase 2: split-stay schemas ───────────────────────────────────────────────

class SplitSegmentOut(BaseModel):
    """One room segment within a split stay."""
    room_id:         str
    category:        Optional[RoomCategory] = None
    floor:           int
    check_in:        date
    check_out:       date
    nights:          int
    base_rate:       float
    discounted_rate: float


class SplitStayResult(BaseModel):
    """Result returned by find_split_stay."""
    state:         str   # SPLIT_POSSIBLE | NOT_POSSIBLE
    segments:      list[SplitSegmentOut] = Field(default_factory=list)
    discount_pct:  float = 0.0
    total_nights:  int   = 0
    total_rate:    float = 0.0
    message:       str   = ""


class SplitStayConfirm(BaseModel):
    """Body sent to POST /receptionist/confirm-split."""
    guest_name:      str = Field(min_length=1, max_length=120)
    category:        RoomCategory
    discount_pct:    float = Field(ge=0, le=100)
    segments:        list[SplitSegmentOut] = Field(min_length=1)
    channel:         Optional[Channel] = Channel.DIRECT
    channel_partner: Optional[str] = None
