# Deployment

## How it works

Every push to `Dev` or `main` triggers a GitHub Actions workflow automatically:

1. Builds the React frontend with the correct API URL baked in
2. Pulls the latest code onto the target server
3. Writes the server `.env` from tracked config + secrets
4. Installs Python dependencies
5. Runs `alembic upgrade head` — applies any new migrations
6. Restarts the backend
7. Serves the new frontend build via Nginx
8. Runs a health check — fails the deploy if the backend doesn't respond

You push, it deploys. Nothing else needed.

---

## Environments

| Branch | Server | URL |
| --- | --- | --- |
| `Dev` | Dev server | https://161.118.164.30.nip.io |
| `main` | Production | https://80.225.202.88.nip.io |

---

## Trigger a deploy

```bash
# Deploy to dev
git push origin Dev

# Deploy to production (merge Dev → main first)
git push origin main
```

---

## Check deploy status

```bash
# List recent runs
gh run list --repo niteshsinwar/occumax --limit 5

# Watch a running deploy live
gh run watch <run-id> --repo niteshsinwar/occumax

# Get logs from a failed deploy
gh run view <run-id> --repo niteshsinwar/occumax --log-failed

# Re-run a failed deploy without a new commit
gh run rerun <run-id> --repo niteshsinwar/occumax
```

---

## Test the live environments

```bash
# Health check
curl https://161.118.164.30.nip.io/api/health
curl https://80.225.202.88.nip.io/api/health

# OpenAPI spec (full list of endpoints + request shapes)
curl https://161.118.164.30.nip.io/api/openapi.json
```

---

## Common deploy failures

| Symptom in logs | Cause | Fix |
| --- | --- | --- |
| `alembic.exc.ProgrammingError: type already exists` | DB has tables but no alembic tracking row | Already handled automatically — workflow stamps baseline first |
| `Could not parse SQLAlchemy URL from string ''` | `DATABASE_URL` env var not reaching alembic | Check workflow passes `DATABASE_URL=... alembic upgrade head` |
| `npm ci` fails | `package-lock.json` out of sync | Run `npm install` locally, commit the updated lock file |
| `ModuleNotFoundError` | New dependency not in `requirements.txt` | Add it, commit `requirements.txt` |
| Backend health check times out | Startup crash — bad env var or import error | Check logs: `gh run view <run-id> --log-failed` |

---

## GitHub Secrets

These are injected at deploy time. You cannot read or change them from the repo.

| Secret | Purpose |
| --- | --- |
| `SSH_PRIVATE_KEY` | Server access for CI |
| `DEV_HOST` | Dev server IP |
| `MAIN_HOST` | Production server IP |
| `DEV_DATABASE_URL` | PostgreSQL connection string for dev |
| `MAIN_DATABASE_URL` | PostgreSQL connection string for production |
| `GEMINI_API_KEY` | Google Gemini AI key |
| `GH_TOKEN` | GitHub token used by the server to pull code |

To change a secret value: ask the project owner — it requires GitHub admin access.
