## UI Decisions (Source of Truth)

This document captures **product-level UI decisions** for Occumax so the app stays consistent as we iterate.

Add new entries as decisions are made. Prefer “what + why + where implemented”.

---

## Global chrome

### Decision: Primary navigation uses dark “OPTIHOST” mockup chrome

- **What**: Top bar background `#1A1512`, subtle bottom border, gold active nav (`occuyellow`), muted link color on idle, pill **Live** with green status dot.
- **Why**: Matches the property-management dashboard reference and reserves `nav.elevated` for the upcoming exogenous-demand strip (Step 2).
- **Where**: Design tokens — `frontend/tailwind.config.js` (`nav.*`), `frontend/src/index.css` (`--nav*`); header markup — `frontend/src/App.tsx`.

### Decision: Overview layout is full-bleed under the header (no white page card)

- **What**: `/dashboard` renders **outside** the padded “white shell” used by Receptionist/Admin. It uses a vertical stack: dark **Exogenous Demand Signals** band (`ExogenousDemandSignals`) → cream **subtab** strip → constrained content column (`max-w-7xl`).
- **Why**: Matches the OPTIHOST mockup and keeps signals visible for every Overview subtab without duplicating them inside tabs.
- **Where**: `frontend/src/App.tsx` (`PageShell` vs bare `main` for `/dashboard`); `frontend/src/pages/Dashboard.tsx`; `frontend/src/components/overview/ExogenousDemandSignals.tsx`.

### Decision: Overview subtabs sync to the URL

- **What**: Subtabs **Dashboard / Occupancy / Pricing / Channels** use `?tab=occupancy` (etc.). Default Dashboard uses a clean path with no `tab` query.
- **Why**: Deep-linking and refresh-safe state for operator workflows.
- **Where**: `frontend/src/pages/Dashboard.tsx` (`useSearchParams`).

### Decision: Shared Overview card chrome (all subtabs)

- **What**: `frontend/src/components/overview/overviewChrome.ts` exports reusable Tailwind bundles (`overviewCardClass`, `overviewCardLgClass`, `overviewInsightBannerClass`, `overviewStackClass`, buttons/badges, etc.) so **Dashboard**, **Pricing**, and **Channels** use the same radii, shadows, and borders as the Occupancy reference.
- **Why**: One coherent OPTIHOST-style system across the four Overview pillars; avoids duplicated long class strings.
- **Where**: `Dashboard.tsx` (Dashboard subtab), `PricingOptimizationTab.tsx`, `ChannelOptimizationTab.tsx`.

---

## Overview page (primary surface)

### Decision: Overview is the main UI entry

- **Surface**: Overview page
- **Why**: Single workspace for revenue recovery pillars and daily operator flow

### Decision: “Exogenous Demand Signals” is the shared top section (all subtabs)

- **Placement**: Top of the Overview page, above the subtab bar and subtab content
- **Purpose**: Provide a shared narrative for demand shifts that every subtab can reference (consistent demo + operator context)
- **Source of truth**: Mock context feed (`frontend/src/mock/contextFeed.ts`)
- **Structure**: 4 sub-sections (always present)
  - **Big Event**
  - **Weather**
  - **Flight / Travel Disruption**
  - **Market**
- **Important**: These demand signals are **not duplicated inside** any individual subtab UI. They are shown **once** at the top of Overview only.

### Decision: Overview has 4 subtabs

- **Tabs**:
  - **Dashboard**
  - **Occupancy**
  - **Pricing**
  - **Channels**

- **Intent**:
  - **Dashboard**: executive / at-a-glance KPIs and action queue (V2 design; live-data-first)
  - **Occupancy**: capacity recovery (inventory healing / shuffle preview + commit)
  - **Pricing**: rate optimization + marginal revenue capture (Smart Clearance)
  - **Channels**: channel mix / partner performance + allocation guidance

---

## Occupancy subtab (to be defined)

### Decision: Predictive constraint layer is the first component in Occupancy

- **Placement**: Occupancy subtab, top-most component after the Occupancy title/intro/actions row
- **Purpose**: Explain *why* the recommended recovery actions (LOS target + shuffle) make sense given demand context
- **Inputs shown in the UI** (three buckets):
  1) **Past 2 years of data**: historical booking records / pace baseline (source = analytics / historical records)
  2) **Exogenous demand signals**: show only the *categories considered* (do not duplicate the Overview “Exogenous Demand Signals” panel)
     - “Considering Weather Pattern, Flight Disruption, Big Events, Market Sentiment”
  3) **Current bookings and demand**: today’s on-books occupancy + LOS histogram / in-window booking patterns

- **Consumption rule (Option B)**: Occupancy consumes **all 4** exogenous signal categories as inputs (Big Event + Weather + Flight/Travel + Market).

### Decision: What we send to AI for Optimal LOS (Predictive constraint layer)

When calculating the recommended LOS using AI, we send:

- **Past 2 years of data** for the selected date range (historical records / baseline)
- **Context event details** from the exogenous demand signals (Weather / Flight disruption / Big events / Market), including:
  - the **detail text**
  - the **factor weight + score** for each signal/factor
- **Current bookings** and derived demand indicators (in-window bookings; LOS distribution / on-books occupancy)

Then we ask the AI to:

- **Recommend the most optimal LOS** for our current date range, with a rationale and confidence.

### Decision: Recovery actions sit between KPI strip and Inventory Heatmap

- **Placement**: After the **six-card KPI row**, immediately before the **Before / After** heatmap pair.
- **Why**: Matches the OPTIHOST mockup reading order (AI insight → key metrics → act → validate in the grid). Functionality unchanged: **Preview Recovery Shuffle**, apply/clear, **Advanced** k-night tools.
- **Behavior**: **Preview Recovery Shuffle** still uses the **AI-recommended LOS** as the target when the occupancy recovery path is enabled (same as before).
- **Where**: `frontend/src/components/overview/OccupancyOptimizationTab.tsx`

### Decision: Occupancy visual system (Step 3 mockup alignment)

- **Predictive constraint layer**: Warm panel (`#FDF7E6`), rounded corners, **Learn more** expands the three input buckets (no duplicate exogenous cards), **Refresh AI insight** as secondary surface button.
- **KPI row**: Six centered metric cards (tonight %, orphan nights, k=2 / k=3 windows, hard-to-fill, MinLOS blocks) with soft shadow and parenthetical sublines.
- **Inventory Heatmap**: Section title + two elevated white panels **Before (live slice)** / **After (preview)**; grids use **`palette="optihost"`** on `HeatmapGrid` (muted gold / blue / terracotta / mint).
- **Where**: `OccupancyOptimizationTab.tsx`, `frontend/src/components/Heatmap/HeatmapGrid.tsx` (`palette` prop).

---

## Dashboard subtab (to be defined)

### Decision: Dashboard is “at-a-glance + prioritized actions”

- **Primary job**: summarize the current operating window and point to the next best action
- **Must remain lightweight**: no deep workflows; those belong in Occupancy / Pricing / Channels

### Decision: Dashboard KPI strip uses the “Top 12” KPIs (from subtabs)

- **What**: The Dashboard shows the same **12 KPI signals** as `docs/kpis.md`, but laid out as **two hero tiles + three grouped columns** (Occumax surfaces/borders — density and grouping inspired by the revenue mock, not cyberpunk styling). The operating window is a **fixed 15-night** slice from the heatmap anchor (capped by API date length) — there is no 1W/2W/3W selector.
- **Why**: The dashboard should reflect what the three execution subtabs already compute (Occupancy, Pricing, Channels), stay **live-data-first**, and put **tonight** and **revenue risk** in front without a flat grid of twelve equal cards.
- **Layout**:
  - **Hero row**: **Tonight occupancy** (heatmap column 0 — large accent typography) with **yester-night** (heatmap anchor − 1 civil day) and **same calendar date prior year** realized occupancy from `GET /analytics/occupancy-forecast` (hotel rollup `occupied_rooms_actual`). Dashboard sends `as_of = max(heatmap anchor, browser UTC date)` so property boards ahead of UTC do not drop “yester-night”; backend loads realized counts for the full requested `[start,end)` slice (aligned with on-books aggregation). Null still means no countable non-EMPTY slots that night (or analytics history not seeded).
  - **Grouped row**: **Inventory gaps** (2×2: orphan nights, orphan gaps, k=2, k=3); **Revenue health** (revenue on books + **sparkline** from per-night on-books revenue sums across the slice, unsold room-nights, OTA gross→net leakage); **Top partners** (top 3 by net $ with paired net ADR + **discounted nights** footer).
- **KPI mapping (12)** — unchanged definitions vs `docs/kpis.md`:
  1) Tonight occupancy % · 2) Orphan nights · 3) Orphan gaps · 4) k=2 windows · 5) k=3 windows · 6) Unsold room-nights · 7) Revenue at risk · 8) Revenue on books · 9) Discounted nights · 10–11) Partner net $ + net ADR (combined column) · 12) OTA leakage.
- **Where**: `frontend/src/pages/Dashboard.tsx` (Dashboard tab KPI block).

### Decision: Dashboard removes secondary analytics panels (Trend / Gap / Channel intelligence)

- **What**: Dashboard no longer shows the three “secondary analytics” panels:
  - Occupancy Trend
  - Gap Analysis
  - Channel Intelligence
- **Why**: Keep Dashboard focused on **Top 12 KPIs + Action Queue**. Detailed analysis (including shuffle before/after review) lives in the Occupancy subtab.
- **Where**: `frontend/src/pages/Dashboard.tsx` (Dashboard tab body).

### Decision: Action Queue is a horizontal strip

- **What**: **Computed from live data** and **Action Queue** sit on one horizontal header row (with separator on `sm+`); action items are **fixed-width cards in a horizontal scroll** row (snap on touch).
- **Why**: Reads as a single “live ops” band and scales when there are multiple actions without stacking the whole page.
- **Where**: `frontend/src/pages/Dashboard.tsx`, `frontend/src/pages/DashboardV2.tsx`.

### Decision: Dashboard consumes Exogenous Demand Signals (but does not display them)

- **Input**: the shared “Exogenous Demand Signals” section at the top of Overview (Big Event / Weather / Flight / Market)
- **Usage** (examples; refine as specified):
  - Adjust action queue language (“flight disruption likely increases last-minute demand”)
  - Re-rank suggested actions (e.g., flight disruption → emphasize Smart Clearance; big event → emphasize floor protection)
  - Provide short narrative context in Dashboard cards (without duplicating the full signal panel)

---

## Pricing subtab (to be defined)

### Decision: Pricing does not render context trigger panels

- **Rule**: Pricing subtab must **not** display any version of the “Exogenous Demand Signals” feed/panel.
- **Reason**: Exogenous Demand Signals are displayed **once** at the top of the Overview page.
- **Allowed**: Pricing may include a short line of text indicating the categories considered (Weather / Flight disruption / Big events / Market sentiment).

### Decision: Pricing layout is single-column

- **Rule**: Remove the two-column “context trigger + logical choice” layout. Pricing content should be a **single-column flow** under the tab header.

### Decision: Smart Clearance recommendations (Pricing) — key UI rules

- **Window alignment**: Smart Clearance scans sandwich nights over a **15-day window** to align with Occupancy’s visible window.
- **No “Target slot” card**: Do not show a separate “Target slot” panel; the detailed opportunities table is the source of truth.
- **Profit Gauge (Estimated)**:
  - Must show **total estimated net profit** summed across all proposed sandwich-night offers in the 15-day window (not a single-slot example).
  - Title should read **“Profit Gauge (Estimated)”**.
  - **Consumption rule (Option B)**: Pricing consumes **all 4** exogenous signal categories as inputs (Big Event + Weather + Flight/Travel + Market).

### Decision: Pricing “Run Analysis” uses context + competitor pricing and focuses on unsold nights

- **UX**: Keep the “Run Analysis” experience (loading sequence, previous-analysis cache, calendar grid, hover tooltip).
- **Inputs**:
  - **Context signals** come from `frontend/src/mock/contextFeed.ts` via the Overview header selections.
  - **Market research (competitor pricing)** comes from `frontend/src/mock/competitorPricing.ts` (demo-only, deterministic by category+date).
- **Scope**: Generate actionable recommendations **only for nights with unsold inventory** (heatmap `block_type === "EMPTY"`), with extra emphasis for **sandwich nights** (empty between two occupied nights).
- **Clearance precedence** (backend `services/pricing/clearance_rules.py`, applied after AI):
  - **Sandwich nights** → minimum ~12% discount vs category BAR.
  - **≤4 days out + unsold + adverse weather** → discount (~10%), even during conference week.
  - **≤4 days out + unsold + event week** → no INCREASE (hold or discount only).
  - **≥7 days out** → AI may hold or increase on compression signals.
- **Explainability**: Calendar cell hover must show the recommendation “why” plus the context signal text and competitor anchor range.

---

## Channels subtab (to be defined)

### Decision: Channels starts with “Strategic Channel Resilience” (Market Radar)

- **Placement**: First section at the top of the Channels subtab
- **Header**: “Strategic Channel Resilience”
- **Subtitle**: “Market Radar monitors US-active OTA partner health. Inventory not assigned to OTA remains Direct Hotel Front Desk selling.”
- **Why**: Demonstrates the ability to protect net margin from partner contagion (downtime / poor sentiment) without violating contract-locked inventory constraints
- **Signal source of truth**: Mock context feed (Market kind) in `frontend/src/mock/contextFeed.ts`
  - Demo scenario: `expedia-24h-downtime` (“Expedia experiencing 1-day API downtime”)
- **Interaction**:
  - Partner Pulse dashboard displays partners with health status rings (Green/Amber/Red)
  - Triggering the mock event turns Expedia **RED**
  - Running Market Radar uses the existing async mock AI scoring (`scoreContextWithAi`) to determine **impact** and whether a **flexible inventory** pivot is needed
- **Constraint rule**: Only flexible inventory is shifted; contract-locked inventory is not modified
- **Where implemented**: `frontend/src/components/overview/ChannelOptimizationTab.tsx`

---

## Layout and navigation guidelines (to be filled)

- **Tab bar placement**:
- **Global page header**:
- **Shared components** (e.g., context feed):
- **Empty/loading/error states**:
- **Data freshness** (refresh behavior):

---

## Visual language guidelines (to be filled)

- **Color semantics** (e.g., green = recoverable/profit, orange = risk, red = failure):
- **Typography** (serif headers vs monospace numbers):
- **Badges/tags** (AI tag usage):

---

## Interaction guidelines (to be filled)

- **Primary CTA per tab**:
- **“Demo mode” behavior** (if applicable):
- **When to show computed values vs placeholders (`—`)**:

---

## Notes / open questions

- (Add items as they come up)
