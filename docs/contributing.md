# Contributing

## Branch Strategy

```
main          ← production (protected, PR only)
  └─ Dev      ← integration / staging (auto-deploys to dev server)
       └─ feature/your-feature-name   ← your work
```

1. Branch off `Dev` → `feature/your-feature-name`
2. Open a PR against `Dev`
3. Get at least 1 review
4. Merge → auto-deploys to dev server (161.118.164.30)
5. When `Dev` is stable → PR from `Dev` to `main` → auto-deploys to production

## Commit Style

```
feat: add split-stay flex booking endpoint
fix: correct gap cost calculation for 2-night windows
refactor: extract pricing logic into separate service
docs: update architecture diagram
chore: bump fastapi to 0.116
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

## Backend Changes

- **New route**: add handler in `api/`, orchestration in `controllers/`, logic in `services/`
- **Schema change**: edit `core/models/` → commit → deploy handles it automatically
- **New config**: add to `config.py` + `backend/.env.server` (non-sensitive) or GitHub Secrets (sensitive)

## Frontend Changes

- **New page**: add file in `pages/`, register route in `App.tsx`
- **New API call**: add to `api/client.ts` or a dedicated `api/*.ts` module
- **New type**: add to `types/index.ts`

## Environment Variables

Never commit `.env` files. Non-sensitive config goes in `backend/.env.server` (tracked). Sensitive values go in GitHub Secrets → Settings → Secrets and variables → Actions.

## Running Tests

```bash
# Backend
cd backend
pytest tests/ -v

# Frontend (type check)
cd frontend
npm run build
```
