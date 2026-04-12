# Occumax — Solution Design Document
**Version:** 0.1 (Internal Review Draft)  
**Status:** For Senior Review  
**Date:** April 2026

---

## 1. Problem Statement

A hotel's revenue is silently eroded by fragmented availability — orphan nights that cannot be sold because they sit between booked blocks, channels that hold inventory that will never convert, and pricing that does not react to demand signals. Receptionists have no decision support when a guest requests a room that appears unavailable. Managers have no systematic tool to consolidate gaps before they expire unsold.

Occumax solves this across three layers:
- **Operational** — defragment the availability calendar in real time
- **Transactional** — assist the receptionist in finding the best placement for every new booking request
- **Commercial** — surface pricing and discount recommendations driven by demand signals

---

## 2. System Scope

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OCCUMAX PLATFORM                                                           │
│                                                                             │
│   Manager Dashboard          Receptionist Terminal       Admin Panel        │
│   ─────────────────          ─────────────────────       ───────────        │
│   Heatmap (4-colour)         Booking Request Flow        Room/Rate Mgmt     │
│   Optimization trigger       Shuffle + AI Fallback       Channel Config     │
│   Recommendation queue       Preference constraints      Price Overrides    │
│   Approve / Reject / Modify  Booking confirmation                           │
│                                                                             │
│   ─────────────────────────────────────────────────────────────────────     │
│   CORE ENGINE                                                               │
│                                                                             │
│   Gap Detection  →  Shuffle Algorithm  →  Recommendation Generator         │
│   (HHI scoring)     (constraint-aware)    (Gemini AI + programmatic)       │
│                                                                             │
│   Channel Inventory Manager   Pricing Engine   Predictive Discount Engine  │
│                                                                             │
│   ─────────────────────────────────────────────────────────────────────     │
│   DATA LAYER                                                                │
│   PostgreSQL (slots / bookings / rooms / channels / recommendations)        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Heatmap Block Taxonomy (4-Colour System)

| Colour | State | Label | Definition |
|--------|-------|-------|------------|
| 🟢 Green | `EMPTY` | Available | Room is free and sellable |
| 🔵 Blue | `SOFT` | Tentatively booked | Guest has a confirmed booking but has not yet checked in — movable within category under algorithm control |
| 🔴 Red | `HARD` | Occupied / Maintenance | Guest is checked in, or room is under maintenance — **immovable under all conditions** |
| 🟣 Purple | `CHANNEL` | Channel-allocated | Slot is committed to an OTA, agent, or channel partner — not available for direct sale, requires channel coordination to release |

**Column invariant (critical rule):** For any given date and room category, the total count of SOFT + CHANNEL + HARD blocks never changes as a result of optimisation. Optimisation only moves SOFT blocks vertically between rooms of the same category. It never creates or destroys bookings.

---

## 4. Trigger Architecture

### 4.1 Trigger 1 — Calendar Optimisation (T1)

**When it fires:**
- Scheduled: daily at checkout time (11:00 AM by default), after rooms are cleared
- Manual: manager clicks "Run Optimization" on the dashboard
- Event-driven: on a cancellation (immediate re-evaluation of the freed window)

**What it does:**
1. Load all slots for the planning horizon (configurable, default 30 days)
2. Run the Gap Detection + HHI Local Search per category
3. Generate Recommendation objects (SHUFFLE / REPRICE / CHANNEL / DISCOUNT)
4. Stream recommendations to the manager dashboard in real time via WebSocket
5. Manager reviews the Before/After preview heatmap and approves, modifies, or rejects

**Current implementation:** Manual trigger only (scheduled trigger deferred to next phase — see Open Questions §10.3).

### 4.2 Trigger 2 — Booking Request (T2)

**When it fires:** A guest or receptionist submits a booking request (category + date range).

**What it does:**
1. ShuffleEngine scans the category for the best available room
2. If no direct slot → attempt to make one available by moving SOFT bookings
3. Score all feasible placements by fragmentation cost (anti-fragmentation scoring)
4. If no solution found → invoke Agentic AI fallback (see §7)
5. Receptionist confirms → DB written atomically

---

## 5. Deterministic Optimisation Algorithm (T1)

### 5.1 Gap Detection

A gap is flagged when a run of EMPTY nights in a room is:
- **ORPHAN:** SOFT/HARD blocks on both sides
- **NEAR-ORPHAN:** SOFT/HARD block on one side, run length ≤ MAX_GAP_NIGHTS (5)

Gaps are scored by urgency (days until gap starts) and extended sellable length after proposed shuffle.

### 5.2 HHI-Based Local Search

For each category, the algorithm maximises the Herfindahl-Hirschman Index of empty run lengths across all rooms: **Σ(run_length²)**. Higher HHI = better consolidation (fewer isolated gaps).

Two-phase per iteration:
1. **Evacuation pass** — try to fully empty the most fragmented room (move all its bookings out)
2. **Local search pass** — find the single-booking vertical move with highest HHI delta

Terminates when neither phase finds an improvement (local optimum). Proved to converge in finite steps — each move strictly increases the bounded score.

### 5.3 Anti-Fragmentation Room Selection (T2)

When placing a new booking, score every feasible room by the orphan gap cost it would create:

| Gap left adjacent to booking | Cost |
|-------------------------------|------|
| 0 nights (touches another block) | 0 |
| 1 night | 100 |
| 2 nights | 40 |
| 3 nights | 10 |
| 4+ nights | 5 |

The room with the lowest total cost (left + right gap) is selected.

---

## 6. Constraint & Preference Layer

This is the layer that sits **on top of** the shuffle engine and filters which moves are eligible. Without it, the algorithm is purely HHI-optimal but commercially incorrect.

### 6.1 Hard Constraints (Must-Honour)

| Constraint | Description | Implementation note |
|------------|-------------|---------------------|
| Room category | Shuffle only within same category (STANDARD↔STANDARD etc.) | Enforced in engine today |
| Accessibility | Rooms flagged as wheelchair-accessible must not be assigned to non-accessible bookings, and vice versa | Needs `is_accessible` flag on Room model |
| Bed type | King / Twin / Double — a guest who booked a King must land in a King | Needs `bed_type` field on Room + Booking |
| Booking atomicity | A single booking_id's entire stay must be in one room | Enforced today via `_build_booking_map` |
| HARD block immovability | Checked-in or maintenance slots cannot move | Enforced today |

### 6.2 Soft Constraints (Best-Effort, Tie-Break)

| Constraint | Description | Implementation note |
|------------|-------------|---------------------|
| Floor preference | Guest prefers floor 3 — optimiser should try to honour, not block on | Add `preferred_floor` to Booking; score penalty if violated |
| Group adjacency | Two or more bookings travelling together want adjacent room numbers | Needs `group_id` on Booking; adjacency scoring in placement cost |
| View preference | Sea view / courtyard — room attribute + booking preference | Needs `view_type` on Room |
| Channel preference | Some OTA contracts require specific room tiers | Handled via channel-room mapping (§8) |

**Soft constraint scoring:** Each violated soft constraint adds a configurable penalty to the fragmentation cost. The algorithm still finds a room; it just avoids the penalty when possible.

### 6.3 Constraint Open Questions — See §10.1

---

## 7. Agentic AI Fallback (T2 — When Booking Cannot Be Accommodated)

When the deterministic shuffle engine returns `NOT_POSSIBLE` for a booking request, a Gemini-powered agent is invoked to generate human-readable alternatives.

### 7.1 Fallback Strategies (in priority order)

```
1. Date Adjustment       — "Can you shift check-in by 1 day? Room X is free Apr 10–14."
2. Category Upgrade      — "No STANDARD available, but a DELUXE is free at +₹800/night."
3. Category Downgrade    — "A STANDARD is available if you're flexible on room tier."
4. Split-Stay            — "Stay in Room A for nights 1–3, move to Room B for nights 4–6."
         ⚠ This requires guest consent and explicit UI confirmation.
         ⚠ Only surfaced if the gap between segments is 0 nights.
5. Waitlist              — "This combination becomes available if booking BK-XXX cancels."
```

### 7.2 Agent Design

- Input to agent: booking request + list of alternatives computed deterministically
- Agent formats the output as a natural-language message for the receptionist UI
- Agent does NOT write to the DB — it only suggests; the receptionist confirms
- Fallback to programmatic formatting if Gemini is unavailable

### 7.3 Multi-Guest Group Handling

When a group of N rooms is requested (same or adjacent rooms, same dates):
- Engine evaluates all N rooms simultaneously as a constraint-satisfaction problem
- If full group cannot be placed: agent proposes partial group placement + alternatives for remaining guests
- Group atomicity flag: manager can mark a group as "must place together or not at all"

---

## 8. Channel-Wise Inventory Blocking

### 8.1 Model

A `ChannelBlock` represents a commitment of one or more rooms to a specific distribution channel for a date range.

```
ChannelBlock {
  room_id        : string          # specific room, or null (category-level)
  category       : RoomCategory    # if room_id is null
  channel        : Channel         # OTA | GDS | DIRECT | WALKIN | CLOSED
  start_date     : date
  end_date       : date
  quantity       : int             # for category-level blocks
  release_policy : HARD | SOFT     # HARD = never release; SOFT = release if unsold N days before
  release_days   : int             # for SOFT policy: release back N days before check-in
}
```

### 8.2 Heatmap Representation

Channel-blocked slots render as **Purple** (🟣). In the optimisation algorithm:
- `CHANNEL` blocks are treated as **HARD** for shuffle purposes — they cannot be moved
- The Recommendation engine can generate `CHANNEL` type recommendations suggesting releasing a block early (if release_policy = SOFT and the date is within release window)

### 8.3 Channel Allocation Workflow

```
Admin sets channel block → slots marked CHANNEL → visible in heatmap as purple
              ↓
If release policy = SOFT and unsold N days before:
  System generates CHANNEL recommendation → manager approves → slot reopens as EMPTY
              ↓
If OTA books the slot → slot transitions CHANNEL → HARD (guest checked in eventually)
```

### 8.4 Open Questions — See §10.4

---

## 9. Pricing, Discount & Revenue Optimisation

> **Current scope:** No automated pricing writes. The engine generates recommendations for human approval. Discount logic is the priority exploration area.

### 9.1 Reprice Recommendations (REPRICE)

Generated when a gap exists but no shuffle is possible. Suggests a price reduction to improve the fill probability.

Formula currently implemented:
```
fill_probability(gap_length, days_until_gap, base_occ%, channel_occ%)
estimated_recovery = P(fill) × rate × gap_length
```

Threshold: only surface a REPRICE if the expected recovery exceeds a minimum viable amount (configurable).

### 9.2 Discount Engine (Explore Phase)

**Scenario A — Isolated orphan night**
If a single-night gap has no adjacent empty slots, the probability of organic fill is ~12%. A discount deepens below competitors to capture last-minute demand.

```
Proposed discount = f(days_until_gap, competitor_avg_rate, P(fill_at_base_rate))
```

**Scenario B — Event-driven surge**
If nearby competitors have raised prices (scraping or manual input), Occumax can flag rooms that are priced below market, suggesting a rate increase.

**Scenario C — Cancellation window**
2-day cancellation look-ahead: if a booking is likely to cancel (based on historical no-show rate for that channel/lead-time), pre-generate the gap's discount recommendation proactively.

**Scenario D — Group discount**
If a group of N rooms is booked together, the yield loss from fragmentation is lower per room. Offer a volume discount while still protecting HHI.

### 9.3 Predictive Cancel Signal (Future Phase)

```
Input features:
  - Lead time (days from booking to check-in)
  - Channel (OTA cancel rates > DIRECT)
  - Historical no-show rate for that guest profile
  - Booking amendment history
  - Local event calendar

Output:
  - P(cancel) per booking
  - If P(cancel) > threshold → surface as "At Risk" in heatmap
  - Pre-generate discount/alternative recommendation for that slot
```

---

## 10. Open Questions (Granular)

### 10.1 Constraint & Preference Layer

| # | Question | Impact |
|---|----------|--------|
| OQ-1 | Do bed type and accessibility live on the Room record (fixed) or can they be reconfigured per booking? e.g. can a King room be configured as Twin on request? | Changes Room model design |
| OQ-2 | If a guest has a floor preference and no room on that floor is available, does the receptionist override the preference (with consent) or is the booking refused? Who makes that call — system or human? | Determines if floor preference is hard or soft |
| OQ-3 | For group adjacency: does "adjacent" mean same floor / consecutive room numbers / connected rooms? Hotel-specific definition needed. | Adjacency scoring model |
| OQ-4 | If a guest with accessibility requirements is being shuffled by the algorithm (their SOFT block is being moved), can the algorithm ever move them to a non-accessible room? | Hard vs soft constraint classification |
| OQ-5 | How are preferences captured — at booking creation, or pulled from a guest profile / PMS integration? | Data model + integration scope |
| OQ-6 | What happens when two guests in the same group have conflicting preferences (one wants floor 3, one wants floor 5)? | Group preference resolution policy |

### 10.2 Algorithm & Optimisation

| # | Question | Impact |
|---|----------|--------|
| OQ-7 | Should the optimisation run per-category independently, or should there be cross-category awareness (e.g. upgrade a STANDARD guest to DELUXE to consolidate STANDARD)? | Major algorithm scope change |
| OQ-8 | The current local optimum is HHI-greedy. Should there be a global constraint such as "never move a guest who checked in more than X days ago" (to avoid repeat room changes for long-stay guests)? | Adds `is_long_stay` flag + move filter |
| OQ-9 | What is the maximum number of times the same booking should be shuffled across separate optimisation cycles? Should there be a "shuffle count" cap per booking? | Booking model + algorithm gate |
| OQ-10 | If the algorithm converges to a local optimum but a global optimum exists via a 2-swap (two simultaneous moves that neither improves alone), should we explore 2-opt? | Significant complexity increase |
| OQ-11 | How is the planning horizon set? 30 days is current. Should it be dynamic based on the hotel's booking lead time? | Config + performance |

### 10.3 Scheduling & Triggers

| # | Question | Impact |
|---|----------|--------|
| OQ-12 | Scheduled optimisation at checkout time — does this mean 11:00 AM daily, or immediately after each individual checkout is recorded in the PMS? | Event source design |
| OQ-13 | If the manager does not act on recommendations from a scheduled run, should the system auto-expire them? What is the TTL? | Recommendation lifecycle model |
| OQ-14 | Can two managers approve different recommendations simultaneously and create a conflict? Should recommendations be locked when under review? | Concurrency / optimistic locking |
| OQ-15 | Should there be a dry-run mode where the system computes the post-approval state but shows it to the manager without writing to the DB? (Currently implemented as preview.) | Already in scope — confirm as final design |

### 10.4 Channel Inventory

| # | Question | Impact |
|---|----------|--------|
| OQ-16 | Is channel inventory managed at the room level (specific room 101 is on Booking.com) or at the category level (3 STANDARD rooms are on Booking.com, any 3)? | Fundamental model decision |
| OQ-17 | When an OTA makes a booking against a channel-allocated slot, does the booking arrive via a PMS/channel manager API, or is it entered manually? | Integration scope |
| OQ-18 | What is the release lead time for SOFT channel blocks? E.g. if a room is allocated to an OTA and unsold 3 days before check-in, can the system auto-release it? | Revenue policy decision |
| OQ-19 | Should channel blocks be visible to the receptionist as "unavailable" (as today's Purple), or should they see the underlying booking (OTA guest name) once confirmed? | UI/UX + data access |
| OQ-20 | Is there a priority hierarchy between channels? (E.g. direct bookings override OTA channel blocks under certain conditions?) | Channel conflict resolution policy |

### 10.5 Discount & Pricing

| # | Question | Impact |
|---|----------|--------|
| OQ-21 | Who sets the discount floor — the manager manually, or a hotel-level policy? Is there a minimum rate below which the system cannot go? | Pricing governance |
| OQ-22 | Are competitor rates sourced from a scraping service, a manual input, or a third-party API (OTA Insight, RateGain, etc.)? | Integration scope |
| OQ-23 | For 2-day cancellation prediction, is there a historical dataset of bookings + actual no-show outcomes available, or does the model start cold? | ML feasibility |
| OQ-24 | Should discounts be channel-specific (e.g. OTA coupon vs direct website discount) or room-level? | Discount model design |
| OQ-25 | If a discount is applied and the room fills, how is the revenue attribution tracked (was it the discount that drove the booking, or organic demand)? | Analytics / reporting |

### 10.6 Hosting & Deployment

| # | Question | Impact |
|---|----------|--------|
| OQ-26 | Is this a SaaS product (multi-tenant, one deployment serving N hotels) or a single-hotel on-premise/private-cloud deployment? | Entire infra architecture |
| OQ-27 | What is the data residency requirement? Guest data (names, booking IDs) may fall under local privacy laws (India: DPDP Act, EU: GDPR). | Hosting region selection |
| OQ-28 | What is the expected concurrent user count? (Managers + receptionists per property, number of properties.) | Compute sizing |
| OQ-29 | Is a managed Postgres service acceptable (RDS / Supabase / Neon) or does the hotel require on-premise DB? | DB hosting decision |
| OQ-30 | Should the WebSocket real-time feed be replaced with polling for environments where WS is unreliable (e.g. hotel lobby network)? | Connectivity assumption |

---

## 11. Real-World Hotel Scenarios — What Receptionists & Managers Face Daily

These are the ground-truth operational scenarios that existing software partially handles but no system solves end-to-end. This section documents each scenario, how hotels manage it today, and how the platform addresses or will address it.

### 11.1 Overbooking & Room Walking

**Scenario:** Hotel sold 80 rooms, 82 guests arrive. Two guests must be "walked" to another property.

**How hotels handle it today:**
- Front desk identifies lowest-value or last-arriving reservations to walk
- Manually arranges a room at a nearby hotel, pays for transport, covers first-night cost
- Decision is based on receptionist judgment — no systematic scoring

**What's missing:** A ranked walk-candidate list based on booking value, loyalty tier, channel margin, and arrival probability. Proactive identification before arrival, not at the desk.

**How this platform addresses it:**
- Predictive cancel model (Phase 3) reduces need to walk by predicting no-shows with accuracy
- T1 optimisation reduces fragmentation, creating buffer capacity
- Booking value scoring can rank walk candidates (Phase 2)

---

### 11.2 Orphan Nights (Isolated Single/Double Empty Nights)

**Scenario:** Room 201 is booked Apr 8–10 and Apr 12–15. April 11 is a single empty night no guest will book for one night.

**How hotels handle it today:**
- Most hotels don't systematically detect this — it shows up as unsold inventory
- Some revenue managers manually scan the calendar weekly
- Some use RMS (Duetto, IDeaS) for pricing signals but these tools do not rearrange bookings

**What's missing:** Automated detection + algorithmic consolidation. No existing PMS or RMS moves bookings to eliminate orphans — they only price around them.

**How this platform addresses it:**
- Gap Detection algorithm flags orphan nights in real time
- HHI Local Search moves SOFT blocks to consolidate empty runs
- Anti-fragmentation scoring prevents new orphans on booking creation (T2)

---

### 11.3 New Booking Can't Be Placed — Guest Asks "Is There Anything?"

**Scenario:** Guest calls: "I need a Standard room April 9–13." Dashboard shows no EMPTY Standard slots for those exact 5 nights. Receptionist: "Sorry, fully booked."

**How hotels handle it today:**
- Receptionist manually checks PMS grid, sees it's full, offers nothing
- No system tries to rearrange existing movable bookings to create the needed slot
- Upgrade to Deluxe suggested only if receptionist thinks of it

**What's missing:** A real-time "can we make room for this guest?" engine that attempts to shuffle existing bookings.

**How this platform addresses it:**
- T2 ShuffleEngine attempts to create the slot by moving SOFT blocks within the same category
- If impossible: Agentic AI fallback suggests date shift (+1/−1 day), upgrade, downgrade, split-stay
- Receptionist sees natural-language suggestions, confirms with one click

---

### 11.4 Group Booking (10 Rooms, Same Dates, Adjacent Floors)

**Scenario:** Tour operator books 10 Standard rooms, Apr 15–18, wants them all on Floor 3.

**How hotels handle it today:**
- Revenue manager manually checks availability across the category
- Assigns rooms one by one, trying to cluster by floor
- If 10 adjacent rooms not available: offers alternatives verbally

**What's missing:** Automated group placement that simultaneously evaluates N rooms with soft constraints (floor adjacency) and HHI impact.

**How this platform addresses it:**
- Group booking support (Phase 2): constraint-satisfaction across N rooms
- Soft constraint scoring penalises floor dispersion
- Group atomicity flag: "all 10 or none"
- Agentic AI proposes partial placement + alternatives if full group can't fit

---

### 11.5 Channel Over-Allocation (OTA Holds Inventory That Will Not Convert)

**Scenario:** 5 Standard rooms are committed to Booking.com for Apr 10–15. It's now Apr 8 and all 5 are still unsold on that channel.

**How hotels handle it today:**
- Channel manager (SiteMinder, Cloudbeds) shows allocation per channel
- Revenue manager manually decides whether to release back to general inventory
- No systematic policy — decision is ad hoc and often too late

**What's missing:** Automated release policy with configurable lead-time thresholds + heatmap visibility of channel-held inventory.

**How this platform addresses it:**
- Purple (CHANNEL) blocks show channel commitments in real time
- SOFT release policy: system generates CHANNEL recommendation 3 days before check-in if slot is unsold
- Manager approves release with one click → slot becomes EMPTY + sellable

---

### 11.6 Long-Stay Guest Mid-Shuffle (Booking Atomicity)

**Scenario:** Guest booked Room 301 for 12 nights (Apr 8–19). Optimiser wants to move a 3-night booking out of 301 to create a contiguous block. But 301 is already occupied by the long-stay guest.

**How hotels handle it today:**
- Not applicable — no system attempts this kind of calendar optimisation

**What's missing:** Booking atomicity enforcement — the guest's entire 12-night stay must be treated as a single indivisible unit during any shuffle attempt.

**How this platform addresses it:**
- `_build_booking_map` tracks each booking_id as a frozenset of dates + single room
- No shuffle step is generated that would split a booking across rooms
- HARD-blocked (checked-in) rooms are immovable under all conditions

---

### 11.7 Maintenance Block Appearing Mid-Stay Window

**Scenario:** Housekeeping marks Room 405 as under maintenance Apr 11–12 (pipe burst). Two SOFT bookings are scheduled for Apr 10–13 in that room.

**How hotels handle it today:**
- Receptionist manually moves bookings to other rooms
- No system checks whether the destination room creates new fragmentation
- High risk of creating orphan nights in the destination

**How this platform addresses it:**
- Maintenance block marked as HARD → immovable
- T1 triggered by the cancellation/block creation event (Phase 1 scheduler)
- Evacuation pass attempts to move SOFT bookings out of 405 to the best available room (anti-fragmentation scored)

---

### 11.8 Last-Minute Walk-in

**Scenario:** Walk-in guest needs a room tonight. Only fragmented single nights remain across multiple Standard rooms.

**How hotels handle it today:**
- Receptionist checks PMS, assigns first available room, no consideration of impact on tomorrow's sellability

**How this platform addresses it:**
- T2 placement scores every available room by gap cost it creates
- Walk-in is assigned to the room that minimises future fragmentation
- If no room available in category → upgrade/downgrade suggestion from agentic layer

---

### 11.9 Revenue Manager's Weekly Calendar Review

**Scenario:** Revenue manager opens the system Monday morning, wants to know: where is revenue at risk this week?

**How hotels handle it today:**
- Manually scan PMS grid (colour-coded by occupancy %)
- Run reports in Excel or BI tool
- No actionable recommendations in the same view

**How this platform addresses it:**
- Manager Dashboard shows Before/After heatmap in a single view
- Orphan nights, CHANNEL blocks, and REPRICE candidates highlighted
- Estimated lost revenue from orphan nights surfaced as a summary metric
- One click runs full optimisation; another approves all recommendations

---

### 11.10 Predictive Cancellation — Pre-emptive Gap Discount

**Scenario:** Booking BK-234 (OTA, booked 90 days in advance, Apr 14 check-in) has 40% historical cancel rate for this channel/lead-time profile.

**How hotels handle it today:**
- No action until cancellation happens
- Revenue manager reacts by lowering rate on the freed slot
- By then, 48 hours may not be enough to fill it organically

**How this platform addresses it:**
- Predictive cancel model (Phase 3) flags BK-234 as "At Risk"
- Discount recommendation pre-generated for that slot
- If guest cancels, discount campaign is already queued — fills the gap before it appears in search results with no discount

---

## 12. Competitive Landscape & Market Gap Analysis

### 12.1 Current Players — What They Solve

| Category | Companies | What They Solve | What They Don't Solve |
|----------|-----------|-----------------|----------------------|
| **PMS (Property Management)** | Oracle OPERA, Mews, Cloudbeds, Hotelogix, Preno | Reservation management, front desk, housekeeping, billing, channel sync | Room assignment intelligence — rooms are assigned manually or by simple availability rules |
| **Revenue Management Systems** | IDeaS (SAS), Duetto, Atomize (acquired by Mews), Revinate | Demand forecasting, dynamic pricing by segment and room type, rate recommendations | Physical room-level defragmentation — pricing is optimised per room type, not per physical slot |
| **Channel Managers** | SiteMinder, Cloudbeds, Lodgify, Channex | Real-time ARI (Availability, Rates, Inventory) sync across OTAs | Tactical release decisions (when to pull back OTA inventory), orphan-night awareness |
| **Booking Engines** | SynXis (Sabre), Siteminder Booking Engine, HiRUM | Direct booking, rate display, upsell | No "can we make a room" logic — if no availability, guest leaves |
| **Agentic / AI Hotel Assistants** | Apaleo AI, Asksuite, Canary Technologies | Guest communication, FAQ, check-in/out automation, review responses | Operational inventory rearrangement — AI is guest-facing, not operations-facing |
| **Facility / Housekeeping** | ALICE (now part of Actabl), HotSOS, Quore | Task management, maintenance tickets, room readiness | No link between housekeeping state and revenue optimisation logic |

---

### 12.2 The Critical Gap Nobody Fills

After analysing the competitive landscape, one operational layer is systematically absent across all major vendors:

> **Real-time, constraint-aware, booking-atomic calendar defragmentation with a human-in-the-loop approval workflow.**

This is distinct from what existing tools do:

```
What RMS (Duetto / IDeaS) does:
  ✅ Recommends PRICES per room type
  ❌ Does NOT move existing bookings to create sellable contiguous runs

What PMS (Opera / Mews) does:
  ✅ Stores bookings, assigns rooms
  ❌ Does NOT algorithmically rearrange SOFT blocks to eliminate orphan nights

What Channel Managers do:
  ✅ Push availability updates to OTAs
  ❌ Do NOT decide when to release held inventory based on fill-probability signals

What AI Hotel Assistants do:
  ✅ Handle guest queries, automate communication
  ❌ Do NOT solve "can we fit this guest by moving others" in real time
```

---

### 12.3 Market Size & Timing

- Global hospitality technology market: **$9.1B (2024) → $16.2B (2033)**
- Global hotel market: **$5.2T, growing to $6.9T by 2029**
- Industry-wide orphan night unsold inventory is estimated at **8–15% of total available room nights** in fragmented independent hotels
- AI-first hotel operations is the stated investment priority for 2026 across BCG, Accenture, and major hotel chains (Hilton, IHG, Marriott all running AI operations pilots)

---

### 12.4 Strategic Differentiation — Three-Layer Architecture

The platform's competitive moat is the combination of three layers no single competitor has:

```
LAYER 1 — Deterministic HHI Optimiser (Built ✅)
  ├── Formally correct: column invariant, booking atomicity, convergence proof
  ├── Explainable: manager sees exactly which moves will be made before approving
  ├── No black box: every recommendation has a causal reason
  └── Competitor gap: No PMS or RMS does this

LAYER 2 — Constraint-Aware Placement Engine (Phase 1/2)
  ├── Hard constraints: bed type, accessibility, category lock
  ├── Soft constraints: floor, view, adjacency — scored, not blocked
  ├── Group atomicity: N rooms as a unit
  └── Competitor gap: PMS assigns rooms but doesn't score placement impact

LAYER 3 — Agentic AI Fallback + Predictive Signals (Phase 2/3)
  ├── When deterministic says NOT_POSSIBLE → AI proposes alternatives
  ├── Natural language for receptionists: "Move check-in by 1 day for Room X"
  ├── Predictive cancel signal pre-generates gap discount before gap appears
  └── Competitor gap: AI assistants are guest-facing; no competitor applies AI
       to the internal booking rearrangement problem
```

---

### 12.5 The Autonomous Hotel Management Vision

The long-term destination is a system where the hotel manager sets **policy** (not decisions), and the platform executes autonomously within those policy bounds:

```
TODAY (Human-in-loop)                   FUTURE (Policy-driven autonomous)
─────────────────────────────           ─────────────────────────────────────
Manager runs optimisation manually  →   T1 fires automatically at checkout
Manager reviews and approves each   →   Auto-approve moves below risk threshold
  recommendation                         (manager sets threshold, not each move)
Receptionist checks if room exists  →   System creates room via shuffle before
  and says "no"                          guest finishes asking
Revenue manager reprices manually   →   Discount generated and queued before
  after cancellation                     the gap appears
Channel manager released manually   →   Auto-release fires N days before
  when OTA inventory unsold              check-in per policy
```

**Four pillars of the autonomous system:**

1. **Deterministic algorithm** — guarantees that every move it makes is reversible, explainable, and invariant-preserving. Hotel manager can audit every change.

2. **Constraint layer** — ensures AI-driven moves cannot violate hard rules (accessibility, bed type, guest consent). Policy is encoded as code, not trust.

3. **Agentic AI** — handles the fuzzy cases: irresolvable gaps, guest preference conflicts, multi-category group placement. Surfaces human-language proposals when algorithm alone cannot decide.

4. **Predictive signals** — shifts the system from reactive (respond to cancellation) to proactive (pre-fill the gap before it appears). This is the layer where revenue is truly protected.

---

### 12.6 Build vs Partner Strategy

| Component | Build | Partner / Integrate |
|-----------|-------|---------------------|
| HHI optimiser + gap detection | ✅ Build (core IP) | — |
| Constraint + preference layer | ✅ Build | — |
| Agentic AI (fallback) | Build on Gemini API | Gemini / OpenAI |
| Predictive cancel model | Build (custom to hotel data) | — |
| PMS sync (bookings in/out) | Partner | Opera, Mews, Cloudbeds API |
| Channel manager sync | Partner | SiteMinder, Channex API |
| Competitor rate ingestion | Partner | OTA Insight, RateGain |
| Guest communication | Partner | Canary, Asksuite |
| Payments / billing | Partner | Stripe, Adyen |

**Core IP is the optimiser + constraint layer + agentic orchestration.** Everything else is integration.

---

## 13. Phased Roadmap

### Phase 0 — Current (Demo / Hackathon)
- ✅ Manual T1 trigger + T2 booking request
- ✅ HHI local search + evacuation pass
- ✅ Anti-fragmentation placement scoring
- ✅ Gemini AI recommendations (REPRICE / SHUFFLE)
- ✅ 4-type heatmap (Green / Blue / Red; Purple stub)
- ✅ Before/After preview with column invariant
- ✅ Convergence detection
- ✅ Guest integrity enforcement
- ✅ Atomic bulk approval

### Phase 1 — Production Foundation
- Constraint layer (bed type, accessibility) — hard constraints only
- Channel inventory model (Purple blocks, manual entry)
- Scheduled T1 trigger (cron at checkout time)
- Recommendation TTL + auto-expiry
- Hosting setup (see OQ-26 → OQ-30)
- Auth / multi-user access control

### Phase 2 — Intelligence Layer
- Soft constraint scoring (floor, view, adjacency)
- Group booking support (N rooms, group_id)
- Agentic AI fallback (split-stay, upgrade/downgrade suggestions)
- Discount engine (orphan-night discount model)
- Channel auto-release policy

### Phase 3 — Predictive Layer
- 2-day cancellation prediction signal
- Event-driven pricing surge detection
- Competitor rate ingestion
- Predictive discount (proactive, before gap appears)
- PMS / channel manager API integration

---

## 14. Architecture Recommendations for Hosting

### Option A — Managed Cloud (Recommended for SaaS)
```
Frontend  : Vercel (Next.js / Vite)        — zero-ops, global CDN
Backend   : Railway / Render               — Docker-based FastAPI, auto-scale
Database  : Neon (serverless Postgres)     — branching, auto-pause, low cost
AI        : Gemini API (Google Cloud)      — pay-per-use
Realtime  : Native WebSocket on backend    — or Supabase Realtime if needed
```

### Option B — Single-Hotel On-Premise
```
Frontend  : Nginx (static build)
Backend   : Docker Compose on hotel server
Database  : Postgres on same server
AI        : Gemini API (internet dependency) or local Ollama fallback
Realtime  : Same WebSocket
```

### Option C — Hybrid
```
Hotel data (PII) : on-premise Postgres
Compute          : Cloud backend calling on-prem DB via VPN
AI               : Cloud Gemini
Frontend         : CDN
```

**Recommendation:** Start with Option A for demo and early SaaS. Revisit Option C if hotel data residency becomes a hard requirement.

---

## 15. Summary — Attack Plan

```
PROBLEM                          SOLUTION MODULE
──────────────────────────────────────────────────────────────────────────
Fragmented calendar              HHI Local Search (T1) — BUILT ✅
New booking can't be placed      ShuffleEngine (T2) — BUILT ✅
Algorithm ignores preferences    Constraint Layer — PHASE 1
Irresolvable booking requests    Agentic AI Fallback — PHASE 2
Channel rooms wasted             Channel Inventory Manager — PHASE 1/2
Orphan nights unsold             Discount Engine — PHASE 2
Demand not priced correctly      Surge Pricing Signal — PHASE 3
Cancellations not anticipated    Predictive Cancel Model — PHASE 3
Manager approves wrong order     Atomic Bulk Approval — BUILT ✅
Preview differs from DB result   Column-invariant preview — BUILT ✅
Cycle convergence unclear        HHI convergence + detection — BUILT ✅
```

---

*Document prepared by: Engineering Team*  
*For review and open-question resolution before Phase 1 begins.*
