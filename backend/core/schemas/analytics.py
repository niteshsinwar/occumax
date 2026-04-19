from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel

from core.models.enums import RoomCategory


class OccupancyPoint(BaseModel):
    date: date
    total_rooms: int
    occupied_rooms_actual: Optional[int] = None
    # Calendar holds: nights with block SOFT or HARD (same as heatmap / non-EMPTY slots).
    occupied_rooms_on_books: Optional[int] = None

    expected_occ_pct: float
    expected_occ_low_pct: float
    expected_occ_high_pct: float

    # Pickup-based prediction of FINAL occupancy for this date (as of `as_of`), derived
    # from same-lead pickup ratios on the same calendar dates in prior years.
    predicted_final_occ_pct: Optional[float] = None
    # Band endpoints are normalized so low ≤ high (room-level inversion is unfolded in the API).
    predicted_final_occ_low_pct: Optional[float] = None
    predicted_final_occ_high_pct: Optional[float] = None
    # Heuristic agreement score (55/70/85), not a calibrated probability.
    predicted_final_likelihood_pct: Optional[float] = None


class OccupancySeries(BaseModel):
    category: Optional[RoomCategory] = None  # None => hotel-wide rollup
    points: list[OccupancyPoint]


class OccupancyForecastResponse(BaseModel):
    start: date
    end: date
    as_of: date
    series: list[OccupancySeries]


class PacePoint(BaseModel):
    lead_days: int
    on_books_rooms: int
    on_books_occ_pct: float
    expected_on_books_rooms: float
    expected_on_books_occ_pct: float


class PaceSeries(BaseModel):
    category: Optional[RoomCategory] = None  # None => hotel-wide rollup
    stay_start: date
    stay_end: date
    points: list[PacePoint]


class PaceResponse(BaseModel):
    as_of: date
    series: list[PaceSeries]


class RevenueSummaryResponse(BaseModel):
    as_of: date
    # Today
    today_occupancy_pct: float
    today_adr: float
    today_rooms_occupied: int
    today_total_rooms: int
    # This week (next 7 nights)
    week_occupancy_pct: float
    week_revenue_on_books: float
    week_rooms_booked: int
    week_total_room_nights: int
    # Gap risk
    orphan_nights_at_risk: int
    orphan_revenue_at_risk: float
    # MTD
    mtd_revenue: float
    mtd_days: int


class PartnerStat(BaseModel):
    partner: str
    room_nights: int
    gross_revenue: float
    net_revenue: float
    avg_rate: float
    share_of_channel_pct: float


class ChannelStat(BaseModel):
    channel: str
    room_nights: int
    gross_revenue: float
    commission_pct: float
    net_revenue: float
    avg_rate: float
    share_pct: float  # % of total occupied room nights
    partners: list[PartnerStat] = []


class ChannelPerformanceResponse(BaseModel):
    as_of: date
    window_start: date
    window_end: date
    channels: list[ChannelStat]
    total_gross_revenue: float
    total_net_revenue: float
    total_room_nights: int
    recommendation: str


class ChannelRecommendation(BaseModel):
    booking_source: str        # "MakeMyTrip" | "Direct" | etc.
    channel_type: str          # OTA | GDS | DIRECT | WALKIN
    category: str
    check_in: str              # ISO date
    check_out: str             # ISO date
    room_count: int
    expected_gross: float
    commission_cost: float
    expected_net: float
    confidence: str            # HIGH | MEDIUM | LOW
    reasoning: str             # human-readable explanation


class ChannelRecommendResponse(BaseModel):
    as_of: str
    analysis_window_days: int
    recommendations: list[ChannelRecommendation]
    summary: str


class LosBucket(BaseModel):
    nights: int
    count: int


class EventInsightsResponse(BaseModel):
    start: date
    end: date
    as_of: date
    category: Optional[RoomCategory] = None

    most_common_los_nights: Optional[int] = None
    los_histogram: list[LosBucket]

    most_common_arrival_weekday: Optional[int] = None  # 0=Mon..6=Sun
    arrival_weekday_histogram: list[int]               # length 7
