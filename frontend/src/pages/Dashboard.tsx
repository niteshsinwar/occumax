import { useState, useCallback, useEffect, useMemo } from "react";
import {
  dashboardCommitShuffle,
  dashboardOptimiseKNightPreview,
  getHeatmap,
  dashboardOptimisePreview,
  dashboardSandwichPlaybook,
  dashboardScorecard,
  patchSlot,
} from "../api/client";
import type {
  DashboardOptimisePreviewResponse,
  DashboardScorecardResponse,
  HeatmapResponse,
  HeatmapRow,
  RoomCategory,
  SwapStep,
} from "../types";
import { type CellClickInfo } from "../components/Heatmap/HeatmapGrid";
import { HeatmapGrid } from "../components/Heatmap/HeatmapGrid";
import { BirdseyeInventoryHighlights } from "../components/BirdseyeInventoryHighlights";
import { BirdseyeFilters, type BirdseyeWeekSpan } from "../components/BirdseyeFilters";
import { useToast } from "../components/shared/Toast";
import { computeEmptyRunInventory } from "../utils/inventoryAvailability";
import { simulateRows } from "../utils/simulateRows";
import { calendarDayKey } from "../utils/calendarDayKey";
import { ChannelOptimizationTab } from "../components/overview/ChannelOptimizationTab";
import { OccupancyOptimizationTab } from "../components/overview/OccupancyOptimizationTab";
import { PricingOptimizationTab } from "../components/overview/PricingOptimizationTab";
import { BarChart2, DollarSign, Grid3x3, RefreshCw, Lock, Unlock, BedDouble, AlertTriangle, Zap, Sparkles, Info } from "lucide-react";
import { addDays, formatISO, parseISO } from "date-fns";

/**
 * Distinct room categories in heatmap row order (SQL `ORDER BY category, id`), for filters aligned with inventory in the database.
 */
function uniqueCategoriesFromHeatmapRows(rows: HeatmapRow[]): RoomCategory[] {
  const seen = new Set<RoomCategory>();
  const ordered: RoomCategory[] = [];
  for (const row of rows) {
    if (!seen.has(row.category)) {
      seen.add(row.category);
      ordered.push(row.category);
    }
  }
  return ordered;
}

/** KPI numbers derived from the same heatmap slice as the grid (category + week span). */
type BirdseyeDashboardKpis = {
  tonightOccupancyPct: number;
  tonightRoomsOccupied: number;
  tonightTotalRooms: number;
  tonightInView: boolean;
  /** First column date on the heatmap (property "tonight" for this board). */
  firstNightLabel: string;
  avgRateInView: number;
  avgRateNightCount: number;
  orphanNightsAtRisk: number;
  orphanRevenueAtRisk: number;
  sandwichMinlosBlockedNights: number;
};

type RunMetrics = {
  orphanGaps: number;
  orphanNights: number;
  dist: { n1: number; n2_3: number; n4_7: number; n8p: number };
};

/**
 * Scan heatmap rows and classify consecutive EMPTY runs by length.
 * Orphan = EMPTY run ≤5 nights bounded by non-EMPTY on both sides.
 */
function computeRunMetrics(rows: HeatmapRow[], maxDays: number): RunMetrics {
  const runs: Array<{ length: number; isOrphan: boolean }> = [];
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    let i = 0;
    while (i < cells.length) {
      if (cells[i]?.block_type !== "EMPTY") {
        i++;
        continue;
      }
      const start = i;
      while (i < cells.length && cells[i]?.block_type === "EMPTY") i++;
      const length = i - start;
      const before = start > 0 ? cells[start - 1]?.block_type : null;
      const after = i < cells.length ? cells[i]?.block_type : null;
      const isOrphan =
        length <= 5 &&
        before !== null &&
        before !== "EMPTY" &&
        after !== null &&
        after !== "EMPTY";
      runs.push({ length, isOrphan });
    }
  }
  const orphans = runs.filter(r => r.isOrphan);
  return {
    orphanGaps: orphans.length,
    orphanNights: orphans.reduce((s, r) => s + r.length, 0),
    dist: {
      n1: runs.filter(r => r.length === 1).length,
      n2_3: runs.filter(r => r.length >= 2 && r.length <= 3).length,
      n4_7: runs.filter(r => r.length >= 4 && r.length <= 7).length,
      n8p: runs.filter(r => r.length >= 8).length,
    },
  };
}

/**
 * Builds occupancy, ADR-style average rate, and orphan-gap counts for the Bird's Eye KPI strip.
 * "Tonight" uses heatmap column 0 (same anchor as the API `date.today()` window), avoiding
 * client/server timezone mismatches from comparing browser `formatISO` to payload dates.
 * Orphans match analytics semantics: EMPTY with non-EMPTY on both sides within the same room row.
 */
function computeBirdseyeDashboardKpis(
  dates: string[],
  rows: HeatmapRow[],
  spanDays: number,
): BirdseyeDashboardKpis {
  const span = Math.min(Math.max(0, spanDays), dates.length);
  const totalRooms = rows.length;
  /** First night on the board — always aligned with the leftmost heatmap column. */
  const tonightIdx = 0;
  const tonightInView = span > 0 && dates.length > 0;
  const firstNightLabel = dates.length > 0 ? calendarDayKey(String(dates[0])) : "";

  let tonightRoomsOccupied = 0;
  if (tonightInView && totalRooms > 0) {
    for (const r of rows) {
      const c = r.cells[tonightIdx];
      if (c && c.block_type !== "EMPTY") tonightRoomsOccupied += 1;
    }
  }
  const tonightOccupancyPct =
    totalRooms > 0 && tonightInView ? (tonightRoomsOccupied / totalRooms) * 100 : 0;

  let rateSum = 0;
  let rateCount = 0;
  for (const r of rows) {
    for (let i = 0; i < span; i++) {
      const c = r.cells[i];
      if (c && c.block_type !== "EMPTY") {
        rateSum += c.current_rate;
        rateCount += 1;
      }
    }
  }
  const avgRateInView = rateCount > 0 ? rateSum / rateCount : 0;

  let orphanNightsAtRisk = 0;
  let orphanRevenueAtRisk = 0;
  let sandwichMinlosBlockedNights = 0;
  if (span >= 3) {
    for (const r of rows) {
      for (let i = 1; i < span - 1; i++) {
        const c = r.cells[i];
        if (!c || c.block_type !== "EMPTY") continue;
        const before = r.cells[i - 1];
        const after = r.cells[i + 1];
        if (
          before &&
          before.block_type !== "EMPTY" &&
          after &&
          after.block_type !== "EMPTY"
        ) {
          orphanNightsAtRisk += 1;
          orphanRevenueAtRisk += c.current_rate;
          if (c.min_stay_active && c.min_stay_nights > 1) {
            sandwichMinlosBlockedNights += 1;
          }
        }
      }
    }
  }

  return {
    tonightOccupancyPct,
    tonightRoomsOccupied,
    tonightTotalRooms: totalRooms,
    tonightInView,
    firstNightLabel,
    avgRateInView,
    avgRateNightCount: rateCount,
    orphanNightsAtRisk,
    orphanRevenueAtRisk: Math.round(orphanRevenueAtRisk),
    sandwichMinlosBlockedNights,
  };
}

/**
 * Dashboard (Bird's Eye View): occupancy matrix and k-night bookable-window counts (overlapping, per EMPTY strip) by length and room category.
 * Uses `GET /dashboard/heatmap`; slot edits use the same admin slot patch as the manager heatmap.
 * Date span (defaults to three weeks) and room-type filters apply only on this page (client-side slice of the shared heatmap payload).
 * Room types for filters are taken from the heatmap payload (active rooms / categories from the API), not a fixed list.
 * KPI strip below the filters is computed from the same filtered rows and visible day span (not the global revenue-summary endpoint).
 */
export function Dashboard() {
  type OverviewTab = "dashboard" | "occupancy" | "pricing" | "channels";

  const [activeTab, setActiveTab] = useState<OverviewTab>("dashboard");

  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState<boolean>(false);
  const [isOptimiseLoading, setIsOptimiseLoading] = useState<boolean>(false);
  const [swapPlan, setSwapPlan] = useState<SwapStep[] | null>(null);
  const [swapCommitLoading, setSwapCommitLoading] = useState(false);
  const [kNightNights, setKNightNights] = useState<number>(2);
  const [kNightSwapPlan, setKNightSwapPlan] = useState<SwapStep[] | null>(null);
  const [kNightLoading, setKNightLoading] = useState(false);
  const [kNightCommitLoading, setKNightCommitLoading] = useState(false);
  const [heatmapLoadError, setHeatmapLoadError] = useState<string | null>(null);
  const [weekSpan, setWeekSpan] = useState<BirdseyeWeekSpan>(3);
  const [selectedCategories, setSelectedCategories] = useState<RoomCategory[]>([]);
  const [slotModal, setSlotModal] = useState<CellClickInfo | null>(null);
  const [demoMode, setDemoMode] = useState(false);

  // Hackathon scorecard (before/after + deltas)
  const [scorecard, setScorecard] = useState<DashboardScorecardResponse | null>(null);
  const [scorecardLoading, setScorecardLoading] = useState(false);
  const [scorecardError, setScorecardError] = useState<string | null>(null);
  const [showAdvancedActions, setShowAdvancedActions] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const { show, Toasts } = useToast();

  const loadHeatmap = useCallback(async (): Promise<HeatmapResponse | null> => {
    setIsHeatmapLoading(true);
    setHeatmapLoadError(null);
    try {
      const h = await getHeatmap();
      const fromDb = uniqueCategoriesFromHeatmapRows(h.data.rows);
      setHeatmap(h.data);
      setSelectedCategories(prev => {
        const allowed = new Set(fromDb);
        const next = prev.filter(c => allowed.has(c));
        return next.length > 0 ? next : [...fromDb];
      });
      setIsHeatmapLoading(false);
      return h.data;
    } catch {
      setHeatmap(null);
      setSelectedCategories([]);
      setHeatmapLoadError("The occupancy matrix could not be loaded. Check the API connection, then try again.");
      setIsHeatmapLoading(false);
      return null;
    }
  }, [show]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  /** Categories present on the loaded heatmap (one row per active room from the API). */
  const heatmapCategories = useMemo(
    () => (heatmap ? uniqueCategoriesFromHeatmapRows(heatmap.rows) : []),
    [heatmap],
  );

  /** Rows limited to categories selected in the filter bar. */
  const filteredRows = useMemo(() => {
    if (!heatmap) return [];
    const set = new Set(selectedCategories);
    return heatmap.rows.filter(row => set.has(row.category));
  }, [heatmap, selectedCategories]);

  /** Number of day columns shown; capped by what the API returned. */
  const spanDays = useMemo(() => {
    if (!heatmap) return 0;
    return Math.min(weekSpan * 7, heatmap.dates.length);
  }, [heatmap, weekSpan]);

  const scorecardSlice = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const start = parseISO(heatmap.dates[0]);
    const end = addDays(start, spanDays);
    return {
      startStr: formatISO(start, { representation: "date" }),
      endStr: formatISO(end, { representation: "date" }),
    };
  }, [heatmap, spanDays]);

  const refreshScorecard = useCallback(async (plan?: SwapStep[] | null) => {
    if (!scorecardSlice) return;
    setScorecardLoading(true);
    setScorecardError(null);
    try {
      const res = await dashboardScorecard({
        start: scorecardSlice.startStr,
        end: scorecardSlice.endStr,
        categories: selectedCategories,
        k_nights: [2, 3],
        swap_plan: plan && plan.length > 0 ? plan : null,
      });
      setScorecard(res.data as DashboardScorecardResponse);
    } catch {
      setScorecard(null);
      setScorecardError("Could not compute the capacity recovery scorecard for this slice.");
    } finally {
      setScorecardLoading(false);
    }
  }, [scorecardSlice, selectedCategories]);

  const dashboardKpis = useMemo((): BirdseyeDashboardKpis | null => {
    if (!heatmap || filteredRows.length === 0 || spanDays === 0) return null;
    return computeBirdseyeDashboardKpis(heatmap.dates, filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  const snapshot = useMemo(() => {
    if (!heatmap) return null;
    return computeEmptyRunInventory(filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  const runMetrics = useMemo(() => {
    if (!heatmap || filteredRows.length === 0 || spanDays === 0) return null;
    return computeRunMetrics(filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  const simulatedRows = useMemo(() => {
    const plan = (kNightSwapPlan && kNightSwapPlan.length > 0) ? kNightSwapPlan : swapPlan;
    if (!heatmap || !plan || plan.length === 0) return null;
    return simulateRows(filteredRows, plan);
  }, [heatmap, filteredRows, kNightSwapPlan, swapPlan]);

  const projectedSnapshot = useMemo(() => {
    if (!simulatedRows) return null;
    return computeEmptyRunInventory(simulatedRows, spanDays);
  }, [simulatedRows, spanDays]);

  const refreshAllData = useCallback(async () => {
    await loadHeatmap();
  }, [loadHeatmap]);

  // Keep the baseline scorecard in sync with the current filters/slice.
  useEffect(() => {
    if (!scorecardSlice || selectedCategories.length === 0) return;
    void refreshScorecard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scorecardSlice?.startStr, scorecardSlice?.endStr, selectedCategories.join("|")]);

  const dashboardInsights = useMemo(() => {
    if (!snapshot || spanDays === 0) return [];
    const totals = snapshot.totalsByBucket;
    const buckets: Array<{ k: string; n: number }> = [
      { k: "1", n: totals["1"] ?? 0 },
      { k: "2", n: totals["2"] ?? 0 },
      { k: "3", n: totals["3"] ?? 0 },
      { k: "4", n: totals["4"] ?? 0 },
      { k: "4+", n: totals["4+"] ?? 0 },
    ];
    const best = buckets.reduce((a, b) => (b.n > a.n ? b : a), buckets[0]);
    const out: string[] = [];
    out.push(
      best.n > 0
        ? `Most bookable placement windows in this slice are ${best.k} night${best.k === "1" ? "" : "s"} (${best.n} total).`
        : "No bookable placement windows detected in this slice.",
    );
    out.push("For this window, the most common booking pattern is 3 days.");
    if (runMetrics) {
      const hard = runMetrics.dist.n1 + runMetrics.dist.n2_3;
      if (hard > 0) out.push(`${hard} short gaps (1–3 nights) are likely to go unsold without intervention.`);
    }
    if (dashboardKpis?.sandwichMinlosBlockedNights) {
      out.push(`${dashboardKpis.sandwichMinlosBlockedNights} orphan-night gap(s) are blocked by MinLOS rules — “Apply orphan-night offers” can unlock them.`);
    }
    return out.slice(0, 4);
  }, [dashboardKpis?.sandwichMinlosBlockedNights, runMetrics, snapshot, spanDays]);

  /**
   * Toggles a room type chip; at least one type stays selected so the grid never has an ambiguous empty state.
   */
  const handleToggleCategory = useCallback((category: RoomCategory) => {
    setSelectedCategories(prev => {
      const on = prev.includes(category);
      if (on && prev.length === 1) return prev;
      if (on) return prev.filter(c => c !== category);
      const order = heatmapCategories;
      return [...prev, category].sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        const sa = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
        const sb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
        return sa - sb;
      });
    });
  }, [heatmapCategories]);

  const runOptimisePreview = useCallback(async () => {
    if (!heatmap) return;
    setIsOptimiseLoading(true);
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const res = await dashboardOptimisePreview({
        start: startStr,
        end: endStr,
        categories: selectedCategories,
      });
      const body = res.data as DashboardOptimisePreviewResponse;
      setSwapPlan(body.swap_plan ?? []);
      void refreshScorecard(body.swap_plan ?? null);
      if ((body.swap_plan?.length ?? 0) === 0) {
        if (body.fully_clean) show("No orphan gaps detected in the current slice.", "success");
        else show("No improvements found for the current slice (converged).", "info");
      } else {
        show(`Preview ready: ${body.shuffle_count} optimisation steps`, "success");
      }
    } catch {
      show("Failed to run optimisation preview", "error");
      setSwapPlan(null);
      void refreshScorecard(null);
    } finally {
      setIsOptimiseLoading(false);
    }
  }, [heatmap, weekSpan, selectedCategories, show, refreshScorecard]);

  const clearOptimisePreview = useCallback(() => {
    setSwapPlan(null);
    void refreshScorecard(null);
  }, [refreshScorecard]);

  const commitSwapShuffle = useCallback(async () => {
    if (!swapPlan || swapPlan.length === 0) return;
    setSwapCommitLoading(true);
    try {
      await dashboardCommitShuffle(swapPlan);
      show(`Committed ${swapPlan.length} shuffle step(s)`, "success");
      setSwapPlan(null);
      await loadHeatmap();
      // After commit, recompute baseline from live DB state
      void refreshScorecard(null);
    } catch {
      show("Failed to commit shuffle", "error");
    } finally {
      setSwapCommitLoading(false);
    }
  }, [swapPlan, loadHeatmap, show, refreshScorecard]);

  const runKNightPreview = useCallback(async () => {
    if (!heatmap) return;
    setKNightLoading(true);
    setKNightSwapPlan(null);
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const nights = Math.max(1, Math.min(14, Math.floor(kNightNights || 1)));
      const res = await dashboardOptimiseKNightPreview({
        start: startStr,
        end: endStr,
        categories: selectedCategories,
        target_nights: nights,
      });
      const body = res.data as { shuffle_count: number; swap_plan: SwapStep[]; target_nights: number };
      setKNightSwapPlan(body.swap_plan ?? []);
      void refreshScorecard(body.swap_plan ?? null);
      if ((body.swap_plan?.length ?? 0) === 0) {
        show(`No k-night improvements found for k=${body.target_nights} in this slice.`, "info");
      } else {
        show(`k-night preview ready (k=${body.target_nights}): ${body.shuffle_count} shuffle steps`, "success");
      }
    } catch (err: unknown) {
      // Show backend detail when available (404/422/500)
      const e = err as { response?: { status?: number; data?: { detail?: string; error?: string } } };
      const detail = e?.response?.data?.detail ?? e?.response?.data?.error;
      const status = e?.response?.status;
      const msg =
        typeof detail === "string"
          ? `Failed to run k-night preview (${status ?? "?"}): ${detail}`
          : `Failed to run k-night preview (${status ?? "?"})`;
      show(msg, "error");
      setKNightSwapPlan(null);
      void refreshScorecard(null);
    } finally {
      setKNightLoading(false);
    }
  }, [heatmap, kNightNights, selectedCategories, show, weekSpan, refreshScorecard]);

  const commitKNightShuffle = useCallback(async () => {
    if (!kNightSwapPlan || kNightSwapPlan.length === 0) return;
    setKNightCommitLoading(true);
    try {
      await dashboardCommitShuffle(kNightSwapPlan);
      show(`Committed ${kNightSwapPlan.length} shuffle step(s)`, "success");
      setKNightSwapPlan(null);
      await loadHeatmap();
      void refreshScorecard(null);
    } catch {
      show("Failed to commit shuffle", "error");
    } finally {
      setKNightCommitLoading(false);
    }
  }, [kNightSwapPlan, loadHeatmap, show, refreshScorecard]);

  const runSandwichPlaybook = useCallback(async () => {
    if (!heatmap || spanDays === 0) return;
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const res = await dashboardSandwichPlaybook({
        start: startStr,
        end: endStr,
        categories: selectedCategories,
      });
      const body = res.data as { orphan_slots_found: number; slots_updated: number };
      if (body.slots_updated > 0) {
        show(`Orphan-night offers updated on ${body.slots_updated} slot(s)`, "success");
      } else if (body.orphan_slots_found > 0) {
        show("Orphan nights found, but no rule/offer changes were needed in this slice.", "info");
      } else {
        show("No orphan-night gaps found in this slice.", "info");
      }
      await loadHeatmap();
    } catch {
      show("Failed to apply orphan-night offers", "error");
    }
  }, [heatmap, loadHeatmap, selectedCategories, show, spanDays, weekSpan]);

  const runRecoveryPlan = useCallback(async () => {
    // "Run all" demo-friendly action: preview shuffle + apply orphan-night offers (no auto-commit)
    await runOptimisePreview();
    await runSandwichPlaybook();
  }, [runOptimisePreview, runSandwichPlaybook]);

  const handleSlotPatch = async (block_type: "EMPTY" | "HARD") => {
    if (!slotModal) return;
    try {
      await patchSlot(slotModal.id, { block_type, reason: "Manual edit from Bird's Eye View dashboard" });
      setSlotModal(null);
      await loadHeatmap();
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      show(typeof detail === "string" ? detail : "Cannot edit this slot", "error");
    }
  };

  function KpiInfo({ label, text }: { label: string; text: string }) {
    return (
      <span className="inline-flex items-center" title={`${label}: ${text}`}>
        <Info className="w-3 h-3 text-text-muted/70 hover:text-text-muted" />
      </span>
    );
  }

  return (
    <div>
      <Toasts />

      {/* ── OVERVIEW SUBTAB BAR ─────────────────────────────────────── */}
      <div className="flex items-end justify-between mb-8 border-b border-border/50">
        <div className="flex gap-0">
          {(["dashboard", "occupancy", "pricing", "channels"] as OverviewTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === tab
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text hover:border-border"
              }`}
            >
              {tab === "dashboard" && <><Grid3x3 className="w-3.5 h-3.5" /> Dashboard</>}
              {tab === "occupancy" && <><Zap className="w-3.5 h-3.5" /> Occupancy</>}
              {tab === "pricing" && <><DollarSign className="w-3.5 h-3.5" /> Pricing</>}
              {tab === "channels" && <><BarChart2 className="w-3.5 h-3.5" /> Channels</>}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "occupancy" && <OccupancyOptimizationTab />}
      {activeTab === "pricing" && <PricingOptimizationTab />}
      {activeTab === "channels" && <ChannelOptimizationTab />}

      {activeTab === "dashboard" && (
        <>
      {slotModal && (
        <div className="fixed inset-0 bg-text/60 backdrop-blur-sm flex items-center justify-center z-[999]" onClick={() => setSlotModal(null)}>
          <div className="bg-surface border border-border shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="font-serif font-bold text-lg text-text">Room {slotModal.room}</h2>
                <p className="text-[10px] text-text-muted uppercase tracking-widest mt-0.5">{slotModal.category} · {slotModal.date}</p>
              </div>
              <span className={`text-[10px] uppercase tracking-wider font-bold px-2.5 py-1 border ${
                slotModal.block === "EMPTY" ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                : slotModal.block === "SOFT" ? "bg-sky-100 text-sky-800 border-sky-300"
                : "bg-stone-100 text-stone-700 border-stone-300"
              }`}>
                {slotModal.block === "EMPTY" ? "Available" : slotModal.block === "SOFT" ? "Booked" : "Blocked"}
              </span>
            </div>

            {/* Slot details */}
            <div className="px-6 py-4 space-y-2.5 border-b border-border">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted font-medium">Night rate</span>
                <span className="font-mono font-bold text-text">${slotModal.rate.toLocaleString("en-US")}</span>
              </div>
              {slotModal.block === "SOFT" && slotModal.channel && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted font-medium">Booked via</span>
                  <span className={`font-bold text-[10px] uppercase tracking-wider px-2 py-0.5 border ${
                    slotModal.channel === "OTA"    ? "bg-amber-50 text-amber-700 border-amber-200" :
                    slotModal.channel === "DIRECT" ? "bg-teal-50 text-teal-700 border-teal-200" :
                    slotModal.channel === "GDS"    ? "bg-violet-50 text-violet-700 border-violet-200" :
                    slotModal.channel === "WALKIN" ? "bg-orange-50 text-orange-700 border-orange-200" :
                                                    "bg-surface-2 text-text-muted border-border"
                  }`}>{slotModal.channel}</span>
                </div>
              )}
              {slotModal.block === "SOFT" && slotModal.booking_id && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted font-medium">Booking ID</span>
                  <span className="font-mono font-bold text-text bg-surface-2 border border-border px-2 py-0.5">{slotModal.booking_id}</span>
                </div>
              )}
              {slotModal.offer_type && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted font-medium">Offer</span>
                  <span className="font-mono font-bold text-accent bg-accent/5 border border-accent/20 px-2 py-0.5">
                    {slotModal.offer_type}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted font-medium">Slot ID</span>
                <span className="font-mono text-text-muted text-[10px]">{slotModal.id}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="px-6 py-4 space-y-2">
              {slotModal.block === "SOFT" ? (
                <p className="text-xs text-occuorange font-semibold bg-occuorange/8 border border-occuorange/20 px-3 py-2.5">
                  Active booking — cannot override manually. Cancel via Front Desk.
                </p>
              ) : (
                <div className="flex gap-2">
                  {slotModal.block !== "EMPTY" && (
                    <button type="button"
                      className="flex-1 bg-occugreen text-white text-sm font-semibold hover:bg-occugreen/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                      onClick={() => handleSlotPatch("EMPTY")}
                    >
                      <Unlock className="w-3.5 h-3.5" /> Mark Available
                    </button>
                  )}
                  {slotModal.block !== "HARD" && (
                    <button type="button"
                      className="flex-1 bg-text text-surface text-sm font-semibold hover:bg-text/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                      onClick={() => handleSlotPatch("HARD")}
                    >
                      <Lock className="w-3.5 h-3.5" /> Block
                    </button>
                  )}
                </div>
              )}
              <button type="button"
                className="w-full bg-surface-2 text-text text-sm font-semibold hover:bg-border active:scale-95 py-2.5 transition-all border border-border"
                onClick={() => setSlotModal(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div>
            <h1 className="font-serif font-bold text-2xl text-text tracking-tight">Recovery Dashboard</h1>
            <p className="text-xs tracking-wider text-text-muted mt-2 uppercase">
              Filter the slice, then recover sellable capacity
            </p>
          </div>
        </div>

        {/* Filters should lead the flow (slice definition) */}
        {heatmap && (
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <BirdseyeFilters
              weekSpan={weekSpan}
              onWeekSpanChange={setWeekSpan}
              availableCategories={heatmapCategories}
              selectedCategories={selectedCategories}
              onToggleCategory={handleToggleCategory}
            />
          </div>
        )}

        {/* Actions come after filters */}
        <div className="bg-surface border border-border shadow-subtle p-3 sm:p-4">
          <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                className="bg-occugreen text-white font-semibold hover:brightness-110 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-occugreen/40 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => runRecoveryPlan()}
                disabled={!heatmap || isOptimiseLoading}
                title="Runs preview shuffle + orphan-night offers for this slice"
              >
                Run guided recovery
              </button>
              <button
                type="button"
                className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => runOptimisePreview()}
                disabled={!heatmap || isOptimiseLoading}
              >
                {isOptimiseLoading ? "Scanning…" : "Preview recovery shuffle"}
              </button>
              <button
                type="button"
                className="bg-surface text-text font-semibold hover:bg-surface-2 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-border disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => runSandwichPlaybook()}
                disabled={!heatmap || isOptimiseLoading}
                title="Relaxes MinLOS on orphan-night gaps and refreshes offers"
              >
                Apply orphan-night offers
              </button>
              {swapPlan && (swapPlan.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => commitSwapShuffle()}
                  disabled={swapCommitLoading}
                  title="Write the preview shuffle to the DB so the heatmap improves immediately"
                >
                  {swapCommitLoading ? "Committing…" : `Commit shuffle (${swapPlan.length})`}
                </button>
              )}
              <button
                type="button"
                className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
                onClick={() => setShowAdvancedActions(v => !v)}
                title="Show advanced actions and toggles"
              >
                Advanced {showAdvancedActions ? "▲" : "▼"}
              </button>
          </div>

          {/* Advanced actions */}
          {showAdvancedActions && (
            <div className="mt-3 pt-3 border-t border-border/60 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`text-text font-semibold hover:bg-surface-2 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border ${
                  demoMode ? "bg-accent/10 border-accent/30" : "bg-surface border-border"
                }`}
                onClick={() => setDemoMode(v => !v)}
                title="Guided callouts for hackathon demo"
              >
                <Sparkles className="w-3.5 h-3.5 text-accent" />
                Demo mode {demoMode ? "On" : "Off"}
              </button>
              <button
                type="button"
                className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-border"
                onClick={() => refreshAllData()}
              >
                <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh data
              </button>
              {swapPlan && (
                <button
                  type="button"
                  className="bg-surface text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-border"
                  onClick={() => clearOptimisePreview()}
                >
                  Clear preview
                </button>
              )}
            </div>
          )}

          {/* Secondary row: k-night optimiser (advanced) */}
          {showAdvancedActions && heatmap && (
            <div className="mt-3 pt-3 border-t border-border/60 flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">
                  k-night optimisation
                </div>
                <KpiInfo
                  label="k-night optimisation"
                  text="Rearranges existing SOFT bookings to maximize bookable windows of length k within the current filtered heatmap slice."
                />
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={kNightNights}
                  onChange={e => setKNightNights(Math.max(1, Math.min(14, parseInt(e.target.value) || 1)))}
                  className="w-20 bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                  aria-label="k nights"
                />
                <button
                  type="button"
                  className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => runKNightPreview()}
                  disabled={kNightLoading}
                >
                  {kNightLoading ? "Previewing…" : "Preview k-night shuffle"}
                </button>
                {kNightSwapPlan && (kNightSwapPlan.length ?? 0) > 0 && (
                  <button
                    type="button"
                    className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
                    onClick={() => commitKNightShuffle()}
                    disabled={kNightCommitLoading}
                  >
                    {kNightCommitLoading ? "Committing…" : `Commit (${kNightSwapPlan.length ?? 0})`}
                  </button>
                )}
                {kNightSwapPlan && (
                  <div className="text-[9px] text-text-muted uppercase tracking-widest font-bold pb-0.5">
                    {kNightSwapPlan.length > 0 ? `${kNightSwapPlan.length} step(s) ready` : "No steps"}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Capacity Recovery Scorecard (hackathon spine KPI) */}
      <div className="mb-6">
        <div className={`border p-6 ${demoMode ? "bg-accent/5 border-accent/20" : "bg-surface border-border"}`}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Hackathon outcome</div>
              <div className="font-serif font-bold text-xl text-text">Capacity Recovery Scorecard</div>
              <div className="text-xs text-text-muted mt-1 max-w-2xl leading-relaxed">
                Before/after snapshot for the selected slice. Use <span className="font-bold text-text">Preview recovery shuffle</span> to generate a plan and see predicted deltas.
              </div>
            </div>
            <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-occuorange" />
              Focus: orphan nights ↓ · k-night windows ↑ · revenue at risk ↓
            </div>
          </div>

          {scorecardError && (
            <div className="mt-4 text-xs text-occured border border-occured/30 bg-occured/5 px-4 py-3">
              {scorecardError}
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="bg-surface border border-border p-4">
              <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Orphan nights</div>
              <div className="mt-1 text-3xl font-serif font-bold text-text tabular-nums">
                {scorecardLoading ? "…" : (scorecard?.before.orphan_nights ?? "—")}
              </div>
              {scorecard?.after && scorecard?.delta && (
                <div className="mt-2 text-[11px] font-bold tabular-nums flex items-baseline gap-3">
                  <span className="text-text-muted">After {scorecard.after.orphan_nights}</span>
                  <span className={(scorecard.delta.orphan_nights <= 0) ? "text-occugreen" : "text-occuorange"}>
                    Δ {scorecard.delta.orphan_nights}
                  </span>
                </div>
              )}
            </div>

            <div className="bg-surface border border-border p-4">
              <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Revenue at risk</div>
              <div className="mt-1 text-3xl font-serif font-bold text-text tabular-nums">
                {scorecardLoading ? "…" : `$${Math.round(scorecard?.before.revenue_at_risk ?? 0).toLocaleString("en-US")}`}
              </div>
              {scorecard?.after && scorecard?.delta && (
                <div className="mt-2 text-[11px] font-bold tabular-nums flex items-baseline gap-3">
                  <span className="text-text-muted">After ${Math.round(scorecard.after.revenue_at_risk).toLocaleString("en-US")}</span>
                  <span className={(scorecard.delta.revenue_at_risk <= 0) ? "text-occugreen" : "text-occuorange"}>
                    Δ {Math.round(scorecard.delta.revenue_at_risk).toLocaleString("en-US")}
                  </span>
                </div>
              )}
            </div>

            <div className="bg-surface border border-border p-4">
              <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Usable windows</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[2, 3].map(k => {
                  const before = scorecard?.before.k_windows?.[k] ?? 0;
                  const after = scorecard?.after?.k_windows?.[k] ?? null;
                  const delta = scorecard?.delta?.k_windows?.[k] ?? null;
                  return (
                    <div key={k} className="border border-border bg-surface-2/40 px-3 py-2">
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">k={k}</div>
                      <div className="text-xl font-serif font-bold text-text tabular-nums">
                        {scorecardLoading ? "…" : before}
                      </div>
                      {after !== null && delta !== null && (
                        <div className="text-[10px] font-bold tabular-nums mt-1">
                          <span className="text-text-muted">After {after}</span>{" "}
                          <span className={delta >= 0 ? "text-occugreen" : "text-occuorange"}>Δ {delta >= 0 ? `+${delta}` : delta}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {demoMode && (
                <div className="mt-3 text-[10px] text-text-muted uppercase tracking-widest font-bold">
                  Demo cue: run preview → point at deltas → commit shuffle → refresh heatmap
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {heatmap && dashboardInsights.length > 0 && (demoMode || showInsights) && (
        <div className="mt-4 bg-accent/5 border border-accent/20 p-6">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">
                Insights (auto-generated)
              </div>
              <ul className="space-y-2">
                {dashboardInsights.map((t, i) => (
                  <li key={i} className="text-sm text-text leading-relaxed">
                    {t}
                  </li>
                ))}
              </ul>
              <div className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-3">
                Based on the current filters and the visible heatmap window
              </div>
            </div>
          </div>
        </div>
      )}

      {heatmap && dashboardInsights.length > 0 && !demoMode && (
        <div className="mt-4">
          <button
            type="button"
            className="text-[10px] font-bold uppercase tracking-widest border border-border px-4 py-2 bg-surface hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
            onClick={() => setShowInsights(v => !v)}
          >
            {showInsights ? "Hide insights" : "Show insights"}
          </button>
        </div>
      )}

      {/* 60/40 layout: Heatmap (60) + KPIs (40) */}
      {heatmap && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
          <div className="bg-surface border border-border p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div>
                <h3 className="font-serif font-bold text-lg text-text">Inventory Heatmap</h3>
                <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-1">
                  Filtered to selected room types · visible window ({spanDays} night{spanDays === 1 ? "" : "s"})
                </p>
              </div>
              <div className="text-[9px] text-text-muted uppercase tracking-widest font-bold">
                Orphan-night gaps outlined
              </div>
            </div>

            <HeatmapGrid
              dates={heatmap.dates}
              rows={simulatedRows ?? filteredRows}
              maxDays={spanDays}
              highlightSandwichGaps
              onCellClick={setSlotModal}
            />
          </div>

          <div className="space-y-6">
            {/* KPI strip */}
            {dashboardKpis && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-surface border border-border p-4 flex flex-col gap-1 group hover:border-accent/40 transition-colors">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted font-bold">
                    <BedDouble className="w-3 h-3 text-accent" /> Tonight{" "}
                    <KpiInfo
                      label="Tonight"
                      text="Occupancy for the first night in the visible heatmap window (leftmost column), based on your selected room types."
                    />
                  </div>
                  <div className="text-2xl font-bold font-serif text-text tabular-nums">
                    {dashboardKpis.tonightInView
                      ? (
                        <>
                          {dashboardKpis.tonightOccupancyPct.toFixed(0)}
                          <span className="text-sm font-normal text-text-muted">%</span>
                        </>
                      )
                      : "—"}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {dashboardKpis.tonightInView
                      ? `${dashboardKpis.tonightRoomsOccupied} of ${dashboardKpis.tonightTotalRooms} rooms · ${dashboardKpis.firstNightLabel}`
                      : "No calendar loaded"}
                  </div>
                </div>

                <div className="bg-surface border border-border p-4 flex flex-col gap-1 group hover:border-accent/40 transition-colors">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted font-bold">
                    <DollarSign className="w-3 h-3 text-accent" /> Average rate{" "}
                    <KpiInfo
                      label="Average rate"
                      text="Mean nightly rate across all occupied (non-EMPTY) slots in the current filtered window."
                    />
                  </div>
                  <div className="text-2xl font-bold font-serif text-text tabular-nums">
                    ${Math.round(dashboardKpis.avgRateInView).toLocaleString("en-US")}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {dashboardKpis.avgRateNightCount > 0
                      ? `${dashboardKpis.avgRateNightCount} occupied night${dashboardKpis.avgRateNightCount === 1 ? "" : "s"} in range`
                      : "No occupied nights in selected range"}
                  </div>
                </div>

                <div className={`border p-4 flex flex-col gap-1 group transition-colors ${dashboardKpis.orphanNightsAtRisk > 0 ? "bg-occuorange/5 border-occuorange/30 hover:border-occuorange/50" : "bg-surface border-border hover:border-accent/40"}`}>
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted font-bold">
                    <AlertTriangle className={`w-3 h-3 ${dashboardKpis.orphanNightsAtRisk > 0 ? "text-occuorange" : "text-accent"}`} /> Nights at risk{" "}
                    <KpiInfo
                      label="Nights at risk"
                      text="Count of single EMPTY nights trapped between non-EMPTY nights in the same room row (orphan-night gaps). These are hard to sell."
                    />
                  </div>
                  <div className={`text-2xl font-bold font-serif tabular-nums ${dashboardKpis.orphanNightsAtRisk > 0 ? "text-occuorange" : "text-text"}`}>
                    {dashboardKpis.orphanNightsAtRisk}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {dashboardKpis.orphanNightsAtRisk > 0
                      ? `$${dashboardKpis.orphanRevenueAtRisk.toLocaleString("en-US")} at risk`
                      : "No orphan gaps in selected range"}
                  </div>
                </div>

                <div className={`border p-4 flex flex-col gap-1 group transition-colors ${dashboardKpis.sandwichMinlosBlockedNights > 0 ? "bg-text/3 border-text/20 hover:border-text/30" : "bg-surface border-border hover:border-accent/40"}`}>
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted font-bold">
                    <AlertTriangle className={`w-3 h-3 ${dashboardKpis.sandwichMinlosBlockedNights > 0 ? "text-text" : "text-accent"}`} /> MinLOS blocks{" "}
                    <KpiInfo
                      label="MinLOS blocks"
                      text="Sandwich-gap nights where MinLOS is active (Min stay > 1), making them effectively unbookable unless rules are relaxed."
                    />
                  </div>
                  <div className="text-2xl font-bold font-serif tabular-nums text-text">
                    {dashboardKpis.sandwichMinlosBlockedNights}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {dashboardKpis.sandwichMinlosBlockedNights > 0
                      ? "Orphan-night gaps blocked by MinLOS"
                      : "No MinLOS blocks in this slice"}
                  </div>
                </div>
              </div>
            )}

            {/* Operational run metrics */}
            {runMetrics && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-surface border border-border p-4 group hover:border-accent/40 transition-colors">
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">
                    <span>Empty gaps</span>
                    <KpiInfo
                      label="Empty gaps"
                      text="Number of short EMPTY runs (≤5 nights) bounded by non-EMPTY nights on both sides within the same room row."
                    />
                  </div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">{runMetrics.orphanGaps}</div>
                  <div className="text-[10px] text-text-muted mt-1">{runMetrics.orphanNights} orphan night{runMetrics.orphanNights === 1 ? "" : "s"} (≤ 5)</div>
                </div>
                <div className="bg-surface border border-border p-4 group hover:border-accent/40 transition-colors">
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">
                    <span>Hard to fill rooms</span>
                    <KpiInfo
                      label="Hard to fill rooms"
                      text="Count of 1–3 night EMPTY gaps (runs) across the visible window — these have low conversion in practice."
                    />
                  </div>
                  <div className="text-2xl font-serif font-bold text-occuorange tabular-nums">
                    {(runMetrics.dist.n1 + runMetrics.dist.n2_3).toLocaleString()}
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">1–3 night gaps</div>
                </div>
              </div>
            )}

            {/* Availability at a glance (numbers-only to save space) */}
            {snapshot && (
              <BirdseyeInventoryHighlights
                snapshot={snapshot}
                projectedSnapshot={projectedSnapshot}
                maxDays={spanDays}
                columns={1}
                mode="numbers"
              />
            )}
          </div>
        </div>
      )}

      {heatmap && snapshot && filteredRows.length === 0 && (
        <div className="bg-surface border border-border py-12 px-6 text-center text-sm text-text-muted mt-6">
          No rooms match the selected types for this hotel.
        </div>
      )}

      {!heatmap && (
        <div className="bg-surface border border-border py-16 px-6 text-center">
          <Grid3x3 className="w-8 h-8 text-accent/50 mx-auto mb-4" />
          {isHeatmapLoading ? (
            <>
              <h2 className="text-xl font-serif font-bold text-text mb-2">Loading your bookings...</h2>
              <p className="text-xs text-text-muted font-medium mb-6 max-w-sm mx-auto leading-relaxed">
                Fetching your room calendar and generating insights…
              </p>
              <div className="max-w-sm mx-auto">
                <div className="h-10 bg-surface-2 border border-border/60 animate-pulse" />
              </div>
            </>
          ) : (
            <>
              <h2 className="text-xl font-serif font-bold text-text mb-2">Couldn't load your rooms</h2>
              <p className="text-xs text-text-muted font-medium mb-6 max-w-sm mx-auto leading-relaxed">
                {heatmapLoadError ?? "Something went wrong loading your booking calendar. Please try again."}
              </p>
              <button
                type="button"
                className="bg-text text-surface font-semibold hover:bg-text/90 text-xs uppercase tracking-widest px-8 py-3"
                onClick={() => loadHeatmap()}
              >
                Retry load
              </button>
            </>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
}
