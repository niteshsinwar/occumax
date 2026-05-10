import { useState, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  dashboardCommitShuffle,
  dashboardOptimiseKNightPreview,
  getHeatmap,
  dashboardOptimisePreview,
  dashboardScorecard,
  getOccupancyForecast,
  getPace,
  getChannelPerformance,
} from "../api/client";
import type {
  DashboardOptimisePreviewResponse,
  DashboardScorecardResponse,
  HeatmapResponse,
  HeatmapRow,
  OccupancyForecastResponse,
  OccupancyPoint,
  RoomCategory,
  SwapStep,
  ChannelPerformanceResponse,
  PaceResponse,
} from "../types";
import { useToast } from "../components/shared/Toast";
import { simulateRows } from "../utils/simulateRows";
import { calendarDayKey } from "../utils/calendarDayKey";
import { OCCUPANCY_HEATMAP_VISIBLE_DAYS, useOccupancyPredictiveLos } from "../hooks/useOccupancyPredictiveLos";
import { ChannelOptimizationTab } from "../components/overview/ChannelOptimizationTab";
import { OccupancyOptimizationTab } from "../components/overview/OccupancyOptimizationTab";
import { PricingOptimizationTab } from "../components/overview/PricingOptimizationTab";
import { ExogenousDemandSignals } from "../components/overview/ExogenousDemandSignals";
import { OverviewSignalsProvider } from "../context/overviewSignals";
import { BarChart2, Bed, DollarSign, Grid3x3, RefreshCw, AlertTriangle, TrendingDown, TrendingUp, Zap, ArrowRight } from "lucide-react";
import { addDays, formatISO, parseISO, subDays, subYears } from "date-fns";
import {
  overviewCardClass,
  overviewCardLgClass,
  overviewEyebrowClass,
  overviewSecondaryBtnClass,
  overviewStackClass,
  overviewTitleClass,
} from "../components/overview/overviewChrome";

/** Heatmap columns used for Dashboard KPIs, scorecard, pace, and channel analytics (from anchor night). */
const DASHBOARD_WINDOW_DAYS = 15;

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

/** KPI numbers derived from the same heatmap slice as the grid (category + fixed dashboard window). */
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

type ChannelMix = Record<string, number>;

function computeChannelMix(rows: HeatmapRow[], maxDays: number): ChannelMix {
  const mix: ChannelMix = {};
  for (const r of rows) {
    for (const c of r.cells.slice(0, maxDays)) {
      if (!c || c.block_type !== "SOFT") continue;
      const ch = c.channel ?? "UNKNOWN";
      mix[ch] = (mix[ch] ?? 0) + 1;
    }
  }
  return mix;
}

function estimatedCancellationRate(mix: ChannelMix): number | null {
  // Heuristic only (no historical cancellations in current API payload).
  // Rates chosen to be directionally correct for demo UX.
  const rates: Record<string, number> = {
    OTA: 0.18,
    DIRECT: 0.08,
    WALKIN: 0.03,
    CLOSED: 0.0,
    UNKNOWN: 0.1,
  };
  const entries = Object.entries(mix);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total <= 0) return null;
  const weighted = entries.reduce((s, [ch, n]) => s + (rates[ch] ?? 0.1) * n, 0);
  return Math.round((weighted / total) * 100);
}

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

/** Hotel-wide rollup series (`category == null`) from occupancy forecast. */
function rollupOccupancyPoints(forecast: OccupancyForecastResponse | null): OccupancyPoint[] {
  if (!forecast?.series?.length) return [];
  const rolled = forecast.series.find(s => s.category == null);
  return rolled?.points ?? [];
}

/**
 * Maps calendar dates to realized occupancy % using `occupied_rooms_actual` / `total_rooms`
 * (populated by the API for nights where at least one non-EMPTY slot exists for aggregation).
 */
function actualOccPctByDateMap(points: OccupancyPoint[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of points) {
    if (p.occupied_rooms_actual == null || p.total_rooms <= 0) continue;
    const dayKey = String(p.date).slice(0, 10);
    m.set(dayKey, (p.occupied_rooms_actual / p.total_rooms) * 100);
  }
  return m;
}

/**
 * Interprets a heatmap anchor as a civil calendar date in local time (avoids UTC shifting from `parseISO("YYYY-MM-DD")`).
 */
function heatmapAnchorCalendarDate(iso: string): Date {
  const part = String(iso).split("T")[0] ?? "";
  const [y, m, d] = part.split("-").map(Number);
  if (!y || !m || !d) return parseISO(iso);
  return new Date(y, m - 1, d);
}

/**
 * Simple normalized sparkline for compact KPI cards (daily totals in property currency units).
 */
function MiniRevenueSparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={className} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 112;
  const h = 32;
  const pad = 3;
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = pad + (1 - (v - min) / span) * (h - 2 * pad);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg className={className} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" points={pts} className="text-accent/75" />
    </svg>
  );
}

/**
 * Dashboard (Bird's Eye View): occupancy matrix and k-night bookable-window counts (overlapping, per EMPTY strip) by length and room category.
 * Uses `GET /dashboard/heatmap`; slot edits use the same admin slot patch as the manager heatmap.
 * Date span is a fixed **15-night** window from the heatmap anchor (capped by payload length); room-type filters apply only on this page (client-side slice of the shared heatmap payload).
 * Room types for filters are taken from the heatmap payload (active rooms / categories from the API), not a fixed list.
 * KPI strip below the filters is computed from the same filtered rows and visible day span (not the global revenue-summary endpoint).
 */
export function Dashboard() {
  type OverviewTab = "dashboard" | "occupancy" | "pricing" | "channels";

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = useMemo((): OverviewTab => {
    const t = searchParams.get("tab");
    if (t === "occupancy" || t === "pricing" || t === "channels" || t === "dashboard") return t;
    return "dashboard";
  }, [searchParams]);

  /** Sets Overview subtab; cleans URL when the default Dashboard tab is selected. */
  const setActiveTab = useCallback(
    (tab: OverviewTab) => {
      if (tab === "dashboard") setSearchParams({}, { replace: true });
      else setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams],
  );

  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState<boolean>(false);
  const [swapPlan, setSwapPlan] = useState<SwapStep[] | null>(null);
  const [swapCommitLoading, setSwapCommitLoading] = useState(false);
  const [kNightNights, setKNightNights] = useState<number>(2);
  const [kNightSwapPlan, setKNightSwapPlan] = useState<SwapStep[] | null>(null);
  const [kNightLoading, setKNightLoading] = useState(false);
  const [kNightCommitLoading, setKNightCommitLoading] = useState(false);
  const [heatmapLoadError, setHeatmapLoadError] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<RoomCategory[]>([]);

  // Hackathon scorecard (before/after + deltas)
  const [scorecard, setScorecard] = useState<DashboardScorecardResponse | null>(null);
  const [scorecardLoading, setScorecardLoading] = useState(false);
  const { show, Toasts } = useToast();

  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);
  const [pace, setPace] = useState<PaceResponse | null>(null);
  const [channelPerf, setChannelPerf] = useState<ChannelPerformanceResponse | null>(null);
  /** Used for yesterday / same-date-last-year occupancy (realized counts from analytics). */
  const [occupancyForecast, setOccupancyForecast] = useState<OccupancyForecastResponse | null>(null);

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
    return Math.min(DASHBOARD_WINDOW_DAYS, heatmap.dates.length);
  }, [heatmap]);

  const scorecardSlice = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const start = parseISO(heatmap.dates[0]);
    const end = addDays(start, spanDays);
    return {
      startStr: formatISO(start, { representation: "date" }),
      endStr: formatISO(end, { representation: "date" }),
    };
  }, [heatmap, spanDays]);

  useEffect(() => {
    if (!scorecardSlice) return;
    const { startStr, endStr } = scorecardSlice;

    getPace({ start: startStr, end: endStr, as_of: todayStr })
      .then(res => setPace(res.data as PaceResponse))
      .catch(() => setPace(null));

    getChannelPerformance({ start: startStr, end: endStr, categories: selectedCategories })
      .then(res => setChannelPerf(res.data as ChannelPerformanceResponse))
      .catch(() => setChannelPerf(null));
  }, [scorecardSlice?.endStr, scorecardSlice?.startStr, selectedCategories, todayStr]);

  /** Load a tight calendar window covering last night + same calendar date last year through the heatmap anchor night. */
  useEffect(() => {
    if (!heatmap?.dates?.[0]) {
      setOccupancyForecast(null);
      return;
    }
    const firstNight = heatmapAnchorCalendarDate(String(heatmap.dates[0]));
    const yesterday = subDays(firstNight, 1);
    const lastYearNight = subYears(firstNight, 1);
    const rangeStart = yesterday.getTime() <= lastYearNight.getTime() ? yesterday : lastYearNight;
    const rangeEnd = firstNight;
    /** Align cutoff with property board: never send UTC-only “today” behind the heatmap anchor (was clipping yester-night server-side). */
    const anchorIso = formatISO(firstNight, { representation: "date" });
    const asOfStr = anchorIso >= todayStr ? anchorIso : todayStr;
    let cancelled = false;
    getOccupancyForecast({
      start: formatISO(rangeStart, { representation: "date" }),
      end: formatISO(rangeEnd, { representation: "date" }),
      as_of: asOfStr,
    })
      .then(res => {
        if (!cancelled) setOccupancyForecast(res.data as OccupancyForecastResponse);
      })
      .catch(() => {
        if (!cancelled) setOccupancyForecast(null);
      });
    return () => {
      cancelled = true;
    };
  }, [heatmap?.dates?.[0], todayStr]);

  const refreshScorecard = useCallback(async (plan?: SwapStep[] | null) => {
    if (!scorecardSlice) return;
    setScorecardLoading(true);
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
    } finally {
      setScorecardLoading(false);
    }
  }, [scorecardSlice, selectedCategories]);

  const simulatedRows = useMemo(() => {
    const plan = (kNightSwapPlan && kNightSwapPlan.length > 0) ? kNightSwapPlan : swapPlan;
    if (!heatmap || !plan || plan.length === 0) return null;
    return simulateRows(filteredRows, plan);
  }, [heatmap, filteredRows, kNightSwapPlan, swapPlan]);

  const occupancySpanDays = useMemo(() => {
    if (!heatmap) return 0;
    return Math.min(OCCUPANCY_HEATMAP_VISIBLE_DAYS, heatmap.dates.length);
  }, [heatmap]);

  const occupancyPredictive = useOccupancyPredictiveLos({
    heatmap,
    selectedCategories,
    kNightNights,
    setKNightNights,
    setKNightSwapPlan,
    setSwapPlan,
    refreshScorecard,
    show,
    setKNightLoading,
  });

  useEffect(() => {
    if (activeTab !== "occupancy" || !heatmap || selectedCategories.length === 0) return;
    void occupancyPredictive.reloadPredictiveLos();
  }, [activeTab, heatmap?.dates?.[0], selectedCategories.join("|"), occupancyPredictive.reloadPredictiveLos]);

  const refreshAllData = useCallback(async () => {
    await loadHeatmap();
  }, [loadHeatmap]);

  // Keep the baseline scorecard in sync with the current filters/slice.
  useEffect(() => {
    if (!scorecardSlice || selectedCategories.length === 0) return;
    void refreshScorecard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scorecardSlice?.startStr, scorecardSlice?.endStr, selectedCategories.join("|")]);

  // ── V2 computed values (bird's-eye, always uses allRows — not filtered) ──────

  const allRows = useMemo(() => heatmap?.rows ?? [], [heatmap]);

  const v2Kpis = useMemo(() => {
    if (!heatmap || allRows.length === 0 || spanDays === 0) return null;
    return computeBirdseyeDashboardKpis(heatmap.dates, allRows, spanDays);
  }, [heatmap, allRows, spanDays]);

  const v2RunMetrics = useMemo(() => {
    if (!heatmap || allRows.length === 0 || spanDays === 0) return null;
    return computeRunMetrics(allRows, spanDays);
  }, [heatmap, allRows, spanDays]);

  const v2ChannelMix = useMemo(() => {
    if (!heatmap || allRows.length === 0 || spanDays === 0) return null;
    return computeChannelMix(allRows, spanDays);
  }, [heatmap, allRows, spanDays]);

  const v2CancelRate = useMemo(() => (v2ChannelMix ? estimatedCancellationRate(v2ChannelMix) : null), [v2ChannelMix]);

  const paceDelta = useMemo(() => {
    if (!pace?.series || pace.series.length === 0) return null;
    let total = 0, count = 0;
    for (const s of pace.series) for (const p of s.points ?? []) { total += (p.on_books_occ_pct - p.expected_on_books_occ_pct); count++; }
    return count > 0 ? total / count : null;
  }, [pace]);

  const pricingExposure = useMemo(() => {
    if (!heatmap || allRows.length === 0 || spanDays === 0) {
      return { unsoldRoomNights: 0, revenueAtRisk: 0, revenueOnBooks: 0, discountedRoomNights: 0 };
    }

    let unsoldRoomNights = 0;
    let revenueAtRisk = 0;
    let revenueOnBooks = 0;
    let discountedRoomNights = 0;

    for (const row of allRows) {
      const cells = row.cells.slice(0, spanDays);
      for (const c of cells) {
        if (!c) continue;
        if (c.block_type === "EMPTY") {
          unsoldRoomNights += 1;
          revenueAtRisk += Number(c.current_rate ?? 0);
          if (Number(c.current_rate ?? 0) < Number(row.base_rate ?? 0) * 0.95) discountedRoomNights += 1;
        } else {
          revenueOnBooks += Number(c.current_rate ?? 0);
        }
      }
    }

    return {
      unsoldRoomNights,
      revenueAtRisk: Math.round(revenueAtRisk),
      revenueOnBooks: Math.round(revenueOnBooks),
      discountedRoomNights,
    };
  }, [heatmap, allRows, spanDays]);

  function formatUsdShort(n: number): string {
    const v = Math.round(n);
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}k`;
    return `$${v.toLocaleString("en-US")}`;
  }

  const channelProfitKpis = useMemo(() => {
    const ota = channelPerf?.channels?.find(c => String(c.channel).toUpperCase() === "OTA");
    const partners = ota?.partners ?? [];
    const partnerNetRevenueTop = [...partners]
      .filter(p => (p.net_revenue ?? 0) > 0)
      .sort((a, b) => (b.net_revenue ?? 0) - (a.net_revenue ?? 0))
      .slice(0, 4)
      .map(p => ({ partner: p.partner, value: p.net_revenue }));

    const partnerNetAdrTop = [...partners]
      .filter(p => (p.room_nights ?? 0) > 0)
      .map(p => ({ partner: p.partner, value: p.net_revenue / Math.max(1, p.room_nights) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);

    const maxPartnerNetRevenue = Math.max(1, ...partnerNetRevenueTop.map(p => p.value));
    const maxPartnerNetAdr = Math.max(1, ...partnerNetAdrTop.map(p => p.value));

    const otaLeakage = ota ? ota.gross_revenue - ota.net_revenue : null;
    const otaLeakagePct = ota && ota.gross_revenue > 0 ? (otaLeakage! / ota.gross_revenue) * 100 : null;

    return {
      ota,
      otaLeakage,
      otaLeakagePct,
      partnerNetRevenueTop,
      partnerNetAdrTop,
      maxPartnerNetRevenue,
      maxPartnerNetAdr,
    };
  }, [channelPerf]);

  /** Daily on-books revenue by heatmap column (SOFT/HARD rate sum) for the KPI window sparkline. */
  const revenueOnBooksByDay = useMemo(() => {
    if (!heatmap || allRows.length === 0 || spanDays === 0) return [];
    const days = Math.min(spanDays, heatmap.dates.length);
    const out: number[] = [];
    for (let d = 0; d < days; d++) {
      let sum = 0;
      for (const row of allRows) {
        const c = row.cells[d];
        if (c && c.block_type !== "EMPTY") sum += Number(c.current_rate ?? 0);
      }
      out.push(sum);
    }
    return out;
  }, [heatmap, allRows, spanDays]);

  /**
   * Yesterday vs same calendar date prior year — realized occupancy from forecast rollup.
   * Null when `occupied_rooms_actual` is absent (usually no slot history that night; run analytics history seed if missing).
   */
  const histOccContext = useMemo(() => {
    const pts = rollupOccupancyPoints(occupancyForecast);
    const byDate = actualOccPctByDateMap(pts);
    if (!heatmap?.dates?.[0])
      return { yesterdayPct: null as number | null, lyPct: null as number | null, vsLyPpt: null as number | null };
    const anchorCal = heatmapAnchorCalendarDate(String(heatmap.dates[0]));
    const yKey = formatISO(subDays(anchorCal, 1), { representation: "date" });
    const lyKey = formatISO(subYears(anchorCal, 1), { representation: "date" });
    const yesterdayPct = byDate.get(yKey) ?? null;
    const lyPct = byDate.get(lyKey) ?? null;
    const tonightPct = v2Kpis?.tonightOccupancyPct;
    const vsLyPpt =
      tonightPct != null && lyPct != null ? Math.round(tonightPct - lyPct) : null;
    return { yesterdayPct, lyPct, vsLyPpt };
  }, [occupancyForecast, heatmap?.dates?.[0], v2Kpis?.tonightOccupancyPct]);

  /** Top partners with paired net revenue + net ADR for the grouped spotlight card. */
  const dashboardPartnerSpotlight = useMemo(() => {
    const tops = channelProfitKpis.partnerNetRevenueTop.slice(0, 3);
    const adrByName = new Map(channelProfitKpis.partnerNetAdrTop.map(p => [p.partner, p.value]));
    const dotClass = ["bg-accent", "bg-violet-500", "bg-rose-500"];
    return tops.map((p, i) => ({
      partner: p.partner,
      net: p.value,
      adr: adrByName.get(p.partner) ?? 0,
      dotClass: dotClass[i % dotClass.length]!,
    }));
  }, [channelProfitKpis]);

  const revenueAtRiskThresholdUsd = 250_000;
  const revenueAtRiskBarPct = Math.min(
    100,
    pricingExposure.revenueAtRisk > 0 ? (pricingExposure.revenueAtRisk / revenueAtRiskThresholdUsd) * 100 : 0,
  );

  type ActionItem = { priority: "HIGH" | "MED" | "LOW"; category: string; tab: OverviewTab; title: string; detail: string };

  const actionQueue = useMemo((): ActionItem[] => {
    const items: ActionItem[] = [];
    const orphans = scorecard?.before.orphan_nights ?? v2Kpis?.orphanNightsAtRisk ?? 0;
    const revRisk = pricingExposure.revenueAtRisk;

    if (orphans > 5)
      items.push({ priority: "HIGH", category: "Occupancy", tab: "occupancy", title: `${orphans} orphan nights stranded`, detail: `$${Math.round(revRisk).toLocaleString("en-US")} estimated revenue at risk — run a room shuffle to consolidate gaps into bookable runs.` });
    else if (orphans > 0)
      items.push({ priority: "MED", category: "Occupancy", tab: "occupancy", title: `${orphans} orphan night${orphans !== 1 ? "s" : ""} found`, detail: `$${Math.round(revRisk).toLocaleString("en-US")} at risk — consider a room shuffle to recover usable capacity.` });

    if (paceDelta !== null && paceDelta < -5)
      items.push({ priority: "HIGH", category: "Channels", tab: "channels", title: `Pace ${Math.abs(Math.round(paceDelta))} occ-pts behind 2yr baseline`, detail: "Pickup is significantly softer than expected — review channel mix and consider promotional activation." });
    else if (paceDelta !== null && paceDelta < -2)
      items.push({ priority: "MED", category: "Channels", tab: "channels", title: `Pace slightly behind baseline (${Math.abs(Math.round(paceDelta))} occ-pts)`, detail: "Monitor demand — consider activating US-active OTA promotions while holding stronger nights for direct hotel selling." });

    const mixTotal = v2ChannelMix ? Object.values(v2ChannelMix).reduce((s, n) => s + n, 0) : 0;
    const otaShare = mixTotal > 0 ? Math.round(((v2ChannelMix?.["OTA"] ?? 0) / mixTotal) * 100) : 0;
    if (otaShare > 65 && mixTotal > 0)
      items.push({ priority: "MED", category: "Channels", tab: "channels", title: `OTA concentration at ${otaShare}%`, detail: "Heavy OTA dependency compresses net margin — hold unallocated inventory for direct hotel selling." });

    items.push({ priority: "MED", category: "Pricing", tab: "pricing", title: "Run RateIQ pricing analysis", detail: "AI agent synthesizes weather, events, market signals and live occupancy to surface rate and discount opportunities." });

    if (v2CancelRate !== null && v2CancelRate > 15)
      items.push({ priority: "LOW", category: "Occupancy", tab: "occupancy", title: `Modelled cancel rate ~${v2CancelRate}% (OTA-weighted)`, detail: "High OTA share inflates estimated cancellation risk — consider firmer non-refundable direct rate packages." });

    return items.slice(0, 5);
  }, [scorecard, v2Kpis, paceDelta, v2ChannelMix, v2CancelRate, pricingExposure]);

  const runOptimisePreview = useCallback(async () => {
    if (!heatmap) return;
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, Math.min(DASHBOARD_WINDOW_DAYS, heatmap.dates.length));
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
    }
  }, [heatmap, selectedCategories, show, refreshScorecard]);

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
      const end = addDays(start, Math.min(DASHBOARD_WINDOW_DAYS, heatmap.dates.length));
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
  }, [heatmap, kNightNights, selectedCategories, show, refreshScorecard]);

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

  return (
    <div className="flex flex-col flex-1 w-full min-h-0 bg-bg">
      <Toasts />

      <OverviewSignalsProvider>
        <ExogenousDemandSignals />

        {/* Cream subtab strip — transitions from dark signals band to main body (mockup). */}
        <div className="w-full bg-bg border-b border-border/70 shadow-[0_1px_0_rgba(44,27,24,0.04)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-end gap-0" role="tablist" aria-label="Overview sections">
              {(["dashboard", "occupancy", "pricing", "channels"] as OverviewTab[]).map(tab => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 sm:px-6 py-4 text-[11px] font-bold uppercase tracking-[0.12em] border-b-[3px] transition-colors flex items-center gap-2 ${
                    activeTab === tab
                      ? "border-text text-text"
                      : "border-transparent text-text-muted hover:text-text hover:border-border"
                  }`}
                >
                  {tab === "dashboard" && <><Grid3x3 className="w-3.5 h-3.5 shrink-0" /> Dashboard</>}
                  {tab === "occupancy" && <><Zap className="w-3.5 h-3.5 shrink-0" /> Occupancy</>}
                  {tab === "pricing" && <><DollarSign className="w-3.5 h-3.5 shrink-0" /> Pricing</>}
                  {tab === "channels" && <><BarChart2 className="w-3.5 h-3.5 shrink-0" /> Channels</>}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
      {activeTab === "occupancy" && (
        <OccupancyOptimizationTab
          heatmap={heatmap}
          spanDays={occupancySpanDays}
          occupancyHeatmapDays={OCCUPANCY_HEATMAP_VISIBLE_DAYS}
          filteredRows={heatmap ? heatmap.rows : []}
          simulatedRows={simulatedRows}
          swapPlan={swapPlan}
          swapCommitLoading={swapCommitLoading}
          refreshAllData={refreshAllData}
          runOptimisePreview={runOptimisePreview}
          clearOptimisePreview={clearOptimisePreview}
          commitSwapShuffle={commitSwapShuffle}
          kNightNights={kNightNights}
          onKNightNightsChange={setKNightNights}
          kNightLoading={kNightLoading}
          kNightCommitLoading={kNightCommitLoading}
          kNightSwapPlan={kNightSwapPlan}
          runKNightPreview={runKNightPreview}
          commitKNightShuffle={commitKNightShuffle}
          predictiveLos={occupancyPredictive.predictiveLos}
          predictiveLosLoading={occupancyPredictive.predictiveLosLoading}
          predictiveLosError={occupancyPredictive.predictiveLosError}
          predictiveLosReady={occupancyPredictive.predictiveLosReady}
          onReloadPredictiveLos={occupancyPredictive.reloadPredictiveLos}
          runOccupancyRecoveryShufflePreview={occupancyPredictive.runOccupancyShufflePreview}
          clearOccupancyRecoveryShufflePreview={occupancyPredictive.clearOccupancyShufflePreview}
        />
      )}
      {activeTab === "pricing" && <PricingOptimizationTab />}
      {activeTab === "channels" && <ChannelOptimizationTab />}

      {/* ── DASHBOARD (V2) TAB ─────────────────────────────────────────────── */}
      {activeTab === "dashboard" && (
        <div className={overviewStackClass}>

          {/* Header */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className={`${overviewEyebrowClass} mb-0.5`}>Revenue Intelligence Center</div>
              <h1 className={overviewTitleClass}>Hotel at a Glance</h1>
              <p className="text-[11px] text-text-muted mt-1">
                {heatmapCategories.length} room type{heatmapCategories.length !== 1 ? "s" : ""} · {allRows.length} active rooms · {DASHBOARD_WINDOW_DAYS}-day window · all data live from DB
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={refreshAllData} className={overviewSecondaryBtnClass}>
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
          </div>

          {/* Loading / error state */}
          {!heatmap && (
            <div className={`py-20 text-center ${overviewCardLgClass} px-4`}>
              <Grid3x3 className="w-8 h-8 text-accent/40 mx-auto mb-4" />
              {isHeatmapLoading ? (
                <p className="text-sm text-text-muted">Loading hotel data…</p>
              ) : (
                <>
                  <p className="text-sm text-text-muted mb-4">{heatmapLoadError ?? "Something went wrong."}</p>
                  <button onClick={() => void loadHeatmap()} className="text-xs font-bold uppercase tracking-widest px-6 py-2.5 bg-text text-surface hover:bg-text/90">
                    Retry
                  </button>
                </>
              )}
            </div>
          )}

          {heatmap && (
            <div className="space-y-6">
              {/* ── KPI layout: hero row + grouped metrics (same 12 signals as docs/kpis.md) ── */}
              <div className="space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Hero — tonight occupancy (heatmap col 0) + historical context from forecast */}
                  <div className={`relative overflow-hidden ${overviewCardLgClass} border-l-[5px] border-l-accent pl-5 sm:pl-6 pr-5 sm:pr-6 pt-5 pb-5`}>
                    <Bed className="pointer-events-none absolute right-4 top-4 w-24 h-24 text-accent/[0.07]" strokeWidth={1} aria-hidden />
                    <div className="relative">
                      <div className={`${overviewEyebrowClass} text-accent`}>Tonight&apos;s occupancy</div>
                      <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-text-muted mt-1">Live portfolio saturation · {v2Kpis?.firstNightLabel ?? "first night"}</div>
                      <div className="mt-4 flex flex-wrap items-end gap-3">
                        <div className="text-5xl sm:text-[3.25rem] font-serif font-bold text-accent tabular-nums leading-none">
                          {v2Kpis ? `${Math.round(v2Kpis.tonightOccupancyPct)}%` : "—"}
                        </div>
                        <div className="text-[11px] text-text-muted pb-1">
                          {v2Kpis ? `${v2Kpis.tonightRoomsOccupied} / ${v2Kpis.tonightTotalRooms} rooms on calendar` : ""}
                        </div>
                      </div>
                      <div className="mt-6 pt-4 border-t border-border/60 grid grid-cols-2 gap-3 text-[11px]">
                        <div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Yester-night</div>
                          <div className="font-serif font-bold text-text tabular-nums mt-1">
                            {histOccContext.yesterdayPct != null ? `${Math.round(histOccContext.yesterdayPct)}%` : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-2">
                            Same date · prior year
                            {histOccContext.vsLyPpt != null && histOccContext.vsLyPpt !== 0 && (
                              <span className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${histOccContext.vsLyPpt > 0 ? "text-occugreen" : "text-occuorange"}`}>
                                {histOccContext.vsLyPpt > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                {histOccContext.vsLyPpt > 0 ? "+" : ""}{histOccContext.vsLyPpt} pts
                              </span>
                            )}
                          </div>
                          <div className="font-serif font-bold text-text tabular-nums mt-1">
                            {histOccContext.lyPct != null ? `${Math.round(histOccContext.lyPct)}%` : "—"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Hero — revenue at risk vs operating threshold */}
                  <div className={`relative overflow-hidden ${overviewCardLgClass} border-l-[5px] border-l-occuorange pl-5 sm:pl-6 pr-5 sm:pr-6 pt-5 pb-5`}>
                    <AlertTriangle className="pointer-events-none absolute right-4 top-4 w-9 h-9 text-occuorange/35" aria-hidden />
                    <div className="relative">
                      <div className={`${overviewEyebrowClass} text-occuorange`}>Revenue at risk</div>
                      <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-text-muted mt-1">
                        Unsold slot value · {spanDays}-night window
                      </div>
                      <div className={`mt-4 text-4xl sm:text-[2.75rem] font-serif font-bold tabular-nums leading-none ${pricingExposure.revenueAtRisk > 0 ? "text-occuorange" : "text-text"}`}>
                        ${pricingExposure.revenueAtRisk.toLocaleString("en-US")}
                      </div>
                      <div className="mt-4">
                        <div className="h-2 rounded-full bg-surface-2 border border-border/50 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-occuorange/70 to-occuorange rounded-full transition-[width]"
                            style={{ width: `${revenueAtRiskBarPct}%` }}
                          />
                        </div>
                        <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-text-muted">
                          <span>Operating threshold · ${revenueAtRiskThresholdUsd.toLocaleString("en-US")}</span>
                          <span className="font-mono font-bold text-occuorange">{Math.round(revenueAtRiskBarPct)}% to threshold</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Inventory gaps — orphan nights, gaps, k-windows */}
                  <div className={`${overviewCardClass} p-5 sm:p-6 flex flex-col min-h-[220px]`}>
                    <div className={`${overviewEyebrowClass} mb-4`}>Inventory gaps</div>
                    <div className="grid grid-cols-2 gap-4 flex-1">
                      {(() => {
                        const orphanN = scorecard?.before.orphan_nights ?? v2Kpis?.orphanNightsAtRisk ?? 0;
                        return (
                          <>
                            <div>
                              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Orphan nights</div>
                              <div className={`text-3xl font-serif font-bold tabular-nums mt-1 ${orphanN > 0 ? "text-occuorange" : "text-text"}`}>{orphanN}</div>
                            </div>
                            <div>
                              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Orphan gaps</div>
                              <div className="text-3xl font-serif font-bold text-text tabular-nums mt-1">{v2RunMetrics ? v2RunMetrics.orphanGaps : "—"}</div>
                            </div>
                            <div>
                              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">k=2 windows</div>
                              <div className="text-2xl font-serif font-bold text-text tabular-nums mt-1">{scorecardLoading ? "…" : (scorecard?.before.k_windows?.[2] ?? "—")}</div>
                            </div>
                            <div>
                              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">k=3 windows</div>
                              <div className="text-2xl font-serif font-bold text-text tabular-nums mt-1">{scorecardLoading ? "…" : (scorecard?.before.k_windows?.[3] ?? "—")}</div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Revenue health — on-books, unsold, leakage */}
                  <div className={`${overviewCardClass} p-5 sm:p-6 flex flex-col gap-4 min-h-[220px]`}>
                    <div className={`${overviewEyebrowClass}`}>Revenue health</div>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Revenue on books</div>
                        <div className="text-2xl sm:text-3xl font-serif font-bold text-text tabular-nums mt-1">
                          ${pricingExposure.revenueOnBooks.toLocaleString("en-US")}
                        </div>
                        <div className="text-[10px] text-text-muted mt-0.5">{spanDays}-night window</div>
                      </div>
                      <MiniRevenueSparkline values={revenueOnBooksByDay} className="shrink-0 opacity-90" />
                    </div>
                    <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border/60">
                      <div>
                        <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Unsold room-nights</div>
                        <div className="text-xl font-serif font-bold text-text tabular-nums mt-1">{pricingExposure.unsoldRoomNights.toLocaleString("en-US")}</div>
                      </div>
                      <div>
                        <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">OTA leakage</div>
                        <div className="text-xl font-serif font-bold text-rose-600 tabular-nums mt-1">
                          {channelProfitKpis.otaLeakage != null ? `$${Math.round(channelProfitKpis.otaLeakage).toLocaleString("en-US")}` : "—"}
                        </div>
                        <div className="text-[10px] font-mono text-text-muted mt-0.5">
                          {channelProfitKpis.otaLeakagePct != null ? `${Math.round(channelProfitKpis.otaLeakagePct)}% of gross` : ""}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Partners spotlight */}
                  <div className={`${overviewCardClass} border-l-[4px] border-l-accent/40 p-5 sm:p-6 flex flex-col min-h-[220px]`}>
                    <div className={`${overviewEyebrowClass} mb-3`}>Top partners</div>
                    <div className="space-y-4 flex-1">
                      {dashboardPartnerSpotlight.length > 0 ? (
                        dashboardPartnerSpotlight.map(row => (
                          <div key={row.partner} className="flex gap-3 items-start">
                            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${row.dotClass}`} aria-hidden />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold text-text truncate">{row.partner}</div>
                              <div className="text-sm font-serif font-bold text-text tabular-nums">{formatUsdShort(row.net)} net</div>
                              <div className="text-[10px] text-text-muted font-mono">${Math.round(row.adr).toLocaleString("en-US")} net ADR</div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-[11px] text-text-muted py-6">No partner breakdown for this window.</div>
                      )}
                    </div>
                    <div className="mt-4 pt-3 border-t border-border/60 text-[10px] text-text-muted flex justify-between gap-2">
                      <span className="font-bold uppercase tracking-widest">Discounted nights</span>
                      <span className="font-mono font-bold text-text">{pricingExposure.discountedRoomNights.toLocaleString("en-US")}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── BOTTOM: Action Queue (horizontal strip) ─────────────────── */}
              <div>
                <div className={`${overviewCardLgClass} p-5 sm:p-6`}>
                  <div className="mb-4 pb-3 border-b border-border/60 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted whitespace-nowrap">
                        Computed from live data
                      </span>
                      <span className="hidden sm:block h-3 w-px bg-border shrink-0" aria-hidden />
                      <h2 className="font-serif font-bold text-base text-text">Action Queue</h2>
                    </div>
                    <AlertTriangle className="w-4 h-4 text-occuorange/70 shrink-0" />
                  </div>
                  {actionQueue.length === 0 ? (
                    <div className="text-xs text-text-muted py-8 text-center border border-dashed border-border/70 rounded-[10px] bg-surface-2/30">
                      No urgent actions — hotel operating well in this window.
                    </div>
                  ) : (
                    <div className="flex gap-3 overflow-x-auto pb-1 snap-x snap-mandatory [-webkit-overflow-scrolling:touch]">
                      {actionQueue.map((item, i) => (
                        <div
                          key={i}
                          className="snap-start shrink-0 w-[min(100%,300px)] sm:w-[300px] flex flex-col gap-2 p-3 bg-surface-2/40 border border-border/50 hover:border-accent/30 transition-colors rounded-[10px]"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className={`shrink-0 text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 ${
                              item.priority === "HIGH" ? "bg-occuorange/12 text-occuorange border border-occuorange/30" :
                              item.priority === "MED"  ? "bg-accent/10 text-accent border border-accent/25" :
                                                         "bg-surface border border-border text-text-muted"
                            }`}>
                              {item.priority}
                            </span>
                            <button
                              type="button"
                              onClick={() => setActiveTab(item.tab)}
                              className="shrink-0 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-2 py-1 border border-accent/30 text-accent hover:bg-accent/8 transition-colors"
                            >
                              {item.category} <ArrowRight className="w-2.5 h-2.5" />
                            </button>
                          </div>
                          <div className="text-xs font-bold text-text leading-tight">{item.title}</div>
                          <div className="text-[11px] text-text-muted leading-relaxed line-clamp-4 flex-1">{item.detail}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
        </div>
      </OverviewSignalsProvider>
    </div>
  );
}
