# Occumax KPIs (derived from Occupancy, Pricing, Channel subtabs)

This document proposes **dashboard KPIs** that are directly supported by the data already used in:
- `OccupancyOptimizationTab` (inventory heatmap + recovery previews)
- `PricingOptimizationTab` (RateIQ calendar + heatmap-derived revenue exposure)
- `ChannelOptimizationTab` (channel performance + YieldIQ partner recommendations)

Ignore any existing dashboard KPIs — this list is derived **fresh** from these three subtabs’ data and computations.

---

## Top 12 dashboard KPIs (most important)

These 12 KPIs are the best “first dashboard” set because they answer, in order: **how full are we**, **what can we still sell**, **how much money is exposed/recoverable**, and **are we filling profitably**.

1. **Tonight occupancy %** — current operational fill.
2. **Orphan nights (sandwich gaps)** — immediate conversion opportunities trapped by fragmentation.
3. **Orphan gaps (runs of orphanable empties)** — how many “trapped” empty runs exist (problem count, not just nights).
4. **k=2 windows (2-night bookable)** — near-term bookability for common LOS.
5. **k=3 windows (3-night bookable)** — bookability for longer LOS demand.
6. **Unsold room-nights (window)** — total sellable exposure remaining in the near window.
7. **Revenue at risk (window)** — dollars exposed by unsold inventory.
8. **Revenue on books (window)** — booked revenue currently secured in the same near-term window.
9. **Discounted rooms (window)** — rate-integrity pressure (unsold nights priced meaningfully below base).
10. **Net revenue by channel** — profit-aware contribution split (OTA vs Direct).
11. **Net ADR by channel (net / room-night)** — profit per sold night by channel.
12. **Gross → net leakage (OTA) ($ and %)** — commission drag; the core “is this mix worth it?” KPI.

---

## Inventory health (occupancy / heatmap)

- **Tonight occupancy %**
  - **Shows**: What share of rooms are occupied tonight (snapshot).
  - **Derived from**: Heatmap rows; count of rooms whose `cells[0].block_type !== "EMPTY"` divided by total rooms in view.

- **Tonight occupied rooms**
  - **Shows**: Number of rooms occupied tonight.
  - **Derived from**: Heatmap rows; count of non-`EMPTY` at index 0.

- **Total rooms (in scope)**
  - **Shows**: Denominator for occupancy and other inventory metrics (filtered view scope).
  - **Derived from**: Number of heatmap rows currently in view.

- **Orphan nights (sandwich gaps)**
  - **Shows**: Count of single-night “sandwich” gaps (empty night between two non-empty nights) inside the visible window.
  - **Derived from**: Heatmap rows; for each room and day \(i\), `EMPTY` with non-`EMPTY` neighbors on both sides.

- **Orphan gaps (runs of orphanable empties)**
  - **Shows**: How many “trapped” empty runs exist (short gaps bounded by non-empty on both ends).
  - **Derived from**: Heatmap rows; contiguous `EMPTY` runs with non-empty boundary on both sides; the subtab currently flags runs of length \(\le 5\).

- **Hard-to-fill gaps (count of 1–3 night gaps)**
  - **Shows**: Fragmentation pressure: short empty runs that are difficult to sell.
  - **Derived from**: Heatmap rows; distribution of contiguous `EMPTY` runs; count where run length is 1–3.

- **Easy-to-sell runs (count of 4+ night gaps)**
  - **Shows**: Available multi-night inventory that is generally easier to convert.
  - **Derived from**: Heatmap rows; distribution of `EMPTY` runs; count where run length is 4–7 plus 8+.

- **Empty-run distribution**
  - **Shows**: Inventory “shape” across the window (how much is chopped into 1-night vs 2–3 vs 4–7 vs 8+ runs).
  - **Derived from**: Heatmap rows; histogram of contiguous `EMPTY` run lengths.

- **Top fragmented rooms**
  - **Shows**: Which rooms create the most short gaps (actionable targets for shuffle).
  - **Derived from**: Heatmap rows; per-room count of 1–3 night `EMPTY` runs; top N.

---

## Bookability (how many sellable windows exist)

These KPIs measure how many **bookable windows** exist for a given length-of-stay \(k\) within the current date slice.

- **k-night windows (k=2, k=3, …)**
  - **Shows**: Count of contiguous `EMPTY` windows of length \(k\) available to sell (higher = more bookable inventory).
  - **Derived from**: Heatmap rows; for each contiguous `EMPTY` run of length \(L\), contributes \((L - k + 1)\) windows when \(L \ge k\).

- **k-night window lift (after preview vs now)**
  - **Shows**: Whether a proposed shuffle increases bookable windows.
  - **Derived from**: Same k-night window calculation applied to “after/preview” simulated rows vs live rows.

---

## Constraints & leakage (rules preventing conversion)

- **MinLOS orphan blocks**
  - **Shows**: Count of orphan-night positions that are locked by MinLOS rules (gap exists but cannot be sold as 1-night).
  - **Derived from**: Heatmap cells that are orphan-night `EMPTY` and `min_stay_active === true` with `min_stay_nights > 1`.

- **Orphan-night offer count**
  - **Shows**: How many “special offer” flags are present for orphan clearance.
  - **Derived from**: Heatmap cells where `offer_type === "SANDWICH_ORPHAN"`.

---

## AI constraint insight (occupancy lens)

- **Recommended LOS (nights)**
  - **Shows**: AI-advised length-of-stay target for the current occupancy window (used to guide recovery shuffle).
  - **Derived from**: `PredictOptimalLosResponse.recommended_los_nights`.

- **Recommended LOS confidence**
  - **Shows**: How reliable the LOS recommendation is (used for operator trust / gating).
  - **Derived from**: `PredictOptimalLosResponse.confidence`.

---

## Pricing exposure (heatmap-derived, pricing lens)

These are computed from the same heatmap used for occupancy, but interpreted as **revenue exposure**.

- **Unsold room-nights (window)**
  - **Shows**: Count of `EMPTY` cells in the pricing window (e.g., 15 days), i.e., inventory still unsold.
  - **Derived from**: Heatmap rows; count cells where `block_type === "EMPTY"` within window.

- **Revenue at risk (window)**
  - **Shows**: Sum of the current rates tied to unsold room-nights; a “dollars exposed” view of empties.
  - **Derived from**: Heatmap cells within window where `block_type === "EMPTY"`; sum of `current_rate`.

- **Revenue on books (window)**
  - **Shows**: Sum of current-rate value of already-booked room-nights.
  - **Derived from**: Heatmap cells within window where `block_type !== "EMPTY"`; sum of `current_rate`.

- **Discounted rooms (window)**
  - **Shows**: Count of unsold room-nights priced meaningfully below base (a rate-integrity / floor pressure indicator).
  - **Derived from**: Heatmap cells where `block_type === "EMPTY"` and `current_rate < base_rate * 0.95` (using the row’s `base_rate`).

- **Orphan nights (count) + impacted categories**
  - **Shows**: How many orphan-night cells exist and which categories are affected (pricing opportunities are often concentrated).
  - **Derived from**: Heatmap orphan-night detection; categories collected from affected rows.

---

## RateIQ recommendation KPIs (pricing subtab)

- **Rescue potential ($)**
  - **Shows**: Estimated incremental revenue recoverable if recommendations are applied.
  - **Derived from**: `PricingAnalyseResponse.rescue_potential`.

- **Recommendation volume (count)**
  - **Shows**: How many rate changes are being suggested for the window.
  - **Derived from**: `PricingCalendarCell.action !== "MAINTAIN"` across the pricing calendar.

- **Increases / discounts / maintains (counts)**
  - **Shows**: Mix of strategy in the AI plan (stimulate vs yield vs hold).
  - **Derived from**: Counts of `action === "INCREASE"`, `action === "DISCOUNT"`, `action === "MAINTAIN"`.

- **Average suggested change % (overall and by action)**
  - **Shows**: How aggressive the recommendations are.
  - **Derived from**: `change_pct` in pricing calendar cells (optionally filtered to action types).

- **Confidence mix (high/medium/low)**
  - **Shows**: Trust distribution of AI recommendations.
  - **Derived from**: `PricingCalendarCell.confidence` distribution for non-orphan cells.

- **Selected for commit (count)**
  - **Shows**: Operator’s chosen set of nights/categories to push live.
  - **Derived from**: UI selection set size (category::date keys).

- **Committed updates vs skipped**
  - **Shows**: Execution success and policy constraints (e.g., floor-rate blocks) after commit.
  - **Derived from**: `PricingCommitResult.updated` and `PricingCommitResult.skipped`.

---

## Channel mix & profitability (channel subtab)

The channel performance feed already provides the primitives for profit-aware KPIs.

- **Room-nights by channel**
  - **Shows**: Volume distribution (how demand is being captured).
  - **Derived from**: `ChannelStat.room_nights` per channel type (e.g., OTA vs DIRECT).

- **Channel share %**
  - **Shows**: Mix share by room-nights (who is filling inventory).
  - **Derived from**: `ChannelStat.share_pct` (or recompute using `total_room_nights`).

- **ADR by channel**
  - **Shows**: Rate quality by channel (pricing power vs discounting).
  - **Derived from**: `ChannelStat.avg_rate`.

- **Gross revenue by channel**
  - **Shows**: Topline contribution by channel.
  - **Derived from**: `ChannelStat.gross_revenue`.

- **Net revenue by channel**
  - **Shows**: Profit-aware contribution after commissions.
  - **Derived from**: `ChannelStat.net_revenue`.

- **Commission rate % (OTA)**
  - **Shows**: Cost of acquisition signal; used to interpret whether OTA growth is profitable.
  - **Derived from**: `ChannelStat.commission_pct` (OTA), 0 for direct.

- **Net ADR (net revenue per room-night)**
  - **Shows**: Profit per sold room-night by channel.
  - **Derived from**: `net_revenue / room_nights` (compute when `room_nights > 0`).

- **Gross → net leakage ($ and %)**
  - **Shows**: Absolute and relative commission/fee impact for OTA.
  - **Derived from**: `gross_revenue - net_revenue` and \((gross - net) / gross\).

---

## OTA partner performance (within OTA channel)

- **OTA partner share within OTA (%)**
  - **Shows**: Concentration of OTA production across partners (dependency risk + negotiation leverage).
  - **Derived from**: `PartnerStat.share_of_channel_pct`.

- **Room-nights by partner**
  - **Shows**: Partner volume contribution.
  - **Derived from**: `PartnerStat.room_nights`.

- **ADR by partner**
  - **Shows**: Rate quality by partner.
  - **Derived from**: `PartnerStat.avg_rate`.

- **Net revenue by partner**
  - **Shows**: Profit contribution by partner (within OTA).
  - **Derived from**: `PartnerStat.net_revenue`.

---

## YieldIQ partner strategy KPIs (channel recommendations)

These KPIs reflect “where to push unsold inventory” decisions.

- **Recommended partners (count)**
  - **Shows**: How many partners have a concrete push suggestion in the current intelligence run.
  - **Derived from**: `ChannelRecommendResponse.partner_insights` (or best recommendation per partner).

- **Top recommended push (partner / date range / category / rooms)**
  - **Shows**: The single best “where to push” action (most actionable tile on a dashboard).
  - **Derived from**: Best scoring recommendation/insight per partner using `expected_net`, confidence, and health.

- **Expected net from recommended pushes ($)**
  - **Shows**: Estimated incremental net value of the recommended OTA slot pushes.
  - **Derived from**: Sum of `ChannelRecommendation.expected_net` (or `ChannelPartnerInsight.expected_net`) across chosen/eligible recommendations.

- **Partner health distribution (healthy / watch / risk)**
  - **Shows**: Portfolio risk status of active OTA partners.
  - **Derived from**: `ChannelPartnerInsight.health` counts (GREEN/AMBER/RED).

- **Preference distribution (prefer / watch / hold / avoid)**
  - **Shows**: Strategy posture across partners.
  - **Derived from**: `ChannelPartnerInsight.preference` counts.

- **Recommendation confidence distribution**
  - **Shows**: How confident the system is in channel pushes.
  - **Derived from**: `ChannelPartnerInsight.confidence` distribution (or per `ChannelRecommendation.confidence`).

---

## Cross-pillar “dashboard rollups” (supported by these subtabs)

These KPIs naturally unify occupancy + pricing + channel without inventing new data.

- **Inventory recoverability index**
  - **Shows**: Whether inventory is “convertible” vs “chopped” (high bookability, low orphan fragmentation is better).
  - **Derived from**: k-night windows, orphan nights, and empty-run distribution.

- **Revenue recovery opportunity ($)**
  - **Shows**: The size of the near-term revenue upside currently visible in the window.
  - **Derived from**: RateIQ `rescue_potential` + heatmap-derived `revenue_at_risk` (reported separately or as a combined opportunity view).

- **Profit-aware channel efficiency**
  - **Shows**: Whether growth is coming from profitable routes.
  - **Derived from**: Channel net ADR by channel + gross→net leakage.

