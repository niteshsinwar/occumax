from __future__ import annotations
import datetime

from sqlalchemy import String, Float, Boolean, Date, DateTime, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column

from services.database import Base


class PricingRec(Base):
    """AI-generated pricing recommendation per category+date, refreshed on each analysis run."""

    __tablename__ = "pricing_recs"

    id: Mapped[str] = mapped_column(String, primary_key=True)          # "{CATEGORY}_{YYYY-MM-DD}"
    category: Mapped[str] = mapped_column(String, index=True)
    date: Mapped[datetime.date] = mapped_column(Date, index=True)
    recommended_action: Mapped[str] = mapped_column(String, default="MAINTAIN")  # INCREASE|DISCOUNT|MAINTAIN
    current_rate: Mapped[float] = mapped_column(Float, default=0.0)
    recommended_rate: Mapped[float] = mapped_column(Float, default=0.0)
    change_pct: Mapped[float] = mapped_column(Float, default=0.0)
    confidence: Mapped[str] = mapped_column(String, default="MEDIUM")           # HIGH|MEDIUM|LOW
    reasoning: Mapped[str] = mapped_column(Text, default="")
    weather_factor: Mapped[str] = mapped_column(String, default="")
    event_factor: Mapped[str] = mapped_column(String, default="")
    news_factor: Mapped[str] = mapped_column(String, default="")
    is_orphan: Mapped[bool] = mapped_column(Boolean, default=False)
    occupancy_pct: Mapped[float] = mapped_column(Float, default=0.0)
    otb: Mapped[int] = mapped_column(Integer, default=0)
    floor_rate: Mapped[float] = mapped_column(Float, default=0.0)
    computed_at: Mapped[datetime.datetime] = mapped_column(
        DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow
    )
