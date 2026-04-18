# Occumax — Agent Guide (CLAUDE.md)

This file is read automatically by Claude Code at the start of every session.
It gives the agent full context to operate autonomously.

## What this project is

Hotel revenue recovery platform. FastAPI backend + React 19 frontend deployed on Oracle Cloud.
Two live environments: Dev (testing) and Production (main).

## Read these docs before doing anything

| Task | Read first |
|---|---|
| Any infrastructure change | `docs/oracle-infrastructure.md` |
| Any deployment / CI/CD change | `docs/deployment.md` |
| Any backend / schema change | `docs/architecture.md` |
| Contributing workflow | `docs/contributing.md` |

---

## Quick reference — where things live

### Backend
| Thing | Location |
|---|---|
| App entrypoint | `backend/main.py` |
| All env-configurable settings | `backend/config.py` |
| DB models = schema source of truth | `backend/core/models/` |
| API route handlers (thin) | `backend/api/` |
| Orchestration logic | `backend/controllers/` |
| Algorithm engine | `backend/services/algorithm/` |
| AI agents (Gemini/LangGraph) | `backend/services/ai/` |
| Analytics | `backend/services/analytics/` |
| Pydantic request/response shapes | `backend/core/schemas/` |
| Non-sensitive config (git-tracked) | `backend/.env.server` |
| Python deps | `backend/requirements.txt` |

### Frontend
| Thing | Location |
|---|---|
| Route-level pages | `frontend/src/pages/` |
| Shared components | `frontend/src/components/` |
| All API calls | `frontend/src/api/client.ts` |
| TypeScript types | `frontend/src/types/index.ts` |
| Pure utilities | `frontend/src/utils/` |
| App shell + routing | `frontend/src/App.tsx` |

### Infrastructure / CI/CD
| Thing | Location |
|---|---|
| Dev deploy pipeline | `.github/workflows/deploy-dev.yml` |
| Prod deploy pipeline | `.github/workflows/deploy-main.yml` |
| Oracle infra details | `docs/oracle-infrastructure.md` |
| SSH key | `~/.ssh/occumax_deploy` |
| OCI CLI config | `~/.oci/` |

---

## Environments

| Env | Branch | Server IP | URL |
|---|---|---|---|
| Development | `Dev` | `161.118.164.30` | http://161.118.164.30 |
| Production | `main` | `80.225.202.88` | http://80.225.202.88 |

SSH into either server:
```bash
ssh -i ~/.ssh/occumax_deploy ubuntu@161.118.164.30   # dev
ssh -i ~/.ssh/occumax_deploy ubuntu@80.225.202.88    # prod
```

---

## Schema changes (most common task)

To add a table or column — **no migrations needed**, just edit the model and push:

1. Edit or add a file in `backend/core/models/`
2. Follow the existing pattern (see `backend/core/models/room.py` as example)
3. Import the model in `backend/services/database.py` so `create_tables()` sees it
4. Commit and push to `Dev` → deploy runs → backend restarts → schema applied

`create_tables()` uses `Base.metadata.create_all()` — safe, idempotent, only adds never drops.
For destructive changes (drop/rename column) → read `docs/architecture.md#schema-management`.

---

## Config changes

**Non-sensitive** (hotel name, window days, costs) → edit `backend/.env.server`, commit, push.
**Sensitive** (DB URL, API keys) → update GitHub Secrets. To do this programmatically:

```python
# Install: pip install PyNaCl
# Script: see docs/deployment.md#updating-github-secrets
```

---

## Running locally

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.server .env
# Add to .env: DATABASE_URL=postgresql+asyncpg://... and GEMINI_API_KEY=...
uvicorn main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install
echo "VITE_API_URL=http://localhost:8000" > .env.local
npm run dev
```

---

## Key rules

- **Never commit `.env`** — only `.env.server` (non-sensitive) is tracked
- **Never edit server files manually** — all changes go through git commits
- **Schema changes** → edit SQLAlchemy models only, never raw SQL
- **Config changes** → `backend/.env.server` for non-sensitive, GitHub Secrets for sensitive
- **Branch to push to** → `Dev` for testing, `main` for production
- **All infra managed via OCI CLI** — see `docs/oracle-infrastructure.md`
