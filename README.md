# Occumax

Hotel revenue recovery platform — yield optimization, AI-powered pricing, and booking management.

## Environments

| Environment | Branch | URL |
|---|---|---|
| Development | `Dev` | http://161.118.164.30 |
| Production | `main` | http://80.225.202.88 |

Deployments are fully automated via GitHub Actions on push to either branch.

## Project Structure

```
occumax/
├── .github/
│   ├── workflows/          # CI/CD pipelines (deploy-dev, deploy-main)
│   ├── ISSUE_TEMPLATE/     # Bug report & feature request templates
│   └── PULL_REQUEST_TEMPLATE.md
├── backend/                # FastAPI + Python
│   ├── api/                # HTTP route handlers (thin layer)
│   ├── controllers/        # Orchestration & business logic
│   ├── core/
│   │   ├── models/         # SQLAlchemy ORM models (schema source of truth)
│   │   └── schemas/        # Pydantic request/response schemas
│   ├── services/
│   │   ├── ai/             # LangGraph agents (Gemini)
│   │   ├── algorithm/      # Booking placement & optimisation engine
│   │   └── analytics/      # Forecasting & reporting
│   ├── tests/
│   ├── config.py           # All env-configurable settings
│   ├── main.py             # App entrypoint
│   ├── requirements.txt
│   └── .env.server         # Non-sensitive config tracked in git
├── frontend/               # React 19 + Vite + TypeScript
│   ├── src/
│   │   ├── api/            # Axios client
│   │   ├── components/     # Shared & feature components
│   │   ├── pages/          # Route-level views
│   │   ├── types/          # TypeScript definitions
│   │   └── utils/          # Pure utility functions
│   ├── public/
│   └── vite.config.ts
└── docs/                   # Architecture, decisions, runbooks
```

## Getting Started

### Backend
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.server .env          # then add DATABASE_URL and GEMINI_API_KEY
uvicorn main:app --reload
```

### Frontend
```bash
cd frontend
npm install
echo "VITE_API_URL=http://localhost:8000" > .env.local
npm run dev
```

## Schema Changes

Edit the SQLAlchemy models in `backend/core/models/`, commit, and push. The backend calls `create_tables()` on startup which applies changes automatically.

## Configuration Changes

Non-sensitive settings (hotel name, window days, gap costs) live in `backend/.env.server` — tracked in git. Edit and commit to apply to the target environment. Sensitive values (DB URL, API keys) live in GitHub Secrets only.

## Documentation

| Doc | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Request flow, layer responsibilities, schema management |
| [docs/deployment.md](docs/deployment.md) | CI/CD, debugging deploys, updating secrets, server setup |
| [docs/oracle-infrastructure.md](docs/oracle-infrastructure.md) | All Oracle Cloud resource IDs, SSH, networking, CLI commands |
| [docs/contributing.md](docs/contributing.md) | Branch strategy, commit style, team workflow |
| [CLAUDE.md](CLAUDE.md) | Agent guide — read by Claude Code automatically |

## Branch Strategy

- Feature branches → PR against `Dev`
- `Dev` → auto-deploys to dev server on push
- `main` → auto-deploys to production on push
