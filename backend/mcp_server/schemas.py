from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from core.models.enums import Channel, RoomCategory


class McpSplitSegment(BaseModel):
    """One segment from a split-stay recommendation."""

    room_id: str = Field(min_length=1, max_length=64)
    category: RoomCategory | None = None
    floor: int
    check_in: str = Field(description="ISO date, inclusive.")
    check_out: str = Field(description="ISO date, exclusive.")
    nights: int = Field(ge=1)
    base_rate: float = Field(ge=0)
    discounted_rate: float = Field(ge=0)


class ConfirmationRequired(BaseModel):
    state: Literal["NEEDS_CONFIRMATION"] = "NEEDS_CONFIRMATION"
    message: str


class UnsupportedUntilCoreFix(BaseModel):
    state: Literal["UNSUPPORTED_UNTIL_CORE_FIX"] = "UNSUPPORTED_UNTIL_CORE_FIX"
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class McpWriteResult(BaseModel):
    state: str
    message: str | None = None
    data: dict[str, Any] | None = None


class ToolError(BaseModel):
    error: str
    detail: str | None = None

