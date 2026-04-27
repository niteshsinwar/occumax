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
    RevenueSummaryResponse,
    ChannelPerformanceResponse,
)
from core.schemas.dashboard_optimise import (
    DashboardOptimisePreviewRequest,
    DashboardOptimisePreviewResponse,
)
from core.schemas.sandwich_playbook import SandwichPlaybookRequest, SandwichPlaybookResponse
from core.schemas.dashboard_k_optimise import DashboardKNightPreviewRequest, DashboardKNightPreviewResponse
from core.schemas.dashboard_scorecard import (
    DashboardScorecardRequest,
    DashboardScorecardResponse,
)
from core.schemas.recovery_estimate import RecoveryEstimateRequest, RecoveryEstimateResponse

__all__ = [
    "RoomOut", "RoomCreate", "RoomUpdate",
    "HeatmapCell", "HeatmapRow", "HeatmapResponse",
    "BookingRequestIn", "ShuffleResult", "BookingConfirm",
    "SplitSegmentOut", "SplitStayResult", "SplitStayConfirm",
    "SwapStep", "GapInfo", "OptimiseResult", "CommitRequest", "CommitResult",
    "OccupancyForecastResponse", "PaceResponse", "EventInsightsResponse", "RevenueSummaryResponse",
    "ChannelPerformanceResponse",
    "DashboardOptimisePreviewRequest", "DashboardOptimisePreviewResponse",
    "SandwichPlaybookRequest", "SandwichPlaybookResponse",
    "DashboardKNightPreviewRequest", "DashboardKNightPreviewResponse",
    "DashboardScorecardRequest", "DashboardScorecardResponse",
    "RecoveryEstimateRequest", "RecoveryEstimateResponse",
]
