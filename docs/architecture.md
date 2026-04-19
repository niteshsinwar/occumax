# Architecture

## Request Flow

```
Browser (React SPA)
  └─ axios → /api/*  (Nginx reverse proxy)
       └─ FastAPI routers  (backend/api/)
            └─ Controllers  (backend/controllers/)
                 └─ Services: Algorithm / AI / Analytics
                      └─ SQLAlchemy async ORM → PostgreSQL
```

---

## Backend Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Router | `api/*.py` | HTTP in/out, request validation, response serialization |
| Controller | `controllers/*.py` | Orchestrate services, enforce business rules |
| Service | `services/**` | Pure domain logic — algorithm, AI agents, analytics |
| Model | `core/models/*.py` | DB schema — source of truth for all tables and columns |
| Schema | `core/schemas/*.py` | Pydantic shapes for API request/response contracts |

---

## Database Schema

Schema is managed via **Alembic migrations** — never raw SQL, never `create_all()`.

- Models in `core/models/` define what the schema should look like
- Migrations in `alembic/versions/` are the steps to get there
- Every deploy runs `alembic upgrade head` before starting the backend

**Adding a column** — autogenerate works:
```bash
# 1. Edit the model
# 2. Generate migration
cd backend && alembic revision --autogenerate -m "add_xyz_to_table"
# 3. Review the generated file — make sure it only does what you intend
# 4. Commit model + migration together and push
```

**Dropping or renaming** — write manually:
```bash
cd backend && alembic revision -m "drop_xyz_from_table"
# Edit the generated file: write upgrade() and downgrade() by hand
# Commit and push
```

**Autogenerate pitfall**: if your local DB has stale tables from old branches, autogenerate will emit DROP TABLE statements for them. Always review the generated migration before committing — delete any operations that don't match your intent.

---

## API Endpoints

Full interactive docs at `https://161.118.164.30.nip.io/api/docs` (dev) or fetch the spec:

```bash
curl https://161.118.164.30.nip.io/api/openapi.json
```

Key endpoint groups:

| Prefix | Purpose |
| --- | --- |
| `GET /health` | Backend liveness — returns hotel name and schema version |
| `GET/POST /admin/rooms` | Create and list rooms |
| `PATCH /admin/rooms/{id}` | Update room config |
| `DELETE /admin/rooms/{id}` | Deactivate a room (`is_active=False`) |
| `GET /admin/categories` | List room categories |
| `GET /admin/channel-partners` | List known OTA/GDS partner names |
| `PATCH /admin/slots/{id}` | Override a specific night's block type or reason |
| `POST /admin/seed-analytics-history` | Seed historical occupancy data for analytics |
| `POST /receptionist/check` | Find best room for a booking request (returns room_id + swap_plan) |
| `POST /receptionist/confirm` | Confirm and create the booking (3-pass vacate→fill→place) |
| `POST /receptionist/find-split` | Find a same-category split-stay across 2–3 room segments |
| `POST /receptionist/find-split-flex` | Find a cross-category split-stay (any room mix, prefers requested category) |
| `POST /receptionist/confirm-split` | Confirm a split-stay — creates one Booking per segment with shared stay_group_id |
| `GET /receptionist/bookings` | Last 50 bookings ordered by created_at desc |
| `GET /dashboard/heatmap` | Full occupancy matrix for all rooms and dates |
| `GET /analytics/occupancy-forecast` | Forward occupancy forecast with Y-2 comparison |
| `GET /analytics/pace` | Booking pace analytics (pickup lead-day curves) |
| `GET /analytics/event-insights` | AI-generated demand event commentary for a date range |
| `GET /analytics/revenue-summary` | Revenue KPIs: total, ADR, RevPAR, channel mix |
| `GET /analytics/channel-performance` | Historical revenue by channel/partner, net of commission (OTA 18%, GDS 10%) |
| `POST /manager/optimise` | Run the yield optimisation algorithm — returns swap plan, does NOT write to DB |
| `POST /manager/commit` | Apply a swap plan from /optimise to the DB (two-pass vacate→fill) |
| `POST /manager/channel-allocate` | Pre-block inventory for a specific OTA partner (creates SOFT placeholder bookings) |
| `GET /manager/channel-recommend` | Run Gemini channel AI — returns ranked OTA/GDS allocation recommendations |
| `GET /manager/pricing/analyse` | Run Gemini pricing AI — returns per-category-per-date rate recommendations |
| `POST /manager/pricing/commit` | Apply pricing recommendations — batch-updates `slot.current_rate` |
| `POST /ai/chat` | AI receptionist agent (Gemini-backed, full conversation history, returns action_data card) |

---

## Frontend Structure

| Folder | Purpose |
| --- | --- |
| `pages/` | One file per route — Dashboard, ManagerDashboard, ReceptionistView, AdminPanel |
| `components/` | Reusable UI blocks |
| `api/client.ts` | Single axios instance — all HTTP calls go here, nowhere else |
| `types/index.ts` | Shared TypeScript types |
| `utils/` | Pure functions, no side effects |
| `App.tsx` | App shell, routing, nav |

---

## Key Algorithms

### ShuffleEngine (`services/algorithm/booking_placement.py`)

Exhaustive DFS across all rooms in a category. Evaluates every possible target room and swap chain, scores each outcome using HHI consolidation (`Σ run_length²` across all rooms), breaks ties by minimising the number of guest moves. Capped at `settings.MAX_SHUFFLE_DFS_EVALS = 50000` evaluations. Returns the best `(target_room, swap_steps[])` plan or `NOT_POSSIBLE`.

### Calendar Optimiser (`services/algorithm/calendar_optimiser.py`)

Manager yield tool. Runs `GapDetector` to find orphan gaps (EMPTY runs of ≤`MAX_GAP_NIGHTS` bounded by SOFT/HARD on both sides), then a DP local search with HHI scoring and an inertia tie-breaker. Cap: 5M states; falls back to greedy. Returns a swap plan only — does not write to DB. `commit_plan()` in the controller does the two-pass vacate→fill write.

### SplitStayEngine / SplitStayFlexEngine (`services/algorithm/split_stay.py`, `split_stay_flex.py`)

Split stay: covers all requested nights across 2–3 room segments with a 5–10% consecutive-stay discount. `SplitStayEngine` stays within the requested category. `SplitStayFlexEngine` crosses categories, strongly preferring the requested category and ±1 adjacent ones.

---

## AI Agents

Three LangGraph agents backed by Google Gemini 2.5 Flash (`GEMINI_API_KEY` secret):

**Receptionist agent** (`services/ai/receptionist_agent.py`) — conversational booking + always-on revenue advisor. 6 tools:

- `check_availability(category, check_in, check_out)` — calls ShuffleEngine, returns action card
- `find_split_stay(category, check_in, check_out)` — same-category split
- `find_split_stay_flex(preferred_category, check_in, check_out)` — cross-category split
- `get_room_inventory(category)` — per-room timeline + first_free date
- `probe_split_window(category, anchor_check_in, duration_nights)` — tries ±5 day shifts to find nearest split window
- `get_revenue_intelligence()` — tonight occupancy, ADR, orphan gaps, 7-day pickup, channel mix

Two special input modes triggered by message prefix:

- `[HANDOFF]` — deterministic check already returned NOT_POSSIBLE; agent follows a 5-step fallback sequence (check_in+1, higher category, lower category, split, flex split) without re-calling check for the original dates
- `[PREFS]` — receptionist toggled a preference checkbox; agent acknowledges only, no tool calls

The agent returns `action_data: { type, data }` alongside its text reply. The frontend renders this as a clickable card (`availability_result`, `split_stay_result`, `booking_confirmed`, `split_stay_confirmed`). Confirm is **never** a tool — all DB writes go through the receptionist's UI button.

**Pricing agent** (`services/ai/pricing_agent.py`) — dynamic rate recommendations. 3 tools: `get_pricing_context`, `get_low_occupancy_dates`, `get_pickup_pace`. Returns a list of `{ category, date, suggested_rate, reason }` items.

**Channel agent** (`services/ai/channel_agent.py`) — OTA/GDS allocation analysis. 3 tools: `get_occupancy_gaps`, `get_channel_history`, `get_weekly_pattern`.

All agents share the same pattern: LangGraph `StateGraph` with a tool node + Gemini 2.5 Flash with `bind_tools`. Each is invoked via a single async `run_*_agent()` entry point called from the controller layer.

---

## Behavioral Invariants

These are non-obvious facts derived from the codebase. A coding agent must respect them.

**`is_live` is always `False`** — `Booking.is_live` is set to `False` on every confirmed booking (both single and split). It was intended for distinguishing forecast vs. real bookings but is not set to `True` anywhere in the current flow. Do **not** filter `Booking.is_live == True` when querying for recent or active bookings — you will get zero results. Query by `created_at`, `check_in`, or `check_out` instead.

**Channel caching in `confirm_booking`** — The 3-pass commit vacates source slots in PASS 1 (sets `booking_id = None`). PASS 2 must recover the original `channel` / `channel_partner` of moved bookings. It does this from an in-memory `booking_channel_cache` dict populated during PASS 1, **before** the slots are nulled. If you extend the shuffle logic, always follow this pattern — querying `Slot.booking_id == bid` after PASS 1 returns nothing.

**Missing Slot rows = EMPTY** — The DB does not always have explicit `Slot` rows for empty nights. A room is considered empty for a date if no Slot row exists (or the row has `block_type=EMPTY`). Never assume a missing Slot is an error.

**Pricing panel row state** — `PricingPanel.tsx` keys `RowState` by `"${category}-${date}"` (a `Record<string, RowState>`). This is intentional: the API returns recommendations in arbitrary order; the grouped display re-sorts alphabetically. A flat array indexed by position would silently apply Accept/Reject to the wrong row. Do not switch it back to an array.

**`_compute_alternatives` covers all 6 categories** — The backend's alternative suggestions can return ECONOMY and PREMIUM rooms even though the receptionist front desk form only shows 4 categories (STANDARD, STUDIO, DELUXE, SUITE). This is a known frontend gap; the backend is correct.

---

## Channel Attribution

Every `Slot` row carries `channel` (enum: OTA/GDS/DIRECT/WALKIN) and `channel_partner` (nullable string: "MakeMyTrip", "Amadeus", etc.). Two booking routes exist:

- **Direct/Walk-in**: set at receptionist desk, `channel_partner = NULL`
- **Channel (OTA/GDS)**: set via Manager → Channels allocation, `channel_partner` = named partner

The `channel_partner` column was added in migration `b227ced3351d`.

---

## Environments

| Branch | URL | Database |
| --- | --- | --- |
| `Dev` | https://161.118.164.30.nip.io | Isolated PostgreSQL on dev server |
| `main` | https://80.225.202.88.nip.io | Isolated PostgreSQL on prod server |

No shared state between environments. A migration applied to dev does not touch production until `Dev` is merged to `main`.
