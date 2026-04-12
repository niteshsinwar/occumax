"""
Central configuration — controls every tunable behaviour in the backend.

Infrastructure settings (DATABASE_URL, CORS) come from the .env file.
Algorithm and business-rule settings have hardcoded defaults that can
be overridden in .env without touching any Python file.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):

    # ── Infrastructure ────────────────────────────────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://occumax:occumax@localhost:5432/occumax"
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:5174"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Aiven uses `postgres://`, Railway/Render use `postgresql://` — translate both for asyncpg
        url = self.DATABASE_URL
        if url.startswith("postgres://"):
            url = "postgresql+asyncpg://" + url[len("postgres://"):]
        elif url.startswith("postgresql://"):
            url = "postgresql+asyncpg://" + url[len("postgresql://"):]
        if url != self.DATABASE_URL:
            object.__setattr__(self, "DATABASE_URL", url)

    # ── AI ────────────────────────────────────────────────────────────────────
    GEMINI_API_KEY: str = ""

    # ── Hotel identity ────────────────────────────────────────────────────────
    HOTEL_NAME: str = "Demo Hotel"

    # ── Calendar window ───────────────────────────────────────────────────────
    # How many days ahead the heatmap, gap scan and admin stats cover.
    # Increase to show a wider planning horizon; decrease for lighter DB queries.
    SCAN_WINDOW_DAYS: int = 30

    # How far ahead a receptionist can place a booking.
    # Must be <= SCAN_WINDOW_DAYS.
    BOOKING_WINDOW_DAYS: int = 20

    # ── Gap detection thresholds ──────────────────────────────────────────────
    # Empty runs longer than this are normal sellable windows — not orphan gaps.
    # Reduce to flag more gaps; raise to be less aggressive.
    MAX_GAP_NIGHTS: int = 5

    # ── HHI optimiser safety caps ─────────────────────────────────────────────
    # Maximum total swap steps the optimizer may produce in one category pass.
    # Prevents runaway execution on very large room sets.
    MAX_SWAP_STEPS: int = 500

    # Maximum outer iterations of the two-phase (evacuation + local-search) loop.
    MAX_OUTER_ITERATIONS: int = 50

    # Maximum DFS leaf evaluations in ShuffleEngine exhaustive search.
    # (K-1)^N paths where K=rooms, N=displaced bookings. Cap prevents timeouts
    # on busy hotels. When exceeded, the best result found so far is returned.
    MAX_SHUFFLE_DFS_EVALS: int = 50000

    # ── Anti-fragmentation cost table ─────────────────────────────────────────
    # Penalty added when placing a new booking leaves an orphaned gap of N nights
    # adjacent to it.  Higher cost = less likely to choose that room.
    #   0 nights gap → 0   (booking touches another block — perfect)
    #   1 night  gap → 100 (near-impossible to sell a 1-night hole)
    #   2 nights gap → 40  (hard to fill)
    #   3 nights gap → 10  (acceptable)
    #   4+ nights   → 5   (large gaps self-fill)
    GAP_COST_0N: int = 0
    GAP_COST_1N: int = 100
    GAP_COST_2N: int = 40
    GAP_COST_3N: int = 10
    GAP_COST_4N_PLUS: int = 5


    class Config:
        env_file = ".env"

    # ── Derived helpers (not env-settable) ────────────────────────────────────

    def gap_cost_table(self) -> dict[int, int]:
        """Return the full gap-cost lookup table as a dict."""
        return {
            0: self.GAP_COST_0N,
            1: self.GAP_COST_1N,
            2: self.GAP_COST_2N,
            3: self.GAP_COST_3N,
        }

settings = Settings()
