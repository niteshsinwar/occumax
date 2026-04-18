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
| `PATCH /admin/slots/{id}` | Override a specific night's rate or channel |
| `POST /admin/seed-analytics-history` | Seed historical occupancy data for analytics |
| `POST /receptionist/check` | Find best room for a booking request (returns room_id + swap_plan) |
| `POST /receptionist/confirm` | Confirm and create the booking |
| `POST /receptionist/find-split` | Find a split-stay solution across room changes |
| `POST /receptionist/confirm-split` | Confirm a split-stay booking |
| `GET /receptionist/bookings` | List all bookings |
| `GET /dashboard/heatmap` | Full occupancy matrix for all rooms and dates |
| `GET /analytics/occupancy-forecast` | Forecast data |
| `GET /analytics/pace` | Booking pace analytics |
| `POST /manager/optimise` | Run the yield optimization algorithm |
| `POST /manager/commit` | Apply a swap plan from /optimise to the DB |
| `POST /manager/channel-allocate` | Pre-block inventory for a specific booking source / OTA partner |
| `GET /manager/channel-recommend` | Run Gemini channel AI — returns ranked OTA/GDS allocation recommendations |
| `GET /analytics/channel-performance` | Historical revenue breakdown by channel and partner (net of commission) |
| `POST /ai/chat` | AI receptionist agent (Gemini-backed, direct/walk-in only) |

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

## AI Agents

Three LangGraph agents backed by Google Gemini 2.5 Flash (`GEMINI_API_KEY` secret):

- `services/ai/receptionist_agent.py` — conversational booking placement (direct/walk-in only)
- `services/ai/pricing_agent.py` — dynamic rate recommendations per category/date
- `services/ai/channel_agent.py` — OTA/GDS channel allocation analysis; tools: `get_occupancy_gaps`, `get_channel_history`, `get_weekly_pattern`

All agents share the same pattern: LangGraph `StateGraph` with a tool node + Gemini 2.5 Flash with `bind_tools`. Each is invoked via a single async `run_*_agent()` entry point called from the controller layer.

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
