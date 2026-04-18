# Occumax — Agent Guide

Auto-loaded by Claude Code every session. Everything you need to operate autonomously.

---

## AGENT RULE: Update docs after every change

After any significant change, update the relevant doc in the same commit:
- Schema or architecture changed → update `docs/architecture.md`
- Deploy process changed → update `docs/deployment.md`
- New workflow or team rule → update `docs/contributing.md`
- This file needs updating → update `CLAUDE.md`

---

## What this project is

Hotel revenue recovery platform. FastAPI (Python) backend + React 19 (TypeScript) frontend.

Two live environments, each on its own server with its own database:

| Environment | Branch | URL |
| --- | --- | --- |
| Development | `Dev` | https://161.118.164.30.nip.io |
| Production | `main` | https://80.225.202.88.nip.io |

Every git push triggers an automatic deploy. You never touch servers directly — everything goes through git.

---

## Read these docs for specific tasks

| Task | Doc |
| --- | --- |
| Backend/schema/architecture | `docs/architecture.md` |
| Deployment — CI/CD flow, debugging, how deploys work | `docs/deployment.md` |
| Team workflow, branching, commits, PR process | `docs/contributing.md` |

---

## Where things live

### Backend (`backend/`)
| Thing | Location |
| --- | --- |
| App entrypoint | `main.py` |
| All settings (env-configurable) | `config.py` |
| DB models = schema source of truth | `core/models/` |
| API route handlers (thin) | `api/` |
| Business logic orchestration | `controllers/` |
| Algorithm engine | `services/algorithm/` |
| AI agents (Gemini/LangGraph) | `services/ai/` |
| Analytics | `services/analytics/` |
| Pydantic request/response shapes | `core/schemas/` |
| Non-sensitive config (git-tracked) | `.env.server` |
| Migration scripts | `alembic/versions/` |

### Frontend (`frontend/src/`)
| Thing | Location |
| --- | --- |
| Route-level pages | `pages/` |
| Reusable UI components | `components/` |
| All HTTP calls | `api/client.ts` |
| Shared TypeScript types | `types/index.ts` |
| Pure utility functions | `utils/` |
| App shell + routing | `App.tsx` |

### Scripts (`scripts/`)
| Script | Purpose |
| --- | --- |
| `seed_dev.py` | Seeds realistic hotel data into dev via API — run locally with `python3 scripts/seed_dev.py` |

---

## How to make any change

### Backend code change
Edit any `backend/**/*.py` → commit → push. Done.

### Frontend change
Edit any `frontend/src/**/*.tsx` → commit → push. Done.

### Add a DB column (additive — safe)
```bash
# 1. Edit the model
backend/core/models/<model>.py

# 2. Generate migration
cd backend
alembic revision --autogenerate -m "add_xyz_to_table"

# 3. Review the generated file in alembic/versions/ — check it only does what you intend
# 4. Commit model + migration together
git add core/models/ alembic/versions/
git commit -m "feat: add xyz column to table"
git push origin Dev
# CI runs alembic upgrade head on deploy
```

### Drop or rename a column (destructive — write manually)
```bash
cd backend
alembic revision -m "drop_xyz_from_table"
# Edit the generated file — write upgrade() and downgrade() by hand
# Commit and push — CI applies it
```

### Change non-sensitive config
Edit `backend/.env.server` → commit → push. Applied on next deploy.
Examples: hotel name, scan window days, gap costs, algorithm params.

### Change sensitive config (DB URL, API keys)
These live in GitHub Secrets. You cannot change them from here — escalate to the project owner.

---

## Running locally (hot-reload)

```bash
# Terminal 1 — Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.server .env
# Add to .env:
#   DATABASE_URL=postgresql+asyncpg://user:pass@localhost/occumax
#   GEMINI_API_KEY=your-key
alembic upgrade head
uvicorn main:app --reload --port 8000

# Terminal 2 — Frontend
cd frontend
npm install
echo "VITE_API_URL=http://localhost:8000" > .env.local
npm run dev   # opens http://localhost:5173
```

### What to change to see it live locally

| Change type | What to edit | When visible |
| --- | --- | --- |
| Backend logic/API | Any `backend/**/*.py` | Instantly (uvicorn --reload) |
| Frontend UI | Any `frontend/src/**/*.tsx` | Instantly (Vite HMR) |
| Add DB column | Edit model → `alembic revision --autogenerate` → `alembic upgrade head` | After alembic runs |
| Non-sensitive config | Edit `.env.server` → copy to `.env` → restart uvicorn | After restart |
| Sensitive config | Edit `.env` directly (never commit this file) | After restart |

To deploy to dev server: `git push origin Dev`.

---

## Key rules — never break these

- Never commit `.env` — only `.env.server` (non-sensitive) is tracked
- Never write raw SQL — use SQLAlchemy models + Alembic migrations
- Schema change = model edit + alembic revision + commit (always together)
- Sensitive values (DB URL, API keys) are in GitHub Secrets — never put them in any file
- Always update docs in the same commit as the change
- `Dev` branch = development/testing | `main` branch = production
