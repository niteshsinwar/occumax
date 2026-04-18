# Architecture

## Request Flow

```
Browser (React SPA)
  └─ axios → /api/*  (Nginx proxy)
       └─ FastAPI routers  (backend/api/)
            └─ Controllers  (backend/controllers/)
                 └─ Services: Algorithm / AI / Analytics
                      └─ SQLAlchemy async ORM → PostgreSQL
```

## Backend Layers

| Layer | Location | Responsibility |
|---|---|---|
| Router | `api/*.py` | HTTP in/out, request validation, response serialization |
| Controller | `controllers/*.py` | Orchestrate services, enforce business rules |
| Service | `services/**` | Pure domain logic — algorithm, AI agents, analytics |
| Model | `core/models/*.py` | DB schema (source of truth for tables/columns) |
| Schema | `core/schemas/*.py` | Pydantic shapes for API contracts |

## Database Schema Management

Schema is managed via SQLAlchemy models. On every deploy the backend calls `create_tables()` which runs `Base.metadata.create_all()` — creates new tables and idempotently adds new columns. To change the schema: edit a model file, commit, push.

## Frontend Structure

| Folder | Purpose |
|---|---|
| `pages/` | One file per route/view |
| `components/` | Reusable UI blocks |
| `api/client.ts` | Single axios instance — all HTTP calls go here |
| `types/` | Shared TypeScript types |
| `utils/` | Pure functions with no side effects |

## AI Agents

Two LangGraph agents backed by Google Gemini:
- **Receptionist agent** (`services/ai/receptionist_agent.py`) — conversational booking placement
- **Pricing agent** (`services/ai/pricing_agent.py`) — dynamic rate recommendations

## Environments

Two isolated Oracle Cloud VM instances (E2.1.Micro, Mumbai):
- `occumax-dev` (161.118.164.30) — tracks `Dev` branch
- `occumax-main` (80.225.202.88) — tracks `main` branch

Each VM runs its own PostgreSQL instance. No shared state between environments.
