---
name: occumax-lead-developer
description: Guides technical leadership on the Occumax hotel revenue recovery platform (FastAPI, React, PostgreSQL): layered architecture, yield and placement algorithms, slot/booking/channel model, KPIs, and hospitality vocabulary. Use when leading Occumax work, reviewing revenue or front-desk features, onboarding senior engineers, or deciding changes to rooms, slots, pricing, OTAs, or analytics.
---

# Occumax — Lead Developer and Hospitality Domain

## What Occumax is (product lens)

Occumax is a **hotel revenue recovery** system: it helps properties **re-pack inventory** (room moves, calendar optimisation), **price nights** with AI assistance, **allocate channel blocks** to OTAs/GDS, and gives staff an **AI receptionist** for availability and revenue context. Treat every feature as touching **perishable inventory** (unsold room-nights cannot be recovered) and **guest operations** (moves must stay coherent and auditable).

## Stack and where work belongs

| Area | Location | Lead expectation |
| --- | --- | --- |
| HTTP surface | `backend/api/` | Thin: validate, call controller, serialize |
| Orchestration | `backend/controllers/` | Business rules, transactions, multi-service flows |
| Domain logic | `backend/services/` (`algorithm/`, `ai/`, `analytics/`) | Pure logic; testable without HTTP |
| Schema | `backend/core/models/` | Source of truth for tables; pair with Alembic |
| API contracts | `backend/core/schemas/` | Pydantic request/response shapes |
| Frontend | `frontend/src/` — `pages/`, `components/`, `api/client.ts`, `types/index.ts` | All HTTP via `api/client.ts` only |
| Migrations | `backend/alembic/versions/` | Review autogenerate carefully; no surprise drops |

Deployments: **git push** to `Dev` (staging) or `main` (production); secrets in GitHub, not in repo. Non-sensitive tunables in `backend/.env.server` (tracked).

## Deep reading (progressive disclosure)

Use these repo docs before large changes:

- `docs/architecture.md` — endpoints, algorithms, **behavioral invariants**
- `docs/contributing.md` — branches, commits, known pitfalls (duplicates critical invariants)
- `docs/deployment.md` — CI/CD and ops
- `CLAUDE.md` — agent-oriented map (same facts; useful quick index)

After **significant** schema, architecture, deploy, or workflow changes, update the matching doc in the **same commit** (see `CLAUDE.md`).

## Hospitality domain — language the product speaks

### Revenue and performance KPIs

- **ADR (average daily rate)**: revenue per occupied room-night; quality of pricing, not volume alone.
- **RevPAR**: revenue per **available** room-night (ADR × occupancy); the headline “did we monetise inventory” metric.
- **Occupancy**: share of rooms sold vs available; Occumax surfaces heatmaps, forecasts, and pace views.
- **Pace / pickup**: how bookings **accumulate over time** before arrival; “strong pickup” = demand building early; weak pickup may justify stimulation (rate, channel, packages).
- **Channel mix**: share of revenue or nights by **OTA**, **GDS**, **direct**, **walk-in**; strategy balances margin (commissions) vs fill.

In code, analytics endpoints expose occupancy forecast, pace, revenue summary, and channel performance (see `docs/architecture.md` tables).

### Distribution and partnerships

- **OTA**: online travel agency (e.g. MakeMyTrip-style partners in the app); typically **high visibility, high commission**.
- **GDS**: global distribution used heavily by corporate/travel-agent flows; different cost profile than OTAs.
- **Direct / walk-in**: highest margin paths; product supports explicit channel and nullable `channel_partner` on slots.

`Slot.channel` and `channel_partner` are first-class; channel allocation can create **SOFT** placeholder bookings for a named partner.

### Inventory model in hotel terms

- **Room / category**: physical key + product tier (economy through suite). Categories drive **substitution** (upsell path) and **split-stay** rules.
- **Room-night / night on the books**: the atomic sellable unit; in Occumax this is represented per room and calendar date via **`Slot`** semantics (including “no row = empty”).
- **Block / restriction**:
  - **HARD**: maintenance, owner use, in-house guest hold — **do not shuffle**; operational immovable.
  - **SOFT**: future reservation or channel hold — **movable** within rules; core to yield recovery.
  - **EMPTY**: available to sell or assign.

### Guest journey concepts

- **Availability check** vs **confirm**: check proposes a plan (including swaps); confirm commits with multi-pass writes — integrity of that split is a **lead-review hotspot**.
- **Split stay**: one logical stay across **2–3 room segments** (same category engine vs flex cross-category); reflects real hotel practice when one room type cannot cover all nights.
- **Shuffle / consolidation**: moving SOFT bookings to reduce **fragmentation** and **orphan gaps** (unsellable short holes between commitments); the product scores outcomes with **HHI-style consolidation** and minimises guest moves where possible.

When reviewing UX or APIs, ask: “Does this mirror how a front office manager thinks about **moves**, **denials**, and **alternates**?”

## Occumax-specific invariants (do not regress)

These are documented in detail in `docs/architecture.md` and `docs/contributing.md`. As a lead, treat violations as merge blockers:

1. **`Booking.is_live` is always false** in current flows — never use it as “active booking” filter; use dates or `created_at`.
2. **Channel cache in multi-pass commits** — cache `channel` / `channel_partner` **before** nulling slot `booking_id` during vacate passes, or attribution breaks.
3. **Missing `Slot` row means EMPTY** — not a data bug; queries and UI must treat absence as available.
4. **`PricingPanel` state** is keyed by `category-date`, not array index — prevents silent mis-association with sorted rows.
5. **`_compute_alternatives`** may return all six categories while some UIs only expose four — known gap; do not “fix” backend by hiding categories without a coordinated product decision.

## Lead workflow checklist

- [ ] Change respects **router → controller → service** boundaries
- [ ] Schema change includes **reviewed Alembic** migration (watch autogenerate DROPs on stale DBs)
- [ ] **Docs** updated if behavior, deploy, or team process changed
- [ ] **Hospitality sanity**: commissions, channel labels, dates (stay span), and staff mental model (desk vs revenue manager)
- [ ] Frontend: new calls only in `api/client.ts`; shared types in `types/index.ts`
- [ ] Tests or manual verification path noted for **booking commit** and **pricing commit** when touched

## Examples — how a lead frames a review comment

- **Product**: “This treats a missing slot as an error; in Occumax absence means **available** — align with `docs/architecture.md`.”
- **Revenue**: “Lowering rate on high-pace dates without guardrails conflicts with **pace-aware** pricing — tie to analytics or constrain the suggestion.”
- **Ops**: “Moving HARD blocks in the optimiser would violate **immovable** maintenance holds — keep HARD out of swap chains.”

## Optional deeper glossary

For extended hospitality definitions (length-of-stay controls, overbooking philosophy, etc.), maintain a team note or extend this skill’s folder with `reference.md` — keep `SKILL.md` under ~500 lines and prefer linking to `docs/architecture.md` for anything version-specific.
