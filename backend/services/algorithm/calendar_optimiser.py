from __future__ import annotations
"""
Calendar Optimiser — Trigger 1 (Checkout / Cancellation)

Category-level Global Optimization with HHI-based scoring (greed factor p=2).

Algorithm (Global DP with Symmetry Breaking & Bounded Horizon):
  1. Extract and sort SOFT bookings chronologically.
  2. Bounding: Physically restricts the optimization window to a maximum of 20 
     days to mathematically guarantee prevention of combinatorial explosion.
  3. Symmetry Breaking: Rooms with identical HARD block schedules are grouped. 
  4. Inertia (Tie-Breaker): If two paths yield the exact same mathematically 
     perfect score, the engine defaults to the path that leaves the guest in 
     their original room, preventing infinite oscillation loops.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from config import settings
from core.models import BlockType, RoomCategory


@dataclass
class SlotInfo:
    slot_id: str
    room_id: str
    category: RoomCategory
    date: date
    block_type: BlockType
    booking_id: Optional[str]
    base_rate: float
    current_rate: float
    channel: str
    min_stay_active: bool
    min_stay_nights: int


@dataclass
class Gap:
    gap_id: str
    room_id: str
    category: RoomCategory
    dates: list[date]
    gap_length: int
    base_rate: float
    current_rate: float
    channel: str
    shuffle_possible: bool = False
    shuffle_plan: Optional[list[dict]] = field(default_factory=list)
    extended_length: int = 0 

    @property
    def date_range_str(self) -> str:
        if not self.dates:
            return ""
        if len(self.dates) == 1:
            return str(self.dates[0])
        return f"{self.dates[0]} → {self.dates[-1]}"



class GapDetector:
    def __init__(self, slots: list[SlotInfo], today: date):
        self.slots = slots
        self.today = today
        self._matrix: dict[str, dict[date, SlotInfo]] = {}
        for s in slots:
            self._matrix.setdefault(s.room_id, {})[s.date] = s

    def _category_rooms(self, category: RoomCategory) -> list[str]:
        return sorted(set(s.room_id for s in self.slots if s.category == category))

    @staticmethod
    def _consolidation_score(room_map: dict[date, SlotInfo]) -> float:
        runs: list[int] = []
        current = 0
        for slot in sorted(room_map.values(), key=lambda s: s.date):
            if slot.block_type == BlockType.EMPTY:
                current += 1
            else:
                if current:
                    runs.append(current)
                current = 0
        if current:
            runs.append(current)

        total_empty = sum(runs)
        if total_empty == 0:
            return 1.0
        return sum(r * r for r in runs) / (total_empty * total_empty)

    def category_score(self, category: RoomCategory) -> float:
        rooms = self._category_rooms(category)
        if not rooms:
            return 0.0
        scores = [self._consolidation_score(self._matrix.get(r, {})) for r in rooms]
        return sum(scores) / len(scores)

    def detect_gaps(self) -> list[Gap]:
        gaps: list[Gap] = []
        for room_id, date_map in self._matrix.items():
            sorted_dates = sorted(date_map.keys())
            n = len(sorted_dates)
            i = 0
            while i < n:
                slot = date_map[sorted_dates[i]]
                if slot.block_type != BlockType.EMPTY:
                    i += 1
                    continue

                run_start = i
                while i < n and date_map[sorted_dates[i]].block_type == BlockType.EMPTY:
                    i += 1
                run_end = i - 1

                run_dates = sorted_dates[run_start:run_end + 1]
                run_len   = len(run_dates)

                before_booked = (run_start > 0 and
                    date_map[sorted_dates[run_start - 1]].block_type in (BlockType.HARD, BlockType.SOFT))
                after_booked  = (run_end < n - 1 and
                    date_map[sorted_dates[run_end + 1]].block_type in (BlockType.HARD, BlockType.SOFT))

                # True orphan: EMPTY run with a booking on BOTH sides in the same room.
                # One-sided gaps (trailing/leading empty runs) are freely bookable and
                # must NOT be treated as orphans — they would naturally fill on demand.
                if not (before_booked and after_booked) or run_len > settings.MAX_GAP_NIGHTS:
                    i += 1
                    continue

                if (run_dates[0] - self.today).days >= settings.BOOKING_WINDOW_DAYS:
                    i += 1
                    continue

                first_slot = date_map[run_dates[0]]

                gaps.append(Gap(
                    gap_id=first_slot.slot_id,
                    room_id=room_id,
                    category=first_slot.category,
                    dates=run_dates,
                    gap_length=run_len,
                    extended_length=run_len,
                    base_rate=first_slot.base_rate,
                    current_rate=first_slot.current_rate,
                    channel=first_slot.channel,
                ))

        # Sort strictly by math: largest gaps first
        gaps.sort(key=lambda g: -g.gap_length)
        return gaps

    @staticmethod
    def _build_booking_map(working: dict[str, dict]) -> dict[str, tuple[str, frozenset]]:
        bid_rooms:  dict[str, set[str]]  = {}
        bid_dates:  dict[str, set]       = {}

        for room_id, room_state in working.items():
            for d, cell in room_state.items():
                if cell["block_type"] == BlockType.SOFT and cell["booking_id"]:
                    bid = cell["booking_id"]
                    bid_rooms.setdefault(bid, set()).add(room_id)
                    bid_dates.setdefault(bid, set()).add(d)

        result: dict[str, tuple[str, frozenset]] = {}
        for bid, rooms in bid_rooms.items():
            if len(rooms) == 1:
                room_id = next(iter(rooms))
                result[bid] = (room_id, frozenset(bid_dates[bid]))
        return result

    def _local_search(self, category: RoomCategory) -> list[dict]:
        MAX_DP_STATES = 5000000  
        
        cat_rooms = self._category_rooms(category)
        if len(cat_rooms) < 2:
            return []

        working: dict[str, dict[date, dict]] = {
            r: {d: {"block_type": s.block_type, "booking_id": s.booking_id}
                for d, s in self._matrix.get(r, {}).items()}
            for r in cat_rooms
        }

        booking_map = self._build_booking_map(working)
        if not booking_map:
            return []

        all_dates = set()
        hard_blocks = {r: set() for r in cat_rooms}
        valid_dates = {r: set() for r in cat_rooms}
        
        for r in cat_rooms:
            for d, cell in working[r].items():
                valid_dates[r].add(d)
                all_dates.add(d)
                if cell["block_type"] == BlockType.HARD:
                    hard_blocks[r].add(d)

        if not all_dates:
            return []
            
        scan_start = min(all_dates)
        raw_end = max(all_dates) + timedelta(days=1)
        scan_end = min(raw_end, scan_start + timedelta(days=20))

        bookings_info = []
        for bid, (r, dates) in booking_map.items():
            start_d = min(dates)
            end_d = max(dates) + timedelta(days=1)
            if start_d < scan_end:
                bookings_info.append((bid, r, dates, start_d, end_d))

        bookings_info.sort(key=lambda x: x[3])

        groups = {}
        for r_idx, r in enumerate(cat_rooms):
            hb_frozen = frozenset([d for d in hard_blocks[r] if d < scan_end])
            if hb_frozen not in groups:
                groups[hb_frozen] = []
            groups[hb_frozen].append(r_idx)
            
        group_indices = list(groups.values())
        room_to_group = [0] * len(cat_rooms)
        for g_id, r_indices in enumerate(group_indices):
            for r_idx in r_indices:
                room_to_group[r_idx] = g_id

        def get_canonical(ends: tuple[date, ...]) -> tuple[tuple[date, ...], ...]:
            canon = []
            for r_indices in group_indices:
                canon.append(tuple(sorted(ends[i] for i in r_indices)))
            return tuple(canon)

        gap_memo: dict[tuple[int, date, date], int] = {}
        def compute_gap_score(r_idx: int, d1: date, d2: date) -> int:
            if d1 >= d2: return 0
            state = (r_idx, d1, d2)
            if state in gap_memo: return gap_memo[state]
            
            r = cat_rooms[r_idx]
            score, current_run = 0, 0
            curr = d1
            
            while curr < d2:
                if curr in valid_dates[r]:
                    if curr in hard_blocks[r]:
                        if current_run > 0:
                            score += current_run * current_run
                            current_run = 0
                    else:
                        current_run += 1
                curr += timedelta(days=1)
                
            if current_run > 0:
                score += current_run * current_run
                
            gap_memo[state] = score
            return score

        dp_memo: dict[tuple[int, tuple[tuple[date, ...], ...]], int] = {}
        state_count = [0]

        def dp(idx: int, room_ends: tuple[date, ...]) -> int:
            if idx == len(bookings_info):
                return sum(compute_gap_score(r_idx, room_ends[r_idx], scan_end) 
                           for r_idx in range(len(cat_rooms)))

            canon = get_canonical(room_ends)
            state_key = (idx, canon)
            if state_key in dp_memo:
                return dp_memo[state_key]

            state_count[0] += 1
            if state_count[0] > MAX_DP_STATES:
                raise RuntimeError("STATE_OVERFLOW")

            bid, orig_r, dates, start_d, end_d = bookings_info[idx]
            best_score = -1
            
            seen_ends = [set() for _ in group_indices]
            valid_moves = []

            for r_idx, r in enumerate(cat_rooms):
                g_id = room_to_group[r_idx]
                r_end = room_ends[r_idx]
                
                if r_end in seen_ends[g_id]:
                    continue  
                seen_ends[g_id].add(r_end)
                
                if start_d >= r_end:
                    if not any(d in hard_blocks[r] for d in dates):
                        gap_score = compute_gap_score(r_idx, r_end, start_d)
                        valid_moves.append((gap_score, r_idx))
                        
            valid_moves.sort(key=lambda x: x[0])

            for gap_score, r_idx in valid_moves:
                new_ends = list(room_ends)
                new_ends[r_idx] = end_d
                
                future_score = dp(idx + 1, tuple(new_ends))
                if future_score != -1:
                    total = gap_score + future_score
                    if total > best_score:
                        best_score = total

            dp_memo[state_key] = best_score
            return best_score

        init_ends = tuple([scan_start] * len(cat_rooms))

        try:
            max_score = dp(0, init_ends)
            if max_score == -1:
                return []
                
            assignments = {}
            curr_ends = list(init_ends)
            for idx in range(len(bookings_info)):
                bid, orig_r, dates, start_d, end_d = bookings_info[idx]
                best_score = -1
                best_r_idx = -1
                
                valid_reconstruct = []
                for r_idx, r in enumerate(cat_rooms):
                    if start_d >= curr_ends[r_idx] and not any(d in hard_blocks[r] for d in dates):
                        gap_score = compute_gap_score(r_idx, curr_ends[r_idx], start_d)
                        valid_reconstruct.append((gap_score, r_idx))
                        
                valid_reconstruct.sort(key=lambda x: x[0])
                
                for gap_score, r_idx in valid_reconstruct:
                    new_ends = list(curr_ends)
                    new_ends[r_idx] = end_d
                    future_score = dp(idx + 1, tuple(new_ends))
                    if future_score != -1:
                        total = gap_score + future_score
                        
                        # INERTIA TIE-BREAKER: Strictly prefer original room if scores are tied!
                        if total > best_score or (total == best_score and cat_rooms[r_idx] == orig_r):
                            best_score = total
                            best_r_idx = r_idx
                                
                assignments[bid] = cat_rooms[best_r_idx]
                curr_ends[best_r_idx] = end_d
                
        except RuntimeError:
            # DP state-space exceeded — fall back to greedy single-step placement.
            # Compute original score first; only return steps if greedy improves it,
            # preventing the greedy from making the calendar worse and causing oscillation.
            orig_ends = list(init_ends)
            for bid, orig_r, dates, start_d, end_d in bookings_info:
                orig_r_idx = next(i for i, r in enumerate(cat_rooms) if r == orig_r)
                orig_ends[orig_r_idx] = end_d
            original_score = sum(
                compute_gap_score(r_idx, orig_ends[r_idx], scan_end)
                for r_idx in range(len(cat_rooms))
            )

            assignments = {}
            curr_ends = list(init_ends)
            for idx in range(len(bookings_info)):
                bid, orig_r, dates, start_d, end_d = bookings_info[idx]

                best_gap = float('inf')
                best_r_idx = -1

                for r_idx, r in enumerate(cat_rooms):
                    if start_d >= curr_ends[r_idx] and not any(d in hard_blocks[r] for d in dates):
                        gap_score = compute_gap_score(r_idx, curr_ends[r_idx], start_d)

                        # INERTIA TIE-BREAKER: Prefer original room if gaps are identically optimal
                        if gap_score < best_gap or (gap_score == best_gap and cat_rooms[r_idx] == orig_r):
                            best_gap = gap_score
                            best_r_idx = r_idx

                if best_r_idx == -1:
                    return []
                assignments[bid] = cat_rooms[best_r_idx]
                curr_ends[best_r_idx] = end_d

            # Verify greedy improved the score — if not, discard to avoid oscillation
            greedy_score = sum(
                compute_gap_score(r_idx, curr_ends[r_idx], scan_end)
                for r_idx in range(len(cat_rooms))
            )
            if greedy_score <= original_score:
                return []

        swap_steps = []
        for bid, orig_r, dates, start_d, end_d in bookings_info:
            new_r = assignments[bid]
            if new_r != orig_r:
                swap_steps.append({
                    "from_room": orig_r,
                    "to_room": new_r,
                    "booking_id": bid,
                    "dates": sorted(str(d) for d in dates)
                })

        return swap_steps

    def _assign_steps_to_gaps(self, gaps: list[Gap], steps: list[dict]) -> dict[str, list[dict]]:
        if not steps or not gaps:
            return {g.gap_id: [] for g in gaps}

        step_dates: list[frozenset[date]] = [
            frozenset(date.fromisoformat(d) for d in step["dates"])
            for step in steps
        ]

        prereqs: list[set[int]] = [set() for _ in steps]
        for i, step in enumerate(steps):
            for j in range(i):
                if steps[j]["from_room"] != step["to_room"]:
                    continue
                if step_dates[j] & step_dates[i]:
                    prereqs[i].add(j)

        gap_direct: dict[str, set[int]] = {}
        for gap in gaps:
            gap_date_set = set(gap.dates)
            direct: set[int] = set()
            for i, step in enumerate(steps):
                if step["from_room"] != gap.room_id:
                    continue
                freed = step_dates[i]
                touches = (
                    freed & gap_date_set or
                    any((d + timedelta(days=1)) in gap_date_set or
                        (d - timedelta(days=1)) in gap_date_set
                        for d in freed)
                )
                if touches:
                    direct.add(i)
            gap_direct[gap.gap_id] = direct

        assigned: set[int] = set()
        result: dict[str, list[dict]] = {}

        # Sorted purely by magnitude of the math
        sorted_gaps = sorted(gaps, key=lambda g: -g.gap_length)

        for gap in sorted_gaps:
            raw_direct = gap_direct.get(gap.gap_id, set())
            unassigned_direct = raw_direct - assigned

            if not unassigned_direct:
                result[gap.gap_id] = []
                continue

            needed: set[int] = set(unassigned_direct)
            frontier = set(unassigned_direct)
            has_claimed_prereq = False
            while frontier:
                next_f: set[int] = set()
                for idx in frontier:
                    for p in prereqs[idx]:
                        if p in assigned:
                            has_claimed_prereq = True
                            break
                        if p not in needed:
                            needed.add(p)
                            next_f.add(p)
                    if has_claimed_prereq:
                        break
                if has_claimed_prereq:
                    break
                frontier = next_f

            if has_claimed_prereq:
                result[gap.gap_id] = []
                continue

            assigned.update(needed)
            result[gap.gap_id] = [steps[i] for i in sorted(needed)]

        for gap in gaps:
            if gap.gap_id not in result:
                result[gap.gap_id] = []

        return result

    def _extended_run_after_plan(self, gap: Gap, plan: list[dict]) -> int:
        if not plan or not gap.dates:
            return gap.gap_length

        room_state: dict[date, str] = {
            d: slot.block_type
            for d, slot in self._matrix.get(gap.room_id, {}).items()
        }

        for step in plan:
            if step["from_room"] == gap.room_id:
                for d_str in step["dates"]:
                    d = date.fromisoformat(d_str)
                    if d in room_state:
                        room_state[d] = BlockType.EMPTY

        anchor = gap.dates[0]
        if room_state.get(anchor) != BlockType.EMPTY:
            return gap.gap_length

        start = anchor
        while True:
            prev = start - timedelta(days=1)
            if room_state.get(prev) == BlockType.EMPTY:
                start = prev
            else:
                break

        end = anchor
        while True:
            nxt = end + timedelta(days=1)
            if room_state.get(nxt) == BlockType.EMPTY:
                end = nxt
            else:
                break

        return (end - start).days + 1

    def run(self) -> tuple[list[Gap], list[dict]]:
        all_steps: list[dict] = []
        categories = sorted(set(s.category for s in self.slots))
        for category in categories:
            cat_steps = self._local_search(category)
            all_steps.extend(cat_steps)

        gaps = self.detect_gaps()
        gap_step_map = self._assign_steps_to_gaps(gaps, all_steps)

        for gap in gaps:
            plan = gap_step_map.get(gap.gap_id, [])
            if plan:
                gap.shuffle_possible = True
                gap.shuffle_plan = plan
                gap.extended_length = self._extended_run_after_plan(gap, plan)
            else:
                gap.shuffle_possible = False
                gap.shuffle_plan = []
                gap.extended_length = gap.gap_length

        # Final sort by optimized length (longest runs up top)
        gaps.sort(key=lambda g: -g.extended_length)

        return gaps, all_steps