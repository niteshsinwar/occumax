import { useState, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  dashboardCommitShuffle,
  dashboardOptimiseKNightPreview,
  getHeatmap,
  dashboardOptimisePreview,
  dashboardScorecard,
  getEventInsights,
  getPace,
  getChannelPerformance,
} from "../api/client";
import type {
  DashboardOptimisePreviewResponse,
  DashboardScorecardResponse,
  EventInsightsResponse,
  HeatmapResponse,
  HeatmapRow,
  RoomCategory,
  SwapStep,
  ChannelPerformanceResponse,
  PaceResponse,
} from "../types";
import { type BirdseyeWeekSpan } from "../components/BirdseyeFilters";
import { useToast } from "../components/shared/Toast";
import { computeEmptyRunInventory } from "../utils/inventoryAvailability";
import { simulateRows } from "../utils/simulateRows";
import { calendarDayKey } from "../utils/calendarDayKey";
import { OCCUPANCY_HEATMAP_VISIBLE_DAYS, useOccupancyPredictiveLos } from "../hooks/useOccupancyPredictiveLos";
import { ChannelOptimizationTab } from "../components/overview/ChannelOptimizationTab";
import { OccupancyOptimizationTab } from "../components/overview/OccupancyOptimizationTab";
import { PricingOptimizationTab } from "../components/overview/PricingOptimizationTab";
import { ExogenousDemandSignals } from "../components/overview/ExogenousDemandSignals";
import { OverviewSignalsProvider } from "../context/overviewSignals";
import { BarChart2, DollarSign, Grid3x3, RefreshCw, AlertTriangle, Zap, Sparkles, ArrowRight, TrendingUp, TrendingDown } from "lucide-react";
import { addDays, formatISO, parseISO } from "date-fns";
import { AiTag } from "../components/shared/AiTag";
import {
  overviewCardClass,
  overviewCardLgClass,
  overviewEyebrowClass,
  overviewInsightBannerClass,
  overviewSecondaryBtnClass,
  overviewStackClass,
  overviewTitleClass,
} from "../components/overview/overviewChrome";

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

function computeMostCommonLosFromSlice(rows: HeatmapRow[], maxDays: number): number | null {
  // Extract LOS from SOFT booking runs within each room row (by booking_id).
  // This is a fallback when /analytics/event-insights is unavailable.
  const counts = new Map<number, number>();
  for (const r of rows) {
    const cells = r.cells.slice(0, maxDays);
    let i = 0;
    while (i < cells.length) {
      const c = cells[i];
      if (!c || c.block_type !== "SOFT" || !c.booking_id) { i++; continue; }
      const bid = c.booking_id;
      const start = i;
      while (i < cells.length) {
        const cc = cells[i];
        if (!cc || cc.block_type !== "SOFT" || cc.booking_id !== bid) break;
        i++;
      }
      const len = i - start;
      if (len > 0 && len <= 30) counts.set(len, (counts.get(len) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let bestLos: number | null = null;
  let bestCount = -1;
  for (const [los, n] of counts.entries()) {
    if (n > bestCount || (n === bestCount && (bestLos == null || los < bestLos))) {
      bestLos = los;
      bestCount = n;
    }
  }
  return bestLos;
}

function topChannelInsight(mix: ChannelMix): { channel: string; sharePct: number; total: number } | null {
  const entries = Object.entries(mix);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total <= 0) return null;
  const [channel, nights] = entries.sort((a, b) => b[1] - a[1])[0]!;
  return { channel, sharePct: Math.round((nights / total) * 100), total };
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

/**
 * Dashboard (Bird's Eye View): occupancy matrix and k-night bookable-window counts (overlapping, per EMPTY strip) by length and room category.
 * Uses `GET /dashboard/heatmap`; slot edits use the same admin slot patch as the manager heatmap.
 * Date span (defaults to three weeks) and room-type filters apply only on this page (client-side slice of the shared heatmap payload).
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
  const [weekSpan, setWeekSpan] = useState<BirdseyeWeekSpan>(3);
  const [selectedCategories, setSelectedCategories] = useState<RoomCategory[]>([]);

  // Hackathon scorecard (before/after + deltas)
  const [scorecard, setScorecard] = useState<DashboardScorecardResponse | null>(null);
  const [scorecardLoading, setScorecardLoading] = useState(false);
  const { show, Toasts } = useToast();

  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);
  const [eventInsights, setEventInsights] = useState<EventInsightsResponse | null>(null);
  const [showInsightsV2, setShowInsightsV2] = useState(true);
  const [pace, setPace] = useState<PaceResponse | null>(null);
  const [channelPerf, setChannelPerf] = useState<ChannelPerformanceResponse | null>(null);

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

  // Lightweight analytics backing the AI insights panel (when available).
  useEffect(() => {
    if (!scorecardSlice) return;
    const { startStr, endStr } = scorecardSlice;

    getEventInsights({ start: startStr, end: endStr, as_of: todayStr })
      .then(res => setEventInsights(res.data))
      .catch(() => setEventInsights(null));

    getPace({ start: startStr, end: endStr, as_of: todayStr })
      .then(res => setPace(res.data as PaceResponse))
      .catch(() => setPace(null));

    getChannelPerformance({ start: startStr, end: endStr, categories: selectedCategories })
      .then(res => setChannelPerf(res.data as ChannelPerformanceResponse))
      .catch(() => setChannelPerf(null));
  }, [scorecardSlice?.endStr, scorecardSlice?.startStr, selectedCategories, todayStr]);

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

  const snapshot = useMemo(() => {
    if (!heatmap) return null;
    return computeEmptyRunInventory(filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  const mostCommonLosFallback = useMemo(() => {
    if (!heatmap || filteredRows.length === 0 || spanDays === 0) return null;
    return computeMostCommonLosFromSlice(filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

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

  const v2TopChannel = useMemo(() => (v2ChannelMix ? topChannelInsight(v2ChannelMix) : null), [v2ChannelMix]);
  const v2CancelRate = useMemo(() => (v2ChannelMix ? estimatedCancellationRate(v2ChannelMix) : null), [v2ChannelMix]);

  const paceDelta = useMemo(() => {
    if (!pace?.series || pace.series.length === 0) return null;
    let total = 0, count = 0;
    for (const s of pace.series) for (const p of s.points ?? []) { total += (p.on_books_occ_pct - p.expected_on_books_occ_pct); count++; }
    return count > 0 ? total / count : null;
  }, [pace]);

  const dailyOccupancy = useMemo(() => {
    if (!heatmap) return [];
    const days = Math.min(14, heatmap.dates.length);
    return heatmap.dates.slice(0, days).map((date, idx) => {
      const total = heatmap.rows.length;
      const soft = heatmap.rows.filter(r => r.cells[idx]?.block_type === "SOFT").length;
      const hard = heatmap.rows.filter(r => r.cells[idx]?.block_type === "HARD").length;
      return { date: String(date), total, soft, hard, occPct: total > 0 ? ((soft + hard) / total) * 100 : 0 };
    });
  }, [heatmap]);

  const v2MostCommonLos = useMemo(() => {
    if (eventInsights?.most_common_los_nights != null) return eventInsights.most_common_los_nights;
    return mostCommonLosFallback;
  }, [eventInsights, mostCommonLosFallback]);

  type ActionItem = { priority: "HIGH" | "MED" | "LOW"; category: string; tab: OverviewTab; title: string; detail: string };

  const actionQueue = useMemo((): ActionItem[] => {
    const items: ActionItem[] = [];
    const orphans = scorecard?.before.orphan_nights ?? v2Kpis?.orphanNightsAtRisk ?? 0;
    const revRisk = scorecard?.before.revenue_at_risk ?? v2Kpis?.orphanRevenueAtRisk ?? 0;

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
  }, [scorecard, v2Kpis, paceDelta, v2ChannelMix, v2CancelRate]);

  const intelligenceFeedV2 = useMemo(() => {
    if (!snapshot || spanDays === 0) return [];
    const out: string[] = [];
    if (eventInsights?.most_common_los_nights != null)
      out.push(`Most likely length of stay: ${eventInsights.most_common_los_nights} nights.`);
    else if (mostCommonLosFallback != null)
      out.push(`Most likely length of stay: ${mostCommonLosFallback} nights (inferred from current bookings in this window).`);

    if (channelPerf?.channels && channelPerf.channels.length > 0) {
      const best = [...channelPerf.channels].sort((a, b) => b.room_nights - a.room_nights)[0]!;
      const partner = best.partners?.length ? [...best.partners].sort((a, b) => b.room_nights - a.room_nights)[0] : null;
      out.push(partner
        ? `Channel leader: ${best.channel}. Top partner: ${partner.partner} (${partner.share_of_channel_pct}% of ${best.channel} nights).`
        : `Channel leader: ${best.channel} with ${best.share_pct}% of booked nights in this window.`);
    } else if (v2TopChannel) {
      out.push(`Channel mix: ${v2TopChannel.channel} leads at ~${v2TopChannel.sharePct}% of booked nights in this window.`);
    }

    if (pace?.series?.length) {
      const pts = pace.series[0]?.points ?? [];
      if (pts.length > 0) {
        const avg = pts.reduce((s, p) => s + (p.on_books_occ_pct - p.expected_on_books_occ_pct), 0) / pts.length;
        out.push(`Booking pace vs 2yr baseline: ${avg >= 0 ? "ahead" : "behind"} by ~${Math.abs(Math.round(avg))} occ-pts.`);
      }
    }

    if (v2CancelRate != null)
      out.push(`Estimated cancellation rate (modelled from channel mix): ~${v2CancelRate}%.`);

    if (v2Kpis?.sandwichMinlosBlockedNights)
      out.push(`${v2Kpis.sandwichMinlosBlockedNights} orphan night(s) are blocked by MinLOS rules — go to Occupancy to recover them.`);

    return out.slice(0, 5);
  }, [snapshot, spanDays, eventInsights, mostCommonLosFallback, channelPerf, v2TopChannel, pace, v2CancelRate, v2Kpis]);

  const runOptimisePreview = useCallback(async () => {
    if (!heatmap) return;
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
                {heatmapCategories.length} room type{heatmapCategories.length !== 1 ? "s" : ""} · {allRows.length} active rooms · all data live from DB
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-0 rounded-[10px] border border-border/80 overflow-hidden shadow-subtle bg-surface-2/40">
                {([1, 2, 3] as BirdseyeWeekSpan[]).map(w => (
                  <button
                    key={w}
                    onClick={() => setWeekSpan(w)}
                    className={`text-[10px] font-bold uppercase tracking-widest px-3 py-2 transition-all ${weekSpan === w ? "bg-text text-surface" : "text-text-muted hover:text-text hover:bg-surface"}`}
                  >
                    {w}W
                  </button>
                ))}
              </div>
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
              {/* ── KPI STRIP (7 cards) ──────────────────────────────────────── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">

                <div className={`${overviewCardClass} p-4 sm:p-5`}>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Tonight</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">
                    {v2Kpis ? `${Math.round(v2Kpis.tonightOccupancyPct)}%` : "—"}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {v2Kpis ? `${v2Kpis.tonightRoomsOccupied} / ${v2Kpis.tonightTotalRooms} rooms` : "—"}
                  </div>
                </div>

                {(() => {
                  const n = scorecard?.before.orphan_nights ?? v2Kpis?.orphanNightsAtRisk ?? 0;
                  const isRisk = n > 0;
                  return (
                    <div className={`${overviewCardClass} p-4 sm:p-5 ${isRisk ? "!border-occuorange/50" : ""}`}>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Orphan Nights</div>
                      <div className={`text-2xl font-serif font-bold tabular-nums ${isRisk ? "text-occuorange" : "text-text"}`}>{n}</div>
                      <div className="text-[10px] text-text-muted mt-0.5">stranded gaps</div>
                    </div>
                  );
                })()}

                {(() => {
                  const v = scorecard?.before.revenue_at_risk ?? 0;
                  const isRisk = v > 0;
                  return (
                    <div className={`${overviewCardClass} p-4 sm:p-5 ${isRisk ? "!border-occuorange/35" : ""}`}>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Rev at Risk</div>
                      <div className={`text-2xl font-serif font-bold tabular-nums ${isRisk ? "text-occuorange" : "text-text"}`}>
                        {scorecard ? `$${Math.round(v).toLocaleString("en-US")}` : "—"}
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5">fill-model est.</div>
                    </div>
                  );
                })()}

                <div className={`${overviewCardClass} p-4 sm:p-5`}>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Avg Rate</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">
                    {v2Kpis ? `$${Math.round(v2Kpis.avgRateInView).toLocaleString("en-US")}` : "—"}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {v2Kpis ? `${v2Kpis.avgRateNightCount} booked nights` : "—"}
                  </div>
                </div>

                <div className={`${overviewCardClass} p-4 sm:p-5`}>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">k=2 Windows</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">
                    {scorecardLoading ? "…" : (scorecard?.before.k_windows?.[2] ?? "—")}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">2-night openings</div>
                </div>

                <div className={`${overviewCardClass} p-4 sm:p-5`}>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Top Channel</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">{v2TopChannel?.channel ?? "—"}</div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {v2TopChannel ? `~${v2TopChannel.sharePct}% share` : "no data"}
                  </div>
                </div>

                {(() => {
                  const isAhead = paceDelta !== null && paceDelta >= 0;
                  const isBehind = paceDelta !== null && paceDelta < 0;
                  return (
                    <div className={`${overviewCardClass} p-4 sm:p-5 ${isAhead ? "!border-occugreen/40" : isBehind ? "!border-occuorange/30" : ""}`}>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1 flex items-center gap-1">
                        Pace vs 2yr
                        {isAhead && <TrendingUp className="w-3 h-3 text-occugreen" />}
                        {isBehind && <TrendingDown className="w-3 h-3 text-occuorange" />}
                      </div>
                      <div className={`text-2xl font-serif font-bold tabular-nums ${isAhead ? "text-occugreen" : isBehind ? "text-occuorange" : "text-text"}`}>
                        {paceDelta !== null ? `${isAhead ? "+" : ""}${Math.round(paceDelta)}%` : "—"}
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5">
                        {isAhead ? "ahead" : isBehind ? "behind" : "unavailable"}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* ── MIDDLE: 3-column visual section ─────────────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* Col 1: 14-Night Occupancy Trend */}
                <div className={`${overviewCardLgClass} p-5 sm:p-6`}>
                  <div className="mb-4 pb-3 border-b border-border/60">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Next 14 Nights</div>
                    <div className="font-serif font-bold text-base text-text mt-0.5">Occupancy Trend</div>
                  </div>
                  <div className="space-y-1.5">
                    {dailyOccupancy.map(day => {
                      const softPct = day.total > 0 ? (day.soft / day.total) * 100 : 0;
                      const hardPct = day.total > 0 ? (day.hard / day.total) * 100 : 0;
                      const occPct = softPct + hardPct;
                      return (
                        <div key={day.date} className="grid grid-cols-[48px_1fr_34px] gap-2 items-center">
                          <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted text-right tabular-nums">{calendarDayKey(day.date)}</div>
                          <div className="h-3.5 bg-surface-2 border border-border/40 overflow-hidden flex">
                            <div className="h-full bg-occugreen/55 transition-all" style={{ width: `${softPct}%` }} />
                            <div className="h-full bg-text/20 transition-all" style={{ width: `${hardPct}%` }} />
                          </div>
                          <div className={`text-[10px] font-bold tabular-nums text-right ${occPct < 40 ? "text-occuorange" : occPct >= 80 ? "text-occugreen" : "text-text"}`}>
                            {Math.round(occPct)}%
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/60 flex gap-5 text-[9px] font-bold uppercase tracking-widest text-text-muted">
                    <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occugreen/55 inline-block" /> Booked</span>
                    <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-text/20 inline-block" /> Blocked</span>
                    <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-surface-2 border border-border inline-block" /> Empty</span>
                  </div>
                </div>

                {/* Col 2: Gap & Capacity Analysis */}
                <div className={`${overviewCardLgClass} p-5 sm:p-6`}>
                  <div className="mb-4 pb-3 border-b border-border/60">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Capacity</div>
                    <div className="font-serif font-bold text-base text-text mt-0.5">Gap Analysis</div>
                  </div>

                  {v2RunMetrics && (() => {
                    const maxGap = Math.max(v2RunMetrics.dist.n1, v2RunMetrics.dist.n2_3, v2RunMetrics.dist.n4_7, v2RunMetrics.dist.n8p, 1);
                    const bars = [
                      { label: "1-night", count: v2RunMetrics.dist.n1, color: "bg-occuorange", note: "hardest to sell" },
                      { label: "2–3 night", count: v2RunMetrics.dist.n2_3, color: "bg-occuorange/50", note: "hard to fill" },
                      { label: "4–7 night", count: v2RunMetrics.dist.n4_7, color: "bg-text/25", note: "convertible" },
                      { label: "8+ night", count: v2RunMetrics.dist.n8p, color: "bg-occugreen/45", note: "easy to sell" },
                    ];
                    return (
                      <>
                        <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Empty gap distribution</div>
                        <div className="space-y-2 mb-5">
                          {bars.map(({ label, count, color, note }) => (
                            <div key={label} className="grid grid-cols-[58px_1fr_24px] gap-2 items-center">
                              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted text-right">{label}</div>
                              <div className="h-3 bg-surface-2 border border-border/40 overflow-hidden relative group">
                                <div className={`h-full ${color} transition-all`} style={{ width: `${count > 0 ? Math.max((count / maxGap) * 100, 5) : 0}%` }} />
                                <span className="absolute right-1 top-0 h-full hidden group-hover:flex items-center text-[8px] text-text-muted">{note}</span>
                              </div>
                              <div className="text-[10px] font-bold text-text tabular-nums">{count}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}

                  <div className="pt-3 border-t border-border/60">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Bookable windows</div>
                    <div className="grid grid-cols-2 gap-2">
                      {[2, 3].map(k => (
                        <div key={k} className="bg-surface-2 border border-border px-3 py-2.5">
                          <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">k={k} nights</div>
                          <div className="text-xl font-serif font-bold text-text tabular-nums mt-1">
                            {scorecardLoading ? "…" : (scorecard?.before.k_windows?.[k] ?? "—")}
                          </div>
                        </div>
                      ))}
                    </div>
                    {v2RunMetrics && (
                      <div className="mt-3 pt-2 border-t border-border/40 text-[10px] text-text-muted">
                        <span className="font-bold text-text">{v2RunMetrics.orphanNights}</span> orphan night{v2RunMetrics.orphanNights !== 1 ? "s" : ""} in{" "}
                        <span className="font-bold text-text">{v2RunMetrics.orphanGaps}</span> gap{v2RunMetrics.orphanGaps !== 1 ? "s" : ""} across {spanDays}-day window
                      </div>
                    )}
                  </div>
                </div>

                {/* Col 3: Channel Intelligence */}
                <div className={`${overviewCardLgClass} p-5 sm:p-6`}>
                  <div className="mb-4 pb-3 border-b border-border/60">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Distribution</div>
                    <div className="font-serif font-bold text-base text-text mt-0.5">Channel Intelligence</div>
                  </div>

                  {v2ChannelMix && Object.keys(v2ChannelMix).length > 0 ? (() => {
                    const total = Object.values(v2ChannelMix).reduce((s, n) => s + n, 0);
                    const CH_COLOR: Record<string, string> = { OTA: "bg-accent/55", DIRECT: "bg-occugreen/55", WALKIN: "bg-amber-400/55" };
                    return (
                      <>
                        <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Booked nights by channel</div>
                        <div className="space-y-2 mb-4">
                          {Object.entries(v2ChannelMix).sort((a, b) => b[1] - a[1]).map(([ch, n]) => {
                            const pct = total > 0 ? (n / total) * 100 : 0;
                            return (
                              <div key={ch} className="grid grid-cols-[54px_1fr_36px] gap-2 items-center">
                                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted text-right">{ch}</div>
                                <div className="h-3 bg-surface-2 border border-border/40 overflow-hidden">
                                  <div className={`h-full ${CH_COLOR[ch] ?? "bg-text/20"} transition-all`} style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }} />
                                </div>
                                <div className="text-[10px] font-bold text-text tabular-nums">{Math.round(pct)}%</div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })() : (
                    <p className="text-xs text-text-muted mb-4">No booked nights in this window.</p>
                  )}

                  <div className="pt-3 border-t border-border/60 space-y-2.5">
                    {v2TopChannel && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted">Top channel</span>
                        <span className="font-bold text-text">{v2TopChannel.channel} · {v2TopChannel.sharePct}%</span>
                      </div>
                    )}
                    {channelPerf?.channels && channelPerf.channels.length > 0 && (() => {
                      const best = [...channelPerf.channels].sort((a, b) => b.room_nights - a.room_nights)[0]!;
                      const partner = best.partners?.length ? [...best.partners].sort((a, b) => b.room_nights - a.room_nights)[0] : null;
                      return partner ? (
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-text-muted">Top partner</span>
                          <span className="font-bold text-text">{partner.partner}</span>
                        </div>
                      ) : null;
                    })()}
                    {v2CancelRate !== null && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted flex items-center gap-1">
                          Est. cancel rate <AiTag title="Modelled from channel mix heuristics — not historical data." />
                        </span>
                        <span className={`font-bold ${v2CancelRate > 15 ? "text-occuorange" : "text-text"}`}>~{v2CancelRate}%</span>
                      </div>
                    )}
                    {v2MostCommonLos !== null && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted">Common LOS</span>
                        <span className="font-bold text-text">{v2MostCommonLos} night{v2MostCommonLos !== 1 ? "s" : ""}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── BOTTOM: Action Queue + Capacity Scorecard ────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* Action Queue */}
                <div className={`${overviewCardLgClass} p-5 sm:p-6`}>
                  <div className="mb-4 pb-3 border-b border-border/60 flex items-center justify-between">
                    <div>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Computed from live data</div>
                      <div className="font-serif font-bold text-base text-text mt-0.5">Action Queue</div>
                    </div>
                    <AlertTriangle className="w-4 h-4 text-occuorange/70" />
                  </div>
                  <div className="space-y-2">
                    {actionQueue.map((item, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 bg-surface-2/40 border border-border/50 hover:border-accent/30 transition-colors group">
                        <div className={`shrink-0 mt-0.5 text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 ${
                          item.priority === "HIGH" ? "bg-occuorange/12 text-occuorange border border-occuorange/30" :
                          item.priority === "MED"  ? "bg-accent/10 text-accent border border-accent/25" :
                                                     "bg-surface border border-border text-text-muted"
                        }`}>
                          {item.priority}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold text-text leading-tight">{item.title}</div>
                          <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{item.detail}</div>
                        </div>
                        <button
                          onClick={() => setActiveTab(item.tab)}
                          className="shrink-0 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-2.5 py-1.5 border border-accent/30 text-accent hover:bg-accent/8 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          {item.category} <ArrowRight className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                    {actionQueue.length === 0 && (
                      <div className="text-xs text-text-muted py-6 text-center">No urgent actions — hotel operating well in this window.</div>
                    )}
                  </div>
                </div>

                {/* Capacity Scorecard (compact) */}
                <div className={`${overviewCardLgClass} p-5 sm:p-6`}>
                  <div className="mb-4 pb-3 border-b border-border/60 flex items-center justify-between">
                    <div>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Before → After shuffle preview</div>
                      <div className="font-serif font-bold text-base text-text mt-0.5">Capacity Scorecard</div>
                    </div>
                    {scorecardLoading && <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted animate-pulse">Updating…</div>}
                  </div>

                  <div className="grid grid-cols-3 gap-2 mb-4">
                    {[
                      { label: "Orphan nights", before: scorecard?.before.orphan_nights, after: scorecard?.after?.orphan_nights, delta: scorecard?.delta?.orphan_nights, lowerIsBetter: true },
                      { label: "Rev at risk", before: scorecard ? `$${Math.round(scorecard.before.revenue_at_risk).toLocaleString("en-US")}` : undefined, after: scorecard?.after ? `$${Math.round(scorecard.after.revenue_at_risk).toLocaleString("en-US")}` : undefined, delta: scorecard?.delta ? Math.round(scorecard.delta.revenue_at_risk) : undefined, lowerIsBetter: true },
                      { label: "k=2 windows", before: scorecard?.before.k_windows?.[2], after: scorecard?.after?.k_windows?.[2], delta: scorecard?.delta?.k_windows?.[2], lowerIsBetter: false },
                    ].map(({ label, before, after, delta, lowerIsBetter }) => (
                      <div key={label} className="bg-surface-2 border border-border p-3">
                        <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">{label}</div>
                        <div className="text-xl font-serif font-bold text-text tabular-nums">
                          {scorecardLoading ? "…" : (before ?? "—")}
                        </div>
                        {after !== undefined && delta !== undefined && (
                          <div className={`text-[10px] font-bold tabular-nums mt-1 ${
                            (lowerIsBetter ? delta <= 0 : delta >= 0) ? "text-occugreen" : "text-occuorange"
                          }`}>
                            → {after} {delta !== 0 && `(${delta > 0 ? "+" : ""}${delta})`}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {!swapPlan || swapPlan.length === 0 ? (
                    <div className="text-[11px] text-text-muted bg-surface-2/50 border border-border/50 px-3 py-2.5 leading-relaxed">
                      Go to{" "}
                      <button onClick={() => setActiveTab("occupancy")} className="font-bold text-text underline underline-offset-2">Occupancy</button>
                      {" "}and run Preview Recovery Shuffle to see before/after deltas.
                    </div>
                  ) : (
                    <div className="text-[11px] text-occugreen font-bold bg-occugreen/5 border border-occugreen/25 px-3 py-2.5 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-occugreen inline-block" />
                      Shuffle plan active ({swapPlan.length} steps) —{" "}
                      <button onClick={() => setActiveTab("occupancy")} className="underline underline-offset-2">go to Occupancy</button>{" "}to commit.
                    </div>
                  )}
                </div>
              </div>

              {/* ── INTELLIGENCE FEED ─────────────────────────────────────────── */}
              {intelligenceFeedV2.length > 0 && (
                <div className={`p-5 sm:p-6 ${showInsightsV2 ? overviewInsightBannerClass : overviewCardLgClass}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                        <Sparkles className="w-3.5 h-3.5 text-accent" />
                      </div>
                      <div>
                        <div className="text-[9px] font-bold uppercase tracking-widest text-accent flex items-center gap-2">
                          Intelligence Feed
                          <AiTag title="Combines real slice metrics with clearly-labelled estimates where live data is unavailable." />
                        </div>
                        {!showInsightsV2 && (
                          <div className="text-[11px] text-text-muted mt-0.5">{intelligenceFeedV2.length} signal{intelligenceFeedV2.length !== 1 ? "s" : ""} from this {weekSpan}W window</div>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setShowInsightsV2(v => !v)}
                      className="text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 border border-border bg-surface hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
                    >
                      {showInsightsV2 ? "Collapse" : "Expand"}
                    </button>
                  </div>
                  {showInsightsV2 && (
                    <ul className="mt-4 space-y-2.5 pl-10">
                      {intelligenceFeedV2.map((line, i) => (
                        <li key={i} className="text-sm text-text leading-relaxed flex items-start gap-2">
                          <span className="text-accent/70 mt-1 text-xs shrink-0">→</span>
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
        </div>
      </OverviewSignalsProvider>
    </div>
  );
}
