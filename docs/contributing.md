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

---

## Known pitfalls — read before touching these areas

### `Booking.is_live` is always `False`

Every confirmed booking — single or split — is created with `is_live=False`. This field is not set to `True` anywhere in the current flow. **Never query `Booking.is_live == True`** when looking for recent or active bookings; you will always get zero results. Use `created_at`, `check_in`, or `check_out` filters instead.

### Channel attribution in `confirm_booking` — cache before vacating

`confirm_booking` in `controllers/receptionist.py` runs a 3-pass commit: PASS 1 vacates source slots by setting `slot.booking_id = None`. PASS 2 needs the original `channel` / `channel_partner` of each moved booking. Because PASS 1 already nulled the booking_ids, a DB query in PASS 2 (`Slot.booking_id == bid`) returns nothing. The correct pattern — already in place — is to build a `booking_channel_cache` dict in PASS 1 before nulling, then read from it in PASS 2. If you extend any shuffle or swap logic, follow the same pattern.

### Missing Slot rows mean EMPTY, not an error

The DB does not create `Slot` rows for nights that are simply empty. Absence of a Slot for a given `room_id + date` means the room is available. Never treat a missing Slot as unexpected — treat it as `block_type=EMPTY`.

### PricingPanel row state is keyed by `category+date`, not array index

`PricingPanel.tsx` stores Accept/Reject/Override state as `Record<string, RowState>` keyed by `"${category}-${date}"`. The API returns recommendations in arbitrary order; the grouped table re-sorts alphabetically. A flat array would silently apply decisions to the wrong recommendation. Do not refactor this back to an array.

### `_compute_alternatives` returns all 6 categories

The backend's deterministic fallback suggestions (`_compute_alternatives`) can return ECONOMY and PREMIUM rooms. The receptionist front desk form currently only exposes STANDARD, STUDIO, DELUXE, and SUITE in its category picker. This is a known frontend gap — the backend is correct and should stay as-is.
