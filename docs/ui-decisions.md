## UI Decisions (Source of Truth)

This document captures **product-level UI decisions** for Occumax so the app stays consistent as we iterate.

Add new entries as decisions are made. Prefer “what + why + where implemented”.

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
  - **Dashboard**: executive / at-a-glance KPIs and action queue
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

### Decision: Recovery actions follow the Predictive constraint layer

- **Placement**: Immediately below the Predictive constraint layer component
- **Components**:
  - **Preview Recovery Shuffle** (primary)
  - **Advanced actions** (secondary)
- **Behavior**:
  - When **Preview Recovery Shuffle** runs, it should call the recovery algorithm using the **AI-recommended LOS** as the target constraint.
  - The goal is to preview whether the system can optimize/re-pack bookings to manufacture bookable windows under that LOS target.

### Decision: Inventory heatmap + KPI sections remain unchanged

- **Scope**: Occupancy subtab sections below the recovery actions
- **Rule**: The existing **KPI strip** and **inventory heatmap (before/after)** sections remain **as-is** (no layout or metric changes) while we iterate on the Predictive constraint layer and recovery actions ordering.

---

## Dashboard subtab (to be defined)

### Decision: Dashboard is “at-a-glance + prioritized actions”

- **Primary job**: summarize the current operating window and point to the next best action
- **Must remain lightweight**: no deep workflows; those belong in Occupancy / Pricing / Channels

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

