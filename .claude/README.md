# Claude Code — Project Configuration

Claude Code is the primary agentic development layer for Occumax.

## Project Context

- **Stack**: FastAPI (Python) + React 19 (TypeScript) + PostgreSQL
- **Infra**: Oracle Cloud (Mumbai) — 2 VMs via OCI CLI
- **CI/CD**: GitHub Actions → auto-deploy on push to Dev or main
- **Schema**: SQLAlchemy models in `backend/core/models/` — changes apply on backend restart

## Key Locations

| What | Where |
|---|---|
| Backend entry | `backend/main.py` |
| All settings | `backend/config.py` |
| DB models (schema) | `backend/core/models/` |
| API routes | `backend/api/` |
| Business logic | `backend/controllers/` + `backend/services/` |
| Frontend pages | `frontend/src/pages/` |
| Frontend API calls | `frontend/src/api/client.ts` |
| Non-sensitive config | `backend/.env.server` (tracked in git) |
| CI/CD pipelines | `.github/workflows/` |
| Docs | `docs/` |

## Oracle Infrastructure

- Dev server: `161.118.164.30` (branch: `Dev`)
- Prod server: `80.225.202.88` (branch: `main`)
- SSH key: `~/.ssh/occumax_deploy`
- OCI CLI: configured at `~/.oci/`

## Secrets (GitHub Actions)

Managed via GitHub Secrets — never in code:
`SSH_PRIVATE_KEY`, `DEV_HOST`, `MAIN_HOST`, `DEV_DATABASE_URL`, `MAIN_DATABASE_URL`, `GEMINI_API_KEY`, `GH_TOKEN`
