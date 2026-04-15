"""
Flexible Split-Stay Engine — Phase 2 (cross-category)
 
Extends the split-stay concept to allow switching categories between segments.
Primary intent is still to respect the guest's preferred category, but when a
same-category split stay is impossible, this can propose a plan across any room
categories with a strong preference for adjacent categories (±1).
 
Constraints:
  - Covers every requested night.
  - Caps at 3 segments (2 room changes) to limit operational complexity.
  - Applies the same discount tiers as the standard split-stay engine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from core.models.enums import BlockType, RoomCategory
from services.algorithm.calendar_optimiser import SlotInfo

MAX_SEGMENTS = 3
DISCOUNT_TABLE = {1: 0.0, 2: 5.0, 3: 10.0}


@dataclass
class FlexSplitSegment:
    room_id: str
    category: RoomCategory
    floor: int
    check_in: date
    check_out: date
    nights: int
    base_rate: float
    discounted_rate: float


@dataclass
class FlexSplitPlan:
    state: str  # SPLIT_POSSIBLE | NOT_POSSIBLE
    segments: list[FlexSplitSegment] = field(default_factory=list)
    discount_pct: float = 0.0
    total_nights: int = 0
    total_rate: float = 0.0
    message: str = ""


_LADDER: list[RoomCategory] = [
    RoomCategory.ECONOMY,
    RoomCategory.STANDARD,
    RoomCategory.STUDIO,
    RoomCategory.DELUXE,
    RoomCategory.PREMIUM,
    RoomCategory.SUITE,
]


def _cat_distance(preferred: RoomCategory, candidate: RoomCategory) -> int:
    try:
        a = _LADDER.index(preferred)
        b = _LADDER.index(candidate)
        return abs(a - b)
    except ValueError:
        return 99


def _date_range(check_in: date, check_out: date) -> list[date]:
    out, cur = [], check_in
    while cur < check_out:
        out.append(cur)
        cur += timedelta(days=1)
    return out


def _consecutive_free(
    room: str,
    from_night: date,
    all_nights: list[date],
    free: dict[date, list[str]],
) -> int:
    count = 0
    started = False
    for night in all_nights:
        if night < from_night:
            continue
        started = True
        if room in free.get(night, []):
            count += 1
        else:
            break
    return count if started else 0


class SplitStayFlexEngine:
    def __init__(
        self,
        slots: list[SlotInfo],
        floor_map: dict[str, int],
        preferred_category: RoomCategory,
    ):
        self._floor_map = floor_map
        self._preferred = preferred_category
        self._matrix: dict[str, dict[date, BlockType]] = {}
        self._rates: dict[str, float] = {}
        self._cat: dict[str, RoomCategory] = {}

        for s in slots:
            self._matrix.setdefault(s.room_id, {})[s.date] = s.block_type
            self._rates[s.room_id] = s.base_rate
            self._cat[s.room_id] = s.category

    def search(self, check_in: date, check_out: date) -> FlexSplitPlan:
        nights = _date_range(check_in, check_out)
        if not nights:
            return FlexSplitPlan(state="NOT_POSSIBLE", message="Invalid date range.")

        all_rooms = list(self._matrix.keys())
        if not all_rooms:
            return FlexSplitPlan(state="NOT_POSSIBLE", message="No active rooms found.")

        free: dict[date, list[str]] = {}
        for night in nights:
            free[night] = [
                r
                for r in all_rooms
                if self._matrix.get(r, {}).get(night, BlockType.EMPTY) == BlockType.EMPTY
            ]

        blocked = [n for n in nights if not free[n]]
        if blocked:
            return FlexSplitPlan(
                state="NOT_POSSIBLE",
                message=(
                    "No room is free on "
                    f"{', '.join(str(d) for d in blocked[:3])}"
                    f"{'…' if len(blocked) > 3 else ''}. "
                    "A split stay cannot cover these dates."
                ),
            )

        segments: list[tuple[str, date, date]] = []
        current_room: Optional[str] = None
        seg_start = check_in

        for night in nights:
            if current_room is not None and current_room in free[night]:
                continue

            if current_room is not None:
                segments.append((current_room, seg_start, night))

            if len(segments) >= MAX_SEGMENTS:
                return FlexSplitPlan(
                    state="NOT_POSSIBLE",
                    message=f"A split stay would require more than {MAX_SEGMENTS} room changes — not offered.",
                )

            def key_fn(r: str) -> tuple[int, int, str]:
                consec = _consecutive_free(r, night, nights, free)
                dist = _cat_distance(self._preferred, self._cat.get(r, self._preferred))
                # Higher is better: longest consecutive run, then closest category, then stable by id
                return (consec, -dist, r)

            current_room = max(free[night], key=key_fn)
            seg_start = night

        segments.append((current_room, seg_start, check_out))

        if len(segments) == 1:
            return FlexSplitPlan(
                state="NOT_POSSIBLE",
                message="A single room covers all nights — no split stay needed.",
            )

        discount_pct = DISCOUNT_TABLE.get(len(segments), 0.0)
        total_rate = 0.0
        built: list[FlexSplitSegment] = []

        for room_id, ci, co in segments:
            n = (co - ci).days
            rate = self._rates.get(room_id, 0.0)
            disc_r = round(rate * (1 - discount_pct / 100), 2)
            total_rate += n * disc_r
            built.append(
                FlexSplitSegment(
                    room_id=room_id,
                    category=self._cat.get(room_id, self._preferred),
                    floor=self._floor_map.get(room_id, 0),
                    check_in=ci,
                    check_out=co,
                    nights=n,
                    base_rate=rate,
                    discounted_rate=disc_r,
                )
            )

        n_changes = len(built) - 1
        msg = (
            f"Split stay across {len(built)} rooms "
            f"({'1 room change' if n_changes == 1 else f'{n_changes} room changes'}). "
            f"{int(discount_pct)}% consecutive-stay discount applied. "
            f"Total: ₹{total_rate:,.0f} for {len(nights)} nights."
        )

        return FlexSplitPlan(
            state="SPLIT_POSSIBLE",
            segments=built,
            discount_pct=discount_pct,
            total_nights=len(nights),
            total_rate=round(total_rate, 2),
            message=msg,
        )

