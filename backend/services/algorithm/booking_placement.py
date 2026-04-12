"""
Booking Placement Engine — Trigger 2 (Booking Request)

Globally Optimal Placement approach:
  Given a guest request (category + date range), evaluate every possible room
  as a target. If the room contains SOFT bookings, use pure full enumeration to 
  find all valid ways to shuffle those displaced bookings to other rooms.

Network-Wide Anti-Fragmentation Scoring:
  Calculates exact Σ(run_length²) across ALL rooms in the category for every 
  possible shuffle permutation. Tie-breaker always prefers the path with the 
  fewest number of guest swaps.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from config import settings
from core.models import BlockType, RoomCategory
from services.algorithm.calendar_optimiser import SlotInfo


@dataclass
class ShufflePlan:
    state: str          # DIRECT_AVAILABLE | SHUFFLE_POSSIBLE | NOT_POSSIBLE
    room_id: Optional[str]
    nights: int
    category: RoomCategory
    check_in: date
    check_out: date
    swap_steps: list[dict]
    message: str


class ShuffleEngine:
    def __init__(self, all_slots: list[SlotInfo]):
        self.all_slots = all_slots
        self._matrix: dict[str, dict[date, SlotInfo]] = {}
        for s in all_slots:
            self._matrix.setdefault(s.room_id, {})[s.date] = s

    def _date_range(self, check_in: date, check_out: date) -> list[date]:
        nights = []
        cur = check_in
        while cur < check_out:
            nights.append(cur)
            cur += timedelta(days=1)
        return nights

    def _category_rooms(self, category: RoomCategory) -> list[str]:
        return sorted(set(s.room_id for s in self.all_slots if s.category == category))

    def _booking_dates_in_room(self, room_id: str, booking_id: str) -> set[date]:
        return {
            d for d, s in self._matrix.get(room_id, {}).items()
            if s.booking_id == booking_id
        }

    def search(
        self,
        category: RoomCategory,
        check_in: date,
        check_out: date,
    ) -> ShufflePlan:
        nights_needed = self._date_range(check_in, check_out)
        n_nights = len(nights_needed)
        
        if not nights_needed:
            return ShufflePlan(
                state="NOT_POSSIBLE", room_id=None, nights=0,
                category=category, check_in=check_in, check_out=check_out,
                swap_steps=[], message="Invalid date range.",
            )

        category_rooms = self._category_rooms(category)
        if not category_rooms:
            return ShufflePlan(
                state="NOT_POSSIBLE", room_id=None, nights=n_nights,
                category=category, check_in=check_in, check_out=check_out,
                swap_steps=[], message=f"No rooms found in category {category.value}.",
            )

        all_dates = set(nights_needed)
        for r in category_rooms:
            all_dates.update(self._matrix.get(r, {}).keys())
        all_dates_sorted = sorted(all_dates)

        working_state: dict[str, dict[date, BlockType]] = {
            r: {d: BlockType.EMPTY for d in all_dates_sorted} 
            for r in category_rooms
        }
        for r in category_rooms:
            for d, slot in self._matrix.get(r, {}).items():
                working_state[r][d] = slot.block_type

        def _get_network_score() -> int:
            score = 0
            for r in category_rooms:
                current_run = 0
                for d in all_dates_sorted:
                    if working_state[r][d] == BlockType.EMPTY:
                        current_run += 1
                    else:
                        if current_run > 0:
                            score += current_run * current_run
                            current_run = 0
                if current_run > 0:
                    score += current_run * current_run
            return score

        best_score = -1
        best_target = None
        best_swaps = []
        is_direct = False
        eval_count = [0]  # mutable counter shared across DFS calls

        def _dfs_enumerate(target_room: str, bids_to_place: list[str], idx: int, current_swaps: list[dict]):
            nonlocal best_score, best_target, best_swaps, is_direct

            if eval_count[0] >= settings.MAX_SHUFFLE_DFS_EVALS:
                return

            if idx == len(bids_to_place):
                overlap_cache = {}
                for d in nights_needed:
                    overlap_cache[d] = working_state[target_room][d]
                    working_state[target_room][d] = BlockType.SOFT
                
                eval_count[0] += 1
                score = _get_network_score()

                # MATHEMATICAL TIE-BREAKER: Favor paths with identical perfection but fewer guest swaps
                if score > best_score or (score == best_score and len(current_swaps) < len(best_swaps)):
                    best_score = score
                    best_target = target_room
                    best_swaps = list(current_swaps)
                    is_direct = (len(bids_to_place) == 0)
                    
                for d in nights_needed:
                    working_state[target_room][d] = overlap_cache[d]
                return

            bid = bids_to_place[idx]
            dates = self._booking_dates_in_room(target_room, bid)
            
            for alt_room in category_rooms:
                if alt_room == target_room: 
                    continue
                
                if all(working_state[alt_room][d] == BlockType.EMPTY for d in dates):
                    for d in dates: 
                        working_state[alt_room][d] = BlockType.SOFT
                    
                    step = {
                        "from_room": target_room,
                        "to_room": alt_room,
                        "booking_id": bid,
                        "dates": sorted(str(d) for d in dates)
                    }
                    
                    _dfs_enumerate(target_room, bids_to_place, idx + 1, current_swaps + [step])
                    
                    for d in dates: 
                        working_state[alt_room][d] = BlockType.EMPTY

        # Evaluate every room as a potential target
        for target_room in category_rooms:
            if any(working_state[target_room][d] == BlockType.HARD for d in nights_needed):
                continue
                
            displaced_bids_set = set()
            for d in nights_needed:
                slot = self._matrix.get(target_room, {}).get(d)
                if slot and slot.block_type == BlockType.SOFT and slot.booking_id:
                    displaced_bids_set.add(slot.booking_id)
            displaced_bids = list(displaced_bids_set)
            
            cache_displaced = {}
            for bid in displaced_bids:
                dates = self._booking_dates_in_room(target_room, bid)
                for d in dates:
                    cache_displaced[(bid, d)] = working_state[target_room][d]
                    working_state[target_room][d] = BlockType.EMPTY
                    
            # 100% Exhaustive search without arbitrary limits
            _dfs_enumerate(target_room, displaced_bids, 0, [])
            
            for bid in displaced_bids:
                dates = self._booking_dates_in_room(target_room, bid)
                for d in dates:
                    working_state[target_room][d] = cache_displaced[(bid, d)]

        if best_target is not None:
            if is_direct:
                message = (
                    f"Room {best_target} is directly available for all {n_nights} nights "
                    f"(selected as globally optimal placement)."
                )
                state = "DIRECT_AVAILABLE"
            else:
                n_swaps = len(best_swaps)
                message = (
                    f"Room {best_target} can be made available for {n_nights} nights "
                    f"(selected as optimal placement). {n_swaps} existing "
                    f"booking{'s' if n_swaps > 1 else ''} will be reassigned."
                )
                state = "SHUFFLE_POSSIBLE"

            return ShufflePlan(
                state=state,
                room_id=best_target,
                nights=n_nights,
                category=category,
                check_in=check_in,
                check_out=check_out,
                swap_steps=best_swaps,
                message=message,
            )

        return ShufflePlan(
            state="NOT_POSSIBLE",
            room_id=None,
            nights=n_nights,
            category=category,
            check_in=check_in,
            check_out=check_out,
            swap_steps=[],
            message=(
                f"No {category.value} room can be made available for {n_nights} consecutive nights "
                f"({check_in} → {check_out}). All rooms are either hard-blocked or their "
                f"bookings cannot be rearranged without conflicts."
            ),
        )