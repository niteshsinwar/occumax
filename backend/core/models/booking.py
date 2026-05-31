from __future__ import annotations
from typing import Optional
import uuid
import datetime
from datetime import datetime as dt

from sqlalchemy import String, Integer, Float, Boolean, Date, DateTime, Enum, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from services.database import Base
from core.models.enums import RoomCategory


class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = (
        Index("ix_bookings_created_at", "created_at"),
        Index("ix_bookings_check_in_check_out", "check_in", "check_out"),
        Index("ix_bookings_room_category", "room_category"),
    )

    id: Mapped[str] = mapped_column(
        String, primary_key=True,
        default=lambda: str(uuid.uuid4())[:8].upper()
    )
    guest_name: Mapped[str] = mapped_column(String)
    guest_id: Mapped[str] = mapped_column(
        String,
        default=lambda: str(uuid.uuid4())[:8].upper()
    )
    room_category: Mapped[RoomCategory] = mapped_column(Enum(RoomCategory))
    assigned_room_id: Mapped[Optional[str]] = mapped_column(ForeignKey("rooms.id"), nullable=True)
    check_in: Mapped[datetime.date] = mapped_column(Date)
    check_out: Mapped[datetime.date] = mapped_column(Date)
    is_live: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt] = mapped_column(DateTime, default=dt.utcnow)

    # Phase 2 — split-stay fields (NULL for single-room bookings)
    stay_group_id:  Mapped[Optional[str]]   = mapped_column(String,  nullable=True,  default=None)
    segment_index:  Mapped[Optional[int]]   = mapped_column(Integer, nullable=True,  default=None)
    discount_pct:   Mapped[float]           = mapped_column(Float,   nullable=False, default=0.0)

    slots: Mapped[list["Slot"]] = relationship("Slot", back_populates="booking")
