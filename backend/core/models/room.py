from __future__ import annotations
from sqlalchemy import String, Integer, Float, Boolean, Enum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from services.database import Base
from core.models.enums import RoomCategory


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # e.g. "101"
    category: Mapped[RoomCategory] = mapped_column(Enum(RoomCategory))
    base_rate: Mapped[float] = mapped_column(Float)
    floor_number: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str | None] = mapped_column(String, nullable=True)  # new column test

    slots: Mapped[list["Slot"]] = relationship("Slot", back_populates="room")
