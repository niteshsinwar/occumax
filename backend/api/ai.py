"""
AI routes — Receptionist conversational agent (LangGraph + Gemini).

Routes
------
POST /ai/chat     — run one agent turn; frontend sends full history
GET  /ai/context  — returns live hotel state for the frontend to embed
                    in the first message so the AI always has current context
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.models import Room, Slot
from core.models.enums import BlockType
from services.database import get_db
from services.ai.receptionist_agent import run_agent

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ai", tags=["ai"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str       # "user" | "assistant"
    content: str

class AIChatRequest(BaseModel):
    messages: list[ChatMessage]
    hotel_context: Optional[str] = None     # pre-fetched from GET /ai/context


class AIChatResponse(BaseModel):
    reply: str
    action_data: Optional[dict] = None     # structured payload for frontend cards


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _build_hotel_context(db: AsyncSession) -> str:
    """
    Tier-1 context: one line per category injected into the system prompt.
    Carries enough for the AI to answer price/floor/occupancy questions
    without a tool call. Per-room detail is fetched on-demand via the
    get_room_inventory tool.

    Format per line:
      CATEGORY  total=N  free=F  soft=S  hard=H  |  $min–max/night  |  floors F1–F2
    """
    today = date.today()
    window_end = today + timedelta(days=settings.SCAN_WINDOW_DAYS)

    # ── one query: all active rooms with floor + rate ──────────────────────────
    rooms_result = await db.execute(
        select(Room.id, Room.category, Room.base_rate, Room.floor_number)
        .where(Room.is_active == True)
    )
    rooms_rows = rooms_result.all()

    # Build per-category aggregates
    from collections import defaultdict
    cat_rooms: dict[str, list] = defaultdict(list)
    for r_id, cat, rate, floor in rooms_rows:
        cat_str = cat.value if hasattr(cat, "value") else str(cat)
        cat_rooms[cat_str].append({"id": r_id, "rate": rate, "floor": floor})

    # ── today's slot states (only 1 row per room needed) ──────────────────────
    slots_result = await db.execute(
        select(Slot.room_id, Slot.block_type)
        .where(Slot.date == today)
    )
    today_state: dict[str, BlockType] = {
        row[0]: row[1] for row in slots_result.all()
    }

    lines = [f"Date: {today}  |  Booking window: {today} – {window_end}"]

    for cat in sorted(cat_rooms):
        rooms = cat_rooms[cat]
        total = len(rooms)

        soft = sum(1 for r in rooms if today_state.get(r["id"]) == BlockType.SOFT)
        hard = sum(1 for r in rooms if today_state.get(r["id"]) == BlockType.HARD)
        free = total - soft - hard

        rates = [r["rate"] for r in rooms]
        min_r, max_r = min(rates), max(rates)
        rate_str = (
            f"${int(min_r):,}/night"
            if min_r == max_r
            else f"${int(min_r):,}–{int(max_r):,}/night"
        )

        floors = sorted({r["floor"] for r in rooms})
        floor_str = (
            f"floor {floors[0]}"
            if len(floors) == 1
            else f"floors {floors[0]}–{floors[-1]}"
        )

        lines.append(
            f"  {cat:<10}  total={total}  free={free}  soft={soft}  hard={hard}"
            f"  |  {rate_str:<22}  |  {floor_str}"
        )

    lines.append(
        "\nUse get_room_inventory(category) to see per-room IDs, "
        "exact rates, and availability windows when you need specifics."
    )
    return "\n".join(lines)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/context")
async def get_hotel_context(db: AsyncSession = Depends(get_db)):
    """
    Returns live hotel state the frontend should embed in its first AI message.
    Frontend calls this once when the AI panel opens, stores result in React state,
    and passes it as hotel_context with every /ai/chat request.
    """
    context = await _build_hotel_context(db)
    return {
        "hotel_name":   settings.HOTEL_NAME,
        "today":        str(date.today()),
        "scan_window":  settings.SCAN_WINDOW_DAYS,
        "booking_window": settings.BOOKING_WINDOW_DAYS,
        "context_text": context,
    }


@router.post("/chat", response_model=AIChatResponse)
async def ai_chat(
    body: AIChatRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Run one turn of the receptionist agent.

    The frontend sends the FULL conversation history on every request —
    no server-side session is maintained. History lives in React useState
    and is lost on page refresh (by design).

    Flow:
      1. Frontend sends { messages: [...all prior turns...], hotel_context }
      2. Backend runs LangGraph agent loop (may call tools internally)
      3. Returns { reply, action_data }
      4. Frontend appends reply as new assistant message to its local state
    """
    # Fetch live context if frontend didn't supply it
    hotel_context = body.hotel_context
    if not hotel_context:
        hotel_context = await _build_hotel_context(db)

    result = await run_agent(
        messages=[m.model_dump() for m in body.messages],
        db=db,
        hotel_context=hotel_context,
    )
    return AIChatResponse(**result)
