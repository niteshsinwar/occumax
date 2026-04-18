# Contributing

## Branch Strategy

```
main          ← production (auto-deploys to prod server)
  └─ Dev      ← staging (auto-deploys to dev server)
       └─ feature/your-feature-name   ← your work
```

1. Branch off `Dev` → `feature/your-feature-name`
2. Make changes, commit, push your feature branch
3. Open a PR against `Dev`
4. Get at least 1 review
5. Merge → auto-deploys to dev server and runs all migrations
6. When `Dev` is confirmed stable → PR from `Dev` to `main` → deploys to production

---

## Commit Style

```
feat: add split-stay flex booking endpoint
fix: correct gap cost calculation for 2-night windows
refactor: extract pricing logic into separate service
docs: update architecture doc
chore: bump fastapi version
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

---

## Backend Changes

| Task | Steps |
| --- | --- |
| New route | Add handler in `api/`, orchestration in `controllers/`, logic in `services/` |
| New schema column | Edit `core/models/` → `alembic revision --autogenerate` → review → commit both |
| Drop/rename column | `alembic revision -m "..."` → write migration by hand → commit |
| New config value | Add to `config.py` + `backend/.env.server` (non-sensitive) |
| New dependency | Add to `requirements.txt`, commit |

---

## Frontend Changes

| Task | Steps |
| --- | --- |
| New page | Add file in `pages/`, register route in `App.tsx` |
| New API call | Add to `api/client.ts` |
| New shared type | Add to `types/index.ts` |

---

## Environment Variables

| Kind | Where it lives | How to change |
| --- | --- | --- |
| Non-sensitive (hotel name, algo params) | `backend/.env.server` — committed to git | Edit file, commit, push |
| Sensitive (DB URL, API keys) | GitHub Secrets | Ask the project owner |

Never commit `.env`. It is gitignored and generated at deploy time from `.env.server` + GitHub Secrets.

---

## Verifying your changes

```bash
# Type-check frontend
cd frontend && npm run build

# Run backend tests
cd backend && pytest tests/ -v

# Hit the live dev API after pushing
curl https://161.118.164.30.nip.io/api/health
```
