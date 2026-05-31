from __future__ import annotations
from typing import Optional
import datetime

from sqlalchemy import String, Integer, Float, Boolean, Date, Enum, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from services.database import Base
from core.models.enums import BlockType, Channel


class Slot(Base):
    __tablename__ = "slots"
    __table_args__ = (
        Index("ix_slots_date", "date"),
        Index("ix_slots_room_id_date", "room_id", "date"),
        Index("ix_slots_booking_id", "booking_id"),
        Index("ix_slots_block_type", "block_type"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)  # e.g. "101_2026-04-09"
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"))
    date: Mapped[datetime.date] = mapped_column(Date)
    block_type: Mapped[BlockType] = mapped_column(Enum(BlockType), default=BlockType.EMPTY)
    booking_id: Mapped[Optional[str]] = mapped_column(ForeignKey("bookings.id"), nullable=True)
    current_rate: Mapped[float] = mapped_column(Float)
    floor_rate: Mapped[float] = mapped_column(Float, default=0.0)
    channel: Mapped[Channel] = mapped_column(Enum(Channel), default=Channel.DIRECT)
    channel_partner: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    min_stay_active: Mapped[bool] = mapped_column(Boolean, default=False)
    min_stay_nights: Mapped[int] = mapped_column(Integer, default=1)
    offer_id: Mapped[Optional[str]] = mapped_column(ForeignKey("offers.id"), nullable=True)

    room: Mapped["Room"] = relationship("Room", back_populates="slots")
    booking: Mapped[Optional["Booking"]] = relationship("Booking", back_populates="slots")
    offer: Mapped[Optional["Offer"]] = relationship("Offer")
