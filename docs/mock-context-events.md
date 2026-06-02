## Mock Context Events — Source of Truth

This doc defines **which mock “context feed” events** (weather / flights / market / conferences) are used by the **Overview page** and **subtabs** and **where they live in code**.

### Single source of truth (data)

- **Dataset**: `frontend/src/mock/contextFeed.ts`
  - `contextFeed`: list of shared mock events (with factor `score` + `weight`)
  - `computeCompositeScore(...)`: weighted composite score helper
  - `getPrimaryShockTrigger()`: the default “ALERT” item for demo flows

- **Mock AI scorer (async + cached in UI)**: `frontend/src/mock/aiContextScoring.ts`
  - `scoreContextWithAi({ item })`: returns adjusted factor scores/weights + rationale + confidence

### Shared UI component (rendering)

- **Component**: `frontend/src/components/shared/ContextFeedPanel.tsx`
  - Renders the same `contextFeed` list with factor-level weights/scores and a composite score.

---

## Which events are used where

### Overview shared header — “Exogenous Demand Signals”

- **Uses**: the shared `contextFeed` as the single source of mock signals
- **Display**: shown **once** at the top of the Overview page (not duplicated in subtabs)
- **Sections**: Big Event · Weather · Flight/Travel Disruption · Market

### Pricing subtab — Pillar 2 “Marginal Revenue Capture”

- **Uses**: the shared Overview “Exogenous Demand Signals” context (no in-tab feed/panel)
- **UI**: `frontend/src/components/overview/PricingOptimizationTab.tsx`
  - Clicking **Run Smart Clearance** triggers `scoreContextWithAi(...)` and recalculates offers across **all sandwich nights**
  - Pricing may show a short “Considering weather/flight/events/market” line, but does not duplicate the panel
  - Sandwich-night scan window is **15 days** (aligned to Occupancy window)
  - Profit Gauge is **Profit Gauge (Estimated)** and reflects **total estimated net profit** across all proposed sandwich-night offers
  - **Option B**: Pricing consumes **all 4** exogenous signal categories (Big Event + Weather + Flight/Travel + Market) together as a bundle.

**Expected event types** used in Pricing:
- **FLIGHT**: disruption context; near-term unsold clearance still driven by lead time + inventory rules
- **WEATHER**: adverse forecast → near-term unsold nights discount (overrides event compression)
- **EVENT**: compression on **sold** nights; **unsold** nights this week still clear at discount (see `backend/services/pricing/clearance_rules.py`)
- **MARKET**: elasticity / channel-risk signal → tunes narrative; deterministic clearance rules apply after AI

### Occupancy subtab — “Capacity recovery workspace”

- **Uses**: the same shared `contextFeed`
- **UI**: `frontend/src/components/overview/OccupancyOptimizationTab.tsx`
  - Currently displayed as a shared narrative panel (“Exogenous context feed”)
  - Should remain consistent with Pricing so demos tell one coherent story

#### Note: Predictive Constraint Layer (Optimal LOS)

- **Does NOT use** `contextFeed` values today (implementation status).
- **Source**: backend call `dashboardPredictOptimalLos(...)` (via `useOccupancyPredictiveLos`).
- **UI**: `frontend/src/components/overview/OccupancyOptimizationTab.tsx`
  - The Optimal LOS recommendation is produced by the backend endpoint.
  - The UI may list the *types* of exogenous signals considered (Weather / Flight Disruption / Big Events / Market Sentiment), but it should **not duplicate** the full Overview “Exogenous Demand Signals” panel.

**Intended AI inputs** for Optimal LOS (what the backend should send):

- Past 2 years of historical data for the selected date range
- Exogenous demand signal details (from the shared context feed concept), including factor **weights + scores**
- Current bookings and demand context (in-window bookings, on-books occupancy, LOS distribution)

**AI task**:
- Recommend the most optimal LOS for the date range, with rationale + confidence.

### Dashboard subtab

- **Does not render** the `contextFeed` panel (signals appear only in the shared Overview header)
- **May use** the selected/active signals to:
  - shape narrative copy
  - re-rank action recommendations
  - explain why certain metrics are highlighted

### Channels subtab — “Strategic Channel Resilience”

- **Uses**: the shared `contextFeed` as the single source of mock “social sentiment/news” signals (Market kind)
- **Demo trigger**: `expedia-24h-downtime` (Market) simulates partner-risk conditions via market/news sentiment
- **UI**: `frontend/src/components/overview/ChannelOptimizationTab.tsx`
  - Partner Pulse renders partners with health rings
  - A mock scenario can set Expedia → **RED**
  - Market Radar action runs `scoreContextWithAi({ item })` and recommends whether to pivot **flexible inventory** away from the high-risk partner

---

## Editing rules (to avoid drift)

- **Do not** hardcode event strings in components (tabs/pages).
- **Only update** event titles/details/factors in `frontend/src/mock/contextFeed.ts`.
- If you add a new event:
  - include factor `score` + `weight` per factor
  - verify it renders in `ContextFeedPanel`
  - confirm Pricing simulation still runs and Occupancy still displays the same feed
