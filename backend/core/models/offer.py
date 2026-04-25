from __future__ import annotations

import uuid
from datetime import datetime as dt, date
from typing import Optional

from sqlalchemy import String, Float, DateTime, Date, Enum
from sqlalchemy.orm import Mapped, mapped_column

from services.database import Base
from core.models.enums import OfferType, RoomCategory


class Offer(Base):
    __tablename__ = "offers"

    id: Mapped[str] = mapped_column(
        String,
        primary_key=True,
        default=lambda: str(uuid.uuid4())[:12].upper(),
    )

    offer_type: Mapped[OfferType] = mapped_column(Enum(OfferType), nullable=False)
    category: Mapped[Optional[RoomCategory]] = mapped_column(Enum(RoomCategory), nullable=True)
    offer_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    discount_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    original_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    discounted_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    reason: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[dt] = mapped_column(DateTime, nullable=False, default=dt.utcnow)
