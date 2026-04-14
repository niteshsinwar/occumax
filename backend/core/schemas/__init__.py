"""Re-export all Pydantic schemas from a single import point."""

from core.schemas.room import RoomOut, RoomCreate, RoomUpdate
from core.schemas.heatmap import HeatmapCell, HeatmapRow, HeatmapResponse
from core.schemas.booking import (
    BookingRequestIn, ShuffleResult, BookingConfirm,
    SplitSegmentOut, SplitStayResult, SplitStayConfirm,
)
from core.schemas.manager import SwapStep, GapInfo, OptimiseResult, CommitRequest, CommitResult
from core.schemas.analytics import (
    OccupancyForecastResponse,
    PaceResponse,
    EventInsightsResponse,
)

__all__ = [
    "RoomOut", "RoomCreate", "RoomUpdate",
    "HeatmapCell", "HeatmapRow", "HeatmapResponse",
    "BookingRequestIn", "ShuffleResult", "BookingConfirm",
    "SplitSegmentOut", "SplitStayResult", "SplitStayConfirm",
    "SwapStep", "GapInfo", "OptimiseResult", "CommitRequest", "CommitResult",
    "OccupancyForecastResponse", "PaceResponse", "EventInsightsResponse",
]
