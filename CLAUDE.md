# Occumax — Agent Guide (CLAUDE.md)

Auto-loaded by Claude Code every session. Gives full context to operate autonomously.

---

## AGENT RULE: Update docs after every change

After making any significant change, update the relevant doc before closing the task:
- New infra resource added → update `docs/oracle-infrastructure.md`
- Deploy process changed → update `docs/deployment.md`
- Schema or architecture changed → update `docs/architecture.md`
- New workflow or team rule → update `docs/contributing.md`
- This file needs updating → update `CLAUDE.md`

Commit doc updates in the same commit as the change, not after.

---

## Two-tier agent access model

### Tier 1 — Infra Agent (primary, user's machine)
Has: OCI CLI + SSH key + GitHub repo access
Can do everything: create/terminate Oracle instances, manage networking, deploy, fix infra, update secrets.
OCI config: `~/.oci/` | SSH key: `~/.ssh/occumax_deploy`

### Tier 2 — Dev Agent (developer machine)
Has: GitHub repo access only (no OCI CLI, no SSH key)
Can do: code changes, schema migrations, config changes, trigger deploys via git push.
Cannot do: directly touch Oracle servers, manage infra, SSH in.

**For Tier 2 agents — everything goes through git:**
- Schema change → edit model → `alembic revision --autogenerate -m "description"` → commit migration → push → CI applies it
- Config change → edit `backend/.env.server` → commit → push
- Backend change → edit code → push → CI deploys
- Cannot fix a broken server — escalate to Tier 1 (infra agent)

---

## What this project is

Hotel revenue recovery platform. FastAPI (Python) backend + React 19 (TypeScript) frontend.
Deployed on 2 Oracle Cloud VMs. CI/CD via GitHub Actions on every push.

---

## Read these docs for specific tasks

| Task | Doc |
|---|---|
| Infra — Oracle instances, networking, SSH, CLI commands | `docs/oracle-infrastructure.md` |
| Deployment — CI/CD flow, debugging, secret updates, server setup | `docs/deployment.md` |
| Backend/schema/architecture | `docs/architecture.md` |
| Team workflow, branching, commits | `docs/contributing.md` |

---

## Where things live

### Backend (`backend/`)
| Thing | Location |
|---|---|
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
| Migration config | `alembic.ini` + `alembic/env.py` |

### Frontend (`frontend/src/`)
| Thing | Location |
|---|---|
| Route-level pages | `pages/` |
| Reusable UI components | `components/` |
| All HTTP calls (single axios instance) | `api/client.ts` |
| Shared TypeScript types | `types/index.ts` |
| Pure utility functions | `utils/` |
| App shell + routing | `App.tsx` |

### CI/CD (`.github/workflows/`)
| File | Triggers on |
|---|---|
| `deploy-dev.yml` | push to `Dev` |
| `deploy-main.yml` | push to `main` |

---

## Environments

| Env | Branch | IP | URL |
|---|---|---|---|
| Development | `Dev` | `161.118.164.30` | http://161.118.164.30 |
| Production | `main` | `80.225.202.88` | http://80.225.202.88 |

SSH (Tier 1 only): `ssh -i ~/.ssh/occumax_deploy ubuntu@<IP>`

---

## Schema changes — how to do them

### Additive (add table or column) — safe, auto-detected
```bash
# 1. Edit backend/core/models/<model>.py
# 2. Generate migration
cd backend
alembic revision --autogenerate -m "add_column_xyz_to_bookings"
# 3. Review the generated file in alembic/versions/
# 4. Commit migration file + model change together
git add core/models/ alembic/versions/
git commit -m "feat: add xyz column to bookings"
git push origin Dev
# CI runs alembic upgrade head automatically on deploy
```

### Destructive (rename/drop column or table) — requires manual migration
```bash
cd backend
alembic revision -m "rename_old_to_new_in_rooms"
# Edit the generated file manually — write upgrade() and downgrade() by hand
# Then commit and push — CI applies it
```

### Emergency: roll back last migration on server (Tier 1 only)
```bash
ssh -i ~/.ssh/occumax_deploy ubuntu@161.118.164.30
cd /opt/occumax/backend
/opt/occumax/venv/bin/alembic downgrade -1
sudo systemctl restart occumax-backend
```

### Check current migration state on server
```bash
ssh -i ~/.ssh/occumax_deploy ubuntu@<IP> \
  "cd /opt/occumax/backend && /opt/occumax/venv/bin/alembic current"
```

---

## Config changes

**Non-sensitive** (hotel name, window days, gap costs, algorithm params):
Edit `backend/.env.server` → commit → push. Applied on next deploy.

**Sensitive** (DB URL, Gemini API key, SSH key):
Update GitHub Secret. See `docs/deployment.md#updating-github-secrets` for the script.

---

## Running locally

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.server .env
# Add to .env: DATABASE_URL=postgresql+asyncpg://... and GEMINI_API_KEY=...
alembic upgrade head        # apply migrations to local DB
uvicorn main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install
echo "VITE_API_URL=http://localhost:8000" > .env.local
npm run dev
```

---

## Key rules — never break these

- Never commit `.env` — only `.env.server` (non-sensitive) is tracked
- Never edit server files manually — all changes via git commits
- Never write raw SQL — use SQLAlchemy models + Alembic migrations
- Schema change = model edit + alembic revision + commit (always together)
- Sensitive values = GitHub Secrets only, never in any file
- Always update docs in the same commit as the change
- `Dev` branch = development/testing | `main` branch = production
- Tier 2 agents: no direct server access — everything through git push
