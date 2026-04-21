import { useState, useCallback, useEffect, useMemo } from "react";
import { getHeatmap, getOccupancyForecast, dashboardOptimisePreview, patchSlot } from "../api/client";
import type { HeatmapResponse, HeatmapRow, OccupancyForecastResponse, RoomCategory, SwapStep, DashboardOptimisePreviewResponse } from "../types";
import { HeatmapGrid, type CellClickInfo } from "../components/Heatmap/HeatmapGrid";
import { BirdseyeInventoryHighlights } from "../components/BirdseyeInventoryHighlights";
import { BirdseyeFilters, type BirdseyeWeekSpan } from "../components/BirdseyeFilters";
import { BirdseyeForecastInsights } from "../components/BirdseyeForecastInsights";
import { BirdseyeCompressionInsights } from "../components/BirdseyeCompressionInsights";
import { useToast } from "../components/shared/Toast";
import { computeEmptyRunInventory } from "../utils/inventoryAvailability";
import { simulateRows } from "../utils/simulateRows";
import { calendarDayKey } from "../utils/calendarDayKey";
import { ChannelOptimizationTab } from "../components/overview/ChannelOptimizationTab";
import { OccupancyOptimizationTab } from "../components/overview/OccupancyOptimizationTab";
import { PricingOptimizationTab } from "../components/overview/PricingOptimizationTab";
import { BarChart2, DollarSign, Grid3x3, RefreshCw, Lock, Unlock, BedDouble, AlertTriangle, Zap } from "lucide-react";
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
};

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
  const [forecast, setForecast] = useState<OccupancyForecastResponse | null>(null);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState<boolean>(false);
  const [isForecastLoading, setIsForecastLoading] = useState<boolean>(false);
  const [isOptimiseLoading, setIsOptimiseLoading] = useState<boolean>(false);
  const [swapPlan, setSwapPlan] = useState<SwapStep[] | null>(null);
  const [heatmapLoadError, setHeatmapLoadError] = useState<string | null>(null);
  const [weekSpan, setWeekSpan] = useState<BirdseyeWeekSpan>(3);
  const [selectedCategories, setSelectedCategories] = useState<RoomCategory[]>([]);
  const [slotModal, setSlotModal] = useState<CellClickInfo | null>(null);
  const { show, Toasts } = useToast();

  const loadHeatmap = useCallback(async () => {
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
    } catch {
      setHeatmap(null);
      setSelectedCategories([]);
      setHeatmapLoadError("The occupancy matrix could not be loaded. Check the API connection, then try again.");
    }
    setIsHeatmapLoading(false);
  }, [show]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  const loadForecast = useCallback(async () => {
    if (!heatmap) return;
    setIsForecastLoading(true);
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      // `as_of` is the pickup / on-books cutoff for the analytics API: bookings with created_at
      // after this date are excluded. Must match "today" so on-the-books % aligns with the live
      // heatmap; using the window start made on-books look nearly empty while the grid showed SOFT.
      const asOfStr = formatISO(new Date(), { representation: "date" });

      const res = await getOccupancyForecast({ start: startStr, end: endStr, as_of: asOfStr });
      setForecast(res.data);
    } catch {
      // Keep the dashboard functional even if analytics is unavailable.
      setForecast(null);
    }
    setIsForecastLoading(false);
  }, [heatmap, weekSpan]);

  useEffect(() => {
    loadForecast();
  }, [loadForecast]);

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

  const dashboardKpis = useMemo((): BirdseyeDashboardKpis | null => {
    if (!heatmap || filteredRows.length === 0 || spanDays === 0) return null;
    return computeBirdseyeDashboardKpis(heatmap.dates, filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  /** Calendar keys for heatmap columns in view; keeps forecast chart aligned with the grid span. */
  const visibleForecastDateKeys = useMemo(
    () => (heatmap ? heatmap.dates.slice(0, spanDays).map(d => calendarDayKey(String(d))) : []),
    [heatmap, spanDays],
  );

  const snapshot = useMemo(() => {
    if (!heatmap) return null;
    return computeEmptyRunInventory(filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  const simulatedRows = useMemo(() => {
    if (!heatmap || !swapPlan || swapPlan.length === 0) return null;
    return simulateRows(filteredRows, swapPlan);
  }, [heatmap, filteredRows, swapPlan]);

  const projectedSnapshot = useMemo(() => {
    if (!simulatedRows) return null;
    return computeEmptyRunInventory(simulatedRows, spanDays);
  }, [simulatedRows, spanDays]);

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
      if ((body.swap_plan?.length ?? 0) === 0) {
        if (body.fully_clean) show("No orphan gaps detected in the current slice.", "success");
        else show("No improvements found for the current slice (converged).", "info");
      } else {
        show(`Preview ready: ${body.shuffle_count} optimisation steps`, "success");
      }
    } catch {
      show("Failed to run optimisation preview", "error");
      setSwapPlan(null);
    } finally {
      setIsOptimiseLoading(false);
    }
  }, [heatmap, weekSpan, selectedCategories, show]);

  const clearOptimisePreview = useCallback(() => setSwapPlan(null), []);

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
                <span className="font-mono font-bold text-text">₹{slotModal.rate.toLocaleString()}</span>
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

      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 border-b border-border/50 pb-6">
        <div>
          <h1 className="font-serif font-bold text-2xl text-text tracking-tight">Occupancy Overview</h1>
          <p className="text-xs tracking-wider text-text-muted mt-2 uppercase">
            Your rooms, bookings, and availability at a glance
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          <button
            type="button"
            className="self-start sm:self-auto bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-border"
            onClick={() => loadHeatmap()}
          >
            <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh data
          </button>
          <button
            type="button"
            className="self-start sm:self-auto bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={() => runOptimisePreview()}
            disabled={!heatmap || isOptimiseLoading}
          >
            {isOptimiseLoading ? "Scanning…" : "Find empty gaps"}
          </button>
          {swapPlan && (
            <button
              type="button"
              className="self-start sm:self-auto bg-surface text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-border"
              onClick={() => clearOptimisePreview()}
            >
              Clear preview
            </button>
          )}
        </div>
      </div>

      {heatmap && (
        <BirdseyeFilters
          weekSpan={weekSpan}
          onWeekSpanChange={setWeekSpan}
          availableCategories={heatmapCategories}
          selectedCategories={selectedCategories}
          onToggleCategory={handleToggleCategory}
        />
      )}

      {dashboardKpis && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
          <div className="bg-surface border border-border p-4 flex flex-col gap-1 group hover:border-accent/40 transition-colors">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted font-bold">
              <BedDouble className="w-3 h-3 text-accent" /> Tonight
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
              <DollarSign className="w-3 h-3 text-accent" /> Average rate
            </div>
            <div className="text-2xl font-bold font-serif text-text tabular-nums">
              ₹{Math.round(dashboardKpis.avgRateInView).toLocaleString()}
            </div>
            <div className="text-[10px] text-text-muted">
              {dashboardKpis.avgRateNightCount > 0
                ? `Mean nightly rate · ${dashboardKpis.avgRateNightCount} occupied night${dashboardKpis.avgRateNightCount === 1 ? "" : "s"} in range`
                : "No occupied nights in selected range"}
            </div>
          </div>
          <div className={`border p-4 flex flex-col gap-1 group transition-colors ${dashboardKpis.orphanNightsAtRisk > 0 ? "bg-occuorange/5 border-occuorange/30 hover:border-occuorange/50" : "bg-surface border-border hover:border-accent/40"}`}>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted font-bold">
              <AlertTriangle className={`w-3 h-3 ${dashboardKpis.orphanNightsAtRisk > 0 ? "text-occuorange" : "text-accent"}`} /> Nights at risk
            </div>
            <div className={`text-2xl font-bold font-serif tabular-nums ${dashboardKpis.orphanNightsAtRisk > 0 ? "text-occuorange" : "text-text"}`}>
              {dashboardKpis.orphanNightsAtRisk}
            </div>
            <div className="text-[10px] text-text-muted">
              {dashboardKpis.orphanNightsAtRisk > 0
                ? `₹${dashboardKpis.orphanRevenueAtRisk.toLocaleString()} at risk`
                : "No orphan gaps in selected range"}
            </div>
          </div>
        </div>
      )}

      {heatmap && (forecast || isForecastLoading) && (
        <div className="mt-6">
          {forecast ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
              <BirdseyeForecastInsights
                forecast={forecast}
                selectedCategories={selectedCategories}
                visibleForecastDateKeys={visibleForecastDateKeys}
              />
              <BirdseyeCompressionInsights dates={heatmap.dates} rows={filteredRows} maxDays={spanDays} />
            </div>
          ) : (
            <div className="bg-surface border border-border shadow-subtle">
              <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-bold text-xs text-text uppercase tracking-widest">Occupancy forecast</h3>
                  <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold">Loading</div>
                </div>
                <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">
                  Analysing past booking patterns to predict upcoming occupancy…
                </p>
              </div>
              <div className="p-3">
                <div className="h-10 bg-surface-2 border border-border/60 animate-pulse" />
              </div>
            </div>
          )}
        </div>
      )}

      {heatmap && snapshot && (
        <>
          {filteredRows.length === 0 ? (
            <div className="bg-surface border border-border py-12 px-6 text-center text-sm text-text-muted">
              No rooms match the selected types for this hotel.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-stretch mt-8">
              <div className="min-h-[320px] min-w-0">
                <div className="bg-surface border border-border p-4 sm:p-6 h-full overflow-x-auto">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={filteredRows}
                    title="Current Occupancy"
                    compact
                    maxDays={spanDays}
                    hideLegend
                    onCellClick={setSlotModal}
                  />
                </div>
              </div>
              <aside className="flex flex-col min-h-0">
                <BirdseyeInventoryHighlights snapshot={snapshot} projectedSnapshot={projectedSnapshot} maxDays={spanDays} />
              </aside>
            </div>
          )}
        </>
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
