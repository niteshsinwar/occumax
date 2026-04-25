from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from config import settings
from core.models import BlockType, RoomCategory
from services.algorithm.calendar_optimiser import SlotInfo


@dataclass
class KNightOptimiseResult:
    swap_steps: list[dict]


class KNightWindowOptimiser:
    """
    k-night optimiser: rearrange SOFT bookings within a category to maximize the
    number of bookable k-night windows (sum over runs max(0, L-k+1)).

    This is meant for Dashboard previews — no DB write occurs here.
    """

    def __init__(self, slots: list[SlotInfo], today: date):
        self.slots = slots
        self.today = today
        self._matrix: dict[str, dict[date, SlotInfo]] = {}
        for s in slots:
            self._matrix.setdefault(s.room_id, {})[s.date] = s

    def _category_rooms(self, category: RoomCategory) -> list[str]:
        return sorted(set(s.room_id for s in self.slots if s.category == category))

    @staticmethod
    def _build_booking_map(working: dict[str, dict]) -> dict[str, tuple[str, frozenset]]:
        bid_rooms: dict[str, set[str]] = {}
        bid_dates: dict[str, set[date]] = {}

        for room_id, room_state in working.items():
            for d, cell in room_state.items():
                if cell["block_type"] == BlockType.SOFT and cell["booking_id"]:
                    bid = cell["booking_id"]
                    bid_rooms.setdefault(bid, set()).add(room_id)
                    bid_dates.setdefault(bid, set()).add(d)

        result: dict[str, tuple[str, frozenset]] = {}
        for bid, rooms in bid_rooms.items():
            # only single-room bookings are movable as atomic blocks
            if len(rooms) == 1:
                room_id = next(iter(rooms))
                result[bid] = (room_id, frozenset(bid_dates[bid]))
        return result

    def _local_search(self, category: RoomCategory, target_nights: int) -> list[dict]:
        MAX_DP_STATES = 5_000_000
        k = max(1, int(target_nights))

        cat_rooms = self._category_rooms(category)
        if len(cat_rooms) < 2:
            return []

        working: dict[str, dict[date, dict]] = {
            r: {d: {"block_type": s.block_type, "booking_id": s.booking_id} for d, s in self._matrix.get(r, {}).items()}
            for r in cat_rooms
        }

        booking_map = self._build_booking_map(working)
        if not booking_map:
            return []

        all_dates: set[date] = set()
        hard_blocks: dict[str, set[date]] = {r: set() for r in cat_rooms}
        valid_dates: dict[str, set[date]] = {r: set() for r in cat_rooms}

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

        bookings_info: list[tuple[str, str, frozenset[date], date, date]] = []
        for bid, (r, dates) in booking_map.items():
            start_d = min(dates)
            end_d = max(dates) + timedelta(days=1)
            if start_d < scan_end:
                bookings_info.append((bid, r, dates, start_d, end_d))
        bookings_info.sort(key=lambda x: x[3])

        # symmetry breaking based on identical hard-block schedules
        groups: dict[frozenset[date], list[int]] = {}
        for r_idx, r in enumerate(cat_rooms):
            hb_frozen = frozenset([d for d in hard_blocks[r] if d < scan_end])
            groups.setdefault(hb_frozen, []).append(r_idx)
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

        def compute_k_window_score(r_idx: int, d1: date, d2: date) -> int:
            if d1 >= d2:
                return 0
            state = (r_idx, d1, d2)
            if state in gap_memo:
                return gap_memo[state]

            r = cat_rooms[r_idx]
            score = 0
            current_run = 0
            curr = d1
            while curr < d2:
                if curr in valid_dates[r]:
                    if curr in hard_blocks[r]:
                        if current_run >= k:
                            score += (current_run - k + 1)
                        current_run = 0
                    else:
                        current_run += 1
                curr += timedelta(days=1)

            if current_run >= k:
                score += (current_run - k + 1)

            gap_memo[state] = score
            return score

        dp_memo: dict[tuple[int, tuple[tuple[date, ...], ...]], int] = {}
        state_count = [0]

        def dp(idx: int, room_ends: tuple[date, ...]) -> int:
            if idx == len(bookings_info):
                return sum(compute_k_window_score(r_idx, room_ends[r_idx], scan_end) for r_idx in range(len(cat_rooms)))

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
            valid_moves: list[tuple[int, int]] = []
            for r_idx, r in enumerate(cat_rooms):
                g_id = room_to_group[r_idx]
                r_end = room_ends[r_idx]
                if r_end in seen_ends[g_id]:
                    continue
                seen_ends[g_id].add(r_end)

                if start_d >= r_end:
                    if not any(d in hard_blocks[r] for d in dates):
                        gap_score = compute_k_window_score(r_idx, r_end, start_d)
                        valid_moves.append((gap_score, r_idx))

            # bigger gap_score is better for k-night windows
            valid_moves.sort(key=lambda x: -x[0])

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

            assignments: dict[str, str] = {}
            curr_ends = list(init_ends)
            for idx in range(len(bookings_info)):
                bid, orig_r, dates, start_d, end_d = bookings_info[idx]
                best_score = -1
                best_r_idx = -1

                valid_reconstruct: list[tuple[int, int]] = []
                for r_idx, r in enumerate(cat_rooms):
                    if start_d >= curr_ends[r_idx] and not any(d in hard_blocks[r] for d in dates):
                        gap_score = compute_k_window_score(r_idx, curr_ends[r_idx], start_d)
                        valid_reconstruct.append((gap_score, r_idx))
                valid_reconstruct.sort(key=lambda x: -x[0])

                for gap_score, r_idx in valid_reconstruct:
                    new_ends = list(curr_ends)
                    new_ends[r_idx] = end_d
                    future_score = dp(idx + 1, tuple(new_ends))
                    if future_score != -1:
                        total = gap_score + future_score
                        # inertia tie-breaker: keep original room when scores tie
                        if total > best_score or (total == best_score and cat_rooms[r_idx] == orig_r):
                            best_score = total
                            best_r_idx = r_idx

                if best_r_idx == -1:
                    return []
                assignments[bid] = cat_rooms[best_r_idx]
                curr_ends[best_r_idx] = end_d

        except RuntimeError:
            # Fallback: do nothing on overflow for MVP (safe).
            return []

        swap_steps = []
        for bid, orig_r, dates, start_d, end_d in bookings_info:
            new_r = assignments.get(bid, orig_r)
            if new_r != orig_r:
                swap_steps.append({
                    "from_room": orig_r,
                    "to_room": new_r,
                    "booking_id": bid,
                    "dates": sorted(str(d) for d in dates),
                })
        return swap_steps

    def run(self, target_nights: int, categories: list[RoomCategory]) -> KNightOptimiseResult:
        all_steps: list[dict] = []
        cats = categories or sorted(set(s.category for s in self.slots))
        for category in cats:
            all_steps.extend(self._local_search(category, target_nights))
        # Guardrail: keep plans bounded
        if len(all_steps) > settings.MAX_SHUFFLE_DFS_EVALS:
            all_steps = all_steps[: settings.MAX_SHUFFLE_DFS_EVALS]
        return KNightOptimiseResult(swap_steps=all_steps)

