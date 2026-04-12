from __future__ import annotations
from datetime import date
from typing import Optional
from pydantic import BaseModel


class SwapStep(BaseModel):
    from_room: str
    to_room: str
    booking_id: str
    dates: list[str]


class GapInfo(BaseModel):
    room_id: str
    category: str
    date_range: str
    gap_length: int
    shuffle_plan: list[SwapStep]


class OptimiseResult(BaseModel):
    gaps_found: int          # orphan gaps detected in current state
    shuffle_count: int       # total swap steps in the global plan
    converged: bool          # True = gaps exist but structurally unfixable
    fully_clean: bool        # True = zero orphan gaps in current state
    swap_plan: list[SwapStep]
    gaps: list[GapInfo]


class CommitRequest(BaseModel):
    swap_plan: list[SwapStep]


class CommitResult(BaseModel):
    applied: int
    slots_updated: int
