import { useState, useCallback, useEffect, useMemo } from "react";
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
  DashboardKNightPreviewResponse,
  DashboardScorecardResponse,
  EventInsightsResponse,
  HeatmapResponse,
  HeatmapRow,
  RoomCategory,
  SwapStep,
  ChannelPerformanceResponse,
  PaceResponse,
} from "../types";
import type { BirdseyeWeekSpan } from "../components/BirdseyeFilters";
import { useToast } from "../components/shared/Toast";
import { computeEmptyRunInventory } from "../utils/inventoryAvailability";
import { simulateRows } from "../utils/simulateRows";
import { calendarDayKey } from "../utils/calendarDayKey";
import { ChannelOptimizationTab } from "../components/overview/ChannelOptimizationTab";
import { OccupancyOptimizationTab } from "../components/overview/OccupancyOptimizationTab";
import { PricingOptimizationTab } from "../components/overview/PricingOptimizationTab";
import { AiTag } from "../components/shared/AiTag";
import {
  BarChart2,
  DollarSign,
  Grid3x3,
  RefreshCw,
  Zap,
  Sparkles,
  AlertTriangle,
  ArrowRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { addDays, formatISO, parseISO } from "date-fns";

// ─── Pure helper functions (same logic as Dashboard.tsx, scoped here) ─────────

type ChannelMix = Record<string, number>;
type RunMetrics = { orphanGaps: number; orphanNights: number; dist: { n1: number; n2_3: number; n4_7: number; n8p: number } };

type BirdseyeKpis = {
  tonightOccupancyPct: number; tonightRoomsOccupied: number; tonightTotalRooms: number;
  firstNightLabel: string; avgRateInView: number; avgRateNightCount: number;
  orphanNightsAtRisk: number; orphanRevenueAtRisk: number; sandwichMinlosBlockedNights: number;
};

function uniqueCategories(rows: HeatmapRow[]): RoomCategory[] {
  const seen = new Set<RoomCategory>(); const out: RoomCategory[] = [];
  for (const r of rows) { if (!seen.has(r.category)) { seen.add(r.category); out.push(r.category); } }
  return out;
}

function channelMixFromRows(rows: HeatmapRow[], days: number): ChannelMix {
  const mix: ChannelMix = {};
  for (const r of rows) for (const c of r.cells.slice(0, days)) {
    if (!c || c.block_type !== "SOFT") continue;
    const ch = c.channel ?? "UNKNOWN";
    mix[ch] = (mix[ch] ?? 0) + 1;
  }
  return mix;
}

function runMetricsFromRows(rows: HeatmapRow[], days: number): RunMetrics {
  const runs: Array<{ length: number; isOrphan: boolean }> = [];
  for (const row of rows) {
    const cells = row.cells.slice(0, days); let i = 0;
    while (i < cells.length) {
      if (cells[i]?.block_type !== "EMPTY") { i++; continue; }
      const s = i;
      while (i < cells.length && cells[i]?.block_type === "EMPTY") i++;
      const length = i - s;
      const before = s > 0 ? cells[s - 1]?.block_type : null;
      const after = i < cells.length ? cells[i]?.block_type : null;
      runs.push({ length, isOrphan: length <= 5 && before !== null && before !== "EMPTY" && after !== null && after !== "EMPTY" });
    }
  }
  const orphans = runs.filter(r => r.isOrphan);
  return {
    orphanGaps: orphans.length,
    orphanNights: orphans.reduce((s, r) => s + r.length, 0),
    dist: { n1: runs.filter(r => r.length === 1).length, n2_3: runs.filter(r => r.length >= 2 && r.length <= 3).length, n4_7: runs.filter(r => r.length >= 4 && r.length <= 7).length, n8p: runs.filter(r => r.length >= 8).length },
  };
}

function birdseyeKpis(dates: string[], rows: HeatmapRow[], span: number): BirdseyeKpis {
  const capped = Math.min(Math.max(0, span), dates.length);
  const total = rows.length;
  let occ = 0;
  if (total > 0 && capped > 0) for (const r of rows) { if (r.cells[0]?.block_type !== "EMPTY") occ++; }
  let rateSum = 0, rateCount = 0;
  for (const r of rows) for (let i = 0; i < capped; i++) { const c = r.cells[i]; if (c && c.block_type !== "EMPTY") { rateSum += c.current_rate; rateCount++; } }
  let orphanAtRisk = 0, orphanRevRisk = 0, minlosBlocked = 0;
  if (capped >= 3) for (const r of rows) for (let i = 1; i < capped - 1; i++) {
    const c = r.cells[i]; if (!c || c.block_type !== "EMPTY") continue;
    const bef = r.cells[i - 1]; const aft = r.cells[i + 1];
    if (bef && bef.block_type !== "EMPTY" && aft && aft.block_type !== "EMPTY") {
      orphanAtRisk++; orphanRevRisk += c.current_rate;
      if (c.min_stay_active && c.min_stay_nights > 1) minlosBlocked++;
    }
  }
  return { tonightOccupancyPct: total > 0 && capped > 0 ? (occ / total) * 100 : 0, tonightRoomsOccupied: occ, tonightTotalRooms: total, firstNightLabel: dates.length > 0 ? calendarDayKey(String(dates[0])) : "", avgRateInView: rateCount > 0 ? rateSum / rateCount : 0, avgRateNightCount: rateCount, orphanNightsAtRisk: orphanAtRisk, orphanRevenueAtRisk: Math.round(orphanRevRisk), sandwichMinlosBlockedNights: minlosBlocked };
}

function topChannel(mix: ChannelMix): { channel: string; sharePct: number; total: number } | null {
  const entries = Object.entries(mix); const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total <= 0) return null;
  const [channel, nights] = entries.sort((a, b) => b[1] - a[1])[0]!;
  return { channel, sharePct: Math.round((nights / total) * 100), total };
}

function estimatedCancelRate(mix: ChannelMix): number | null {
  const rates: Record<string, number> = { OTA: 0.18, DIRECT: 0.08, GDS: 0.12, WALKIN: 0.03, CLOSED: 0.0, UNKNOWN: 0.1 };
  const entries = Object.entries(mix); const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total <= 0) return null;
  return Math.round((entries.reduce((s, [ch, n]) => s + (rates[ch] ?? 0.1) * n, 0) / total) * 100);
}

function mostCommonLosFromRows(rows: HeatmapRow[], days: number): number | null {
  const counts = new Map<number, number>();
  for (const r of rows) { const cells = r.cells.slice(0, days); let i = 0;
    while (i < cells.length) { const c = cells[i]; if (!c || c.block_type !== "SOFT" || !c.booking_id) { i++; continue; } const bid = c.booking_id; const s = i;
      while (i < cells.length) { const cc = cells[i]; if (!cc || cc.block_type !== "SOFT" || cc.booking_id !== bid) break; i++; }
      const len = i - s; if (len > 0 && len <= 30) counts.set(len, (counts.get(len) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: number | null = null; let bestN = -1;
  for (const [los, n] of counts.entries()) { if (n > bestN || (n === bestN && (best == null || los < best))) { best = los; bestN = n; } }
  return best;
}

// ─── Component ────────────────────────────────────────────────────────────────

type OverviewTab = "dashboard" | "occupancy" | "pricing" | "channels";

type ActionItem = {
  priority: "HIGH" | "MED" | "LOW";
  category: string;
  tab: OverviewTab;
  title: string;
  detail: string;
};

export function DashboardV2() {
  const [activeTab, setActiveTab] = useState<OverviewTab>("dashboard");
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState(false);
  const [heatmapLoadError, setHeatmapLoadError] = useState<string | null>(null);
  const [weekSpan, setWeekSpan] = useState<BirdseyeWeekSpan>(3);
  const [swapPlan, setSwapPlan] = useState<SwapStep[] | null>(null);
  const [swapCommitLoading, setSwapCommitLoading] = useState(false);
  const [kNightNights, setKNightNights] = useState(2);
  const [kNightSwapPlan, setKNightSwapPlan] = useState<SwapStep[] | null>(null);
  const [kNightLoading, setKNightLoading] = useState(false);
  const [kNightCommitLoading, setKNightCommitLoading] = useState(false);
  const [scorecard, setScorecard] = useState<DashboardScorecardResponse | null>(null);
  const [scorecardLoading, setScorecardLoading] = useState(false);
  const [showInsights, setShowInsights] = useState(true);
  const [eventInsights, setEventInsights] = useState<EventInsightsResponse | null>(null);
  const [pace, setPace] = useState<PaceResponse | null>(null);
  const [channelPerf, setChannelPerf] = useState<ChannelPerformanceResponse | null>(null);
  const { show, Toasts } = useToast();

  const todayStr = useMemo(() => new Date().toISOString().split("T")[0]!, []);

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadHeatmap = useCallback(async () => {
    setIsHeatmapLoading(true); setHeatmapLoadError(null);
    try {
      const h = await getHeatmap();
      setHeatmap(h.data); setIsHeatmapLoading(false);
    } catch {
      setHeatmap(null);
      setHeatmapLoadError("Occupancy matrix could not be loaded. Check API connection and retry.");
      setIsHeatmapLoading(false);
    }
  }, []);

  useEffect(() => { loadHeatmap(); }, [loadHeatmap]);

  // ── Derived slices ──────────────────────────────────────────────────────────

  const heatmapCategories = useMemo(() => (heatmap ? uniqueCategories(heatmap.rows) : []), [heatmap]);
  const allRows = useMemo(() => heatmap?.rows ?? [], [heatmap]);
  const spanDays = useMemo(() => heatmap ? Math.min(weekSpan * 7, heatmap.dates.length) : 0, [heatmap, weekSpan]);

  const scorecardSlice = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const start = parseISO(String(heatmap.dates[0]));
    const end = addDays(start, spanDays);
    return { startStr: formatISO(start, { representation: "date" }), endStr: formatISO(end, { representation: "date" }) };
  }, [heatmap, spanDays]);

  // ── Analytics (fire & forget when slice changes) ────────────────────────────

  useEffect(() => {
    if (!scorecardSlice) return;
    const { startStr, endStr } = scorecardSlice;
    getEventInsights({ start: startStr, end: endStr, as_of: todayStr }).then(r => setEventInsights(r.data)).catch(() => setEventInsights(null));
    getPace({ start: startStr, end: endStr, as_of: todayStr }).then(r => setPace(r.data as PaceResponse)).catch(() => setPace(null));
    getChannelPerformance({ start: startStr, end: endStr, categories: heatmapCategories }).then(r => setChannelPerf(r.data as ChannelPerformanceResponse)).catch(() => setChannelPerf(null));
  }, [scorecardSlice?.startStr, scorecardSlice?.endStr, todayStr]);

  // ── Scorecard ───────────────────────────────────────────────────────────────

  const refreshScorecard = useCallback(async (plan?: SwapStep[] | null) => {
    if (!scorecardSlice) return;
    setScorecardLoading(true);
    try {
      const res = await dashboardScorecard({ start: scorecardSlice.startStr, end: scorecardSlice.endStr, categories: heatmapCategories, k_nights: [2, 3], swap_plan: plan ?? null });
      setScorecard(res.data as DashboardScorecardResponse);
    } catch { setScorecard(null); } finally { setScorecardLoading(false); }
  }, [scorecardSlice, heatmapCategories]);

  useEffect(() => {
    if (!scorecardSlice || heatmapCategories.length === 0) return;
    void refreshScorecard(null);
  }, [scorecardSlice?.startStr, scorecardSlice?.endStr]);

  // ── Occupancy actions ────────────────────────────────────────────────────────

  const runOptimisePreview = useCallback(async () => {
    if (!heatmap) return;
    try {
      const start = parseISO(String(heatmap.dates[0]));
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const res = await dashboardOptimisePreview({ start: formatISO(start, { representation: "date" }), end: formatISO(end, { representation: "date" }), categories: heatmapCategories });
      const body = res.data as DashboardOptimisePreviewResponse;
      setSwapPlan(body.swap_plan ?? []);
      void refreshScorecard(body.swap_plan ?? null);
      if ((body.swap_plan?.length ?? 0) === 0) {
        show(body.fully_clean ? "No orphan gaps in this window." : "No improvements found (converged).", "info");
      } else { show(`Preview ready: ${body.shuffle_count} optimisation steps`, "success"); }
    } catch { show("Failed to run optimisation preview", "error"); setSwapPlan(null); void refreshScorecard(null); }
  }, [heatmap, weekSpan, heatmapCategories, show, refreshScorecard]);

  const clearOptimisePreview = useCallback(() => { setSwapPlan(null); void refreshScorecard(null); }, [refreshScorecard]);

  const commitSwapShuffle = useCallback(async () => {
    if (!swapPlan || swapPlan.length === 0) return;
    setSwapCommitLoading(true);
    try {
      await dashboardCommitShuffle(swapPlan);
      show(`Committed ${swapPlan.length} shuffle step(s)`, "success");
      setSwapPlan(null); await loadHeatmap(); void refreshScorecard(null);
    } catch { show("Failed to commit shuffle", "error"); } finally { setSwapCommitLoading(false); }
  }, [swapPlan, loadHeatmap, show, refreshScorecard]);

  const runKNightPreview = useCallback(async () => {
    if (!heatmap) return;
    setKNightLoading(true); setKNightSwapPlan(null);
    try {
      const start = parseISO(String(heatmap.dates[0]));
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const res = await dashboardOptimiseKNightPreview({ start: formatISO(start, { representation: "date" }), end: formatISO(end, { representation: "date" }), categories: heatmapCategories, target_nights: Math.max(1, Math.min(14, kNightNights)) });
      const body = res.data as DashboardKNightPreviewResponse;
      setKNightSwapPlan(body.swap_plan ?? []); void refreshScorecard(body.swap_plan ?? null);
      if ((body.swap_plan?.length ?? 0) === 0) show(`No k-night improvements for k=${body.target_nights}.`, "info");
      else show(`k-night preview (k=${body.target_nights}): ${body.shuffle_count} steps`, "success");
    } catch { show("Failed to run k-night preview", "error"); setKNightSwapPlan(null); void refreshScorecard(null);
    } finally { setKNightLoading(false); }
  }, [heatmap, kNightNights, heatmapCategories, show, weekSpan, refreshScorecard]);

  const commitKNightShuffle = useCallback(async () => {
    if (!kNightSwapPlan || kNightSwapPlan.length === 0) return;
    setKNightCommitLoading(true);
    try {
      await dashboardCommitShuffle(kNightSwapPlan);
      show(`Committed ${kNightSwapPlan.length} steps`, "success");
      setKNightSwapPlan(null); await loadHeatmap(); void refreshScorecard(null);
    } catch { show("Failed to commit shuffle", "error"); } finally { setKNightCommitLoading(false); }
  }, [kNightSwapPlan, loadHeatmap, show, refreshScorecard]);

  const refreshAllData = useCallback(async () => { await loadHeatmap(); }, [loadHeatmap]);

  // ── Computed KPIs ────────────────────────────────────────────────────────────

  const kpis = useMemo(
    () => (heatmap && spanDays > 0 ? birdseyeKpis(heatmap.dates.map(String), allRows, spanDays) : null),
    [heatmap, allRows, spanDays],
  );

  const runMetrics = useMemo(
    () => (heatmap && spanDays > 0 ? runMetricsFromRows(allRows, spanDays) : null),
    [heatmap, allRows, spanDays],
  );

  const channelMix = useMemo(
    () => (heatmap && spanDays > 0 ? channelMixFromRows(allRows, spanDays) : null),
    [heatmap, allRows, spanDays],
  );

  const topCh = useMemo(() => (channelMix ? topChannel(channelMix) : null), [channelMix]);
  const cancelRate = useMemo(() => (channelMix ? estimatedCancelRate(channelMix) : null), [channelMix]);
  const losFromSlice = useMemo(() => (heatmap && spanDays > 0 ? mostCommonLosFromRows(allRows, spanDays) : null), [heatmap, allRows, spanDays]);

  const mostCommonLos = useMemo(() => {
    if (eventInsights?.most_common_los_nights != null) return eventInsights.most_common_los_nights;
    return losFromSlice;
  }, [eventInsights, losFromSlice]);

  const paceDelta = useMemo(() => {
    if (!pace?.series || pace.series.length === 0) return null;
    let total = 0, count = 0;
    for (const s of pace.series) for (const p of s.points ?? []) { total += (p.on_books_occ_pct - p.expected_on_books_occ_pct); count++; }
    return count > 0 ? total / count : null;
  }, [pace]);

  // Per-day occupancy for the 14-night trend bar chart
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

  // Simulated rows for occupancy tab preview
  const simulatedRows = useMemo(() => {
    const plan = kNightSwapPlan?.length ? kNightSwapPlan : swapPlan;
    if (!heatmap || !plan?.length) return null;
    return simulateRows(allRows, plan);
  }, [heatmap, allRows, kNightSwapPlan, swapPlan]);

  // Snapshot for intelligence feed
  const snapshot = useMemo(() => {
    if (!heatmap) return null;
    return computeEmptyRunInventory(allRows, spanDays);
  }, [heatmap, allRows, spanDays]);

  // Intelligence feed (same logic as Dashboard v1)
  const intelligenceFeed = useMemo(() => {
    if (!snapshot || spanDays === 0) return [];
    const out: string[] = [];
    if (eventInsights?.most_common_los_nights != null)
      out.push(`Most likely length of stay: ${eventInsights.most_common_los_nights} nights.`);
    else if (losFromSlice != null)
      out.push(`Most likely length of stay: ${losFromSlice} nights (inferred from current bookings in this window).`);

    if (channelPerf?.channels && channelPerf.channels.length > 0) {
      const best = [...channelPerf.channels].sort((a, b) => b.room_nights - a.room_nights)[0]!;
      const partner = best.partners?.length ? [...best.partners].sort((a, b) => b.room_nights - a.room_nights)[0] : null;
      out.push(partner
        ? `Channel leader: ${best.channel}. Top partner: ${partner.partner} (${partner.share_of_channel_pct}% of ${best.channel} nights).`
        : `Channel leader: ${best.channel} with ${best.share_pct}% of booked nights in this window.`);
    } else if (topCh) {
      out.push(`Channel mix: ${topCh.channel} leads at ~${topCh.sharePct}% of booked nights in this window.`);
    }

    if (pace?.series?.length) {
      const pts = pace.series[0]?.points ?? [];
      if (pts.length > 0) {
        const avg = pts.reduce((s, p) => s + (p.on_books_occ_pct - p.expected_on_books_occ_pct), 0) / pts.length;
        out.push(`Booking pace vs 2yr baseline: ${avg >= 0 ? "ahead" : "behind"} by ~${Math.abs(Math.round(avg))} occ-pts.`);
      }
    }

    if (cancelRate != null)
      out.push(`Estimated cancellation rate (modelled from channel mix): ~${cancelRate}%.`);

    if (kpis?.sandwichMinlosBlockedNights)
      out.push(`${kpis.sandwichMinlosBlockedNights} orphan night(s) are blocked by MinLOS rules — go to Occupancy to recover them.`);

    return out.slice(0, 5);
  }, [snapshot, spanDays, eventInsights, losFromSlice, channelPerf, topCh, pace, cancelRate, kpis]);

  // Prioritised action queue — derived entirely from real data
  const actionQueue = useMemo((): ActionItem[] => {
    const items: ActionItem[] = [];
    const orphans = scorecard?.before.orphan_nights ?? kpis?.orphanNightsAtRisk ?? 0;
    const revRisk = scorecard?.before.revenue_at_risk ?? kpis?.orphanRevenueAtRisk ?? 0;

    if (orphans > 5)
      items.push({ priority: "HIGH", category: "Occupancy", tab: "occupancy", title: `${orphans} orphan nights stranded`, detail: `$${Math.round(revRisk).toLocaleString("en-US")} estimated revenue at risk — run a room shuffle to consolidate gaps into bookable runs.` });
    else if (orphans > 0)
      items.push({ priority: "MED", category: "Occupancy", tab: "occupancy", title: `${orphans} orphan night${orphans !== 1 ? "s" : ""} found`, detail: `$${Math.round(revRisk).toLocaleString("en-US")} at risk — consider a room shuffle to recover usable capacity.` });

    if (paceDelta !== null && paceDelta < -5)
      items.push({ priority: "HIGH", category: "Channels", tab: "channels", title: `Pace ${Math.abs(Math.round(paceDelta))} occ-pts behind 2yr baseline`, detail: "Pickup is significantly softer than expected — review channel mix and consider promotional activation." });
    else if (paceDelta !== null && paceDelta < -2)
      items.push({ priority: "MED", category: "Channels", tab: "channels", title: `Pace slightly behind baseline (${Math.abs(Math.round(paceDelta))} occ-pts)`, detail: "Monitor demand — consider activating OTA promotions or GDS preferred rates." });

    const mixTotal = channelMix ? Object.values(channelMix).reduce((s, n) => s + n, 0) : 0;
    const otaShare = mixTotal > 0 ? Math.round(((channelMix?.["OTA"] ?? 0) / mixTotal) * 100) : 0;
    if (otaShare > 65 && mixTotal > 0)
      items.push({ priority: "MED", category: "Channels", tab: "channels", title: `OTA concentration at ${otaShare}%`, detail: "Heavy OTA dependency compresses net margin — shift incremental demand to direct and GDS channels." });

    items.push({ priority: "MED", category: "Pricing", tab: "pricing", title: "Run RateIQ pricing analysis", detail: "AI agent synthesizes weather, events, market signals and live occupancy to surface rate and discount opportunities." });

    if (cancelRate !== null && cancelRate > 15)
      items.push({ priority: "LOW", category: "Occupancy", tab: "occupancy", title: `Modelled cancel rate ~${cancelRate}% (OTA-weighted)`, detail: "High OTA share inflates estimated cancellation risk — consider firmer non-refundable direct rate packages." });

    return items.slice(0, 5);
  }, [scorecard, kpis, paceDelta, channelMix, cancelRate]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      <Toasts />

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between mb-8 border-b border-border/50">
        <div className="flex gap-0">
          {(["dashboard", "occupancy", "pricing", "channels"] as OverviewTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2 ${activeTab === tab ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text hover:border-border"}`}
            >
              {tab === "dashboard" && <><Grid3x3 className="w-3.5 h-3.5" /> Dashboard</>}
              {tab === "occupancy" && <><Zap className="w-3.5 h-3.5" /> Occupancy</>}
              {tab === "pricing"   && <><DollarSign className="w-3.5 h-3.5" /> Pricing</>}
              {tab === "channels"  && <><BarChart2 className="w-3.5 h-3.5" /> Channels</>}
            </button>
          ))}
        </div>
        {/* V2 badge */}
        <div className="mb-1 flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-accent bg-accent/8 border border-accent/25 px-3 py-1">
          <Sparkles className="w-3 h-3" /> V2 Preview
        </div>
      </div>

      {/* ── Occupancy / Pricing / Channels tabs (unchanged) ─────────────────── */}
      {activeTab === "occupancy" && (
        <OccupancyOptimizationTab
          heatmap={heatmap}
          spanDays={heatmap ? heatmap.dates.length : 0}
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
        />
      )}
      {activeTab === "pricing"  && <PricingOptimizationTab />}
      {activeTab === "channels" && <ChannelOptimizationTab />}

      {/* ── Dashboard V2 main tab ─────────────────────────────────────────────── */}
      {activeTab === "dashboard" && (
        <div>

          {/* Header */}
          <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-0.5">Revenue Intelligence Center</div>
              <h1 className="font-serif font-bold text-2xl text-text">Hotel at a Glance</h1>
              <p className="text-[11px] text-text-muted mt-1">
                {heatmapCategories.length} room type{heatmapCategories.length !== 1 ? "s" : ""} · {allRows.length} active rooms · all data live from DB
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1 border border-border bg-surface-2/50">
                {([1, 2, 3] as BirdseyeWeekSpan[]).map(w => (
                  <button
                    key={w}
                    onClick={() => setWeekSpan(w)}
                    className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 transition-all ${weekSpan === w ? "bg-text text-surface" : "text-text-muted hover:text-text hover:bg-surface"}`}
                  >
                    {w}W
                  </button>
                ))}
              </div>
              <button
                onClick={refreshAllData}
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 border border-border bg-surface text-text-muted hover:text-text hover:bg-surface-2 transition-all"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
          </div>

          {/* Loading / error state */}
          {!heatmap && (
            <div className="py-20 text-center bg-surface border border-border">
              <Grid3x3 className="w-8 h-8 text-accent/40 mx-auto mb-4" />
              {isHeatmapLoading ? (
                <p className="text-sm text-text-muted">Loading hotel data…</p>
              ) : (
                <>
                  <p className="text-sm text-text-muted mb-4">{heatmapLoadError ?? "Something went wrong."}</p>
                  <button onClick={() => loadHeatmap()} className="text-xs font-bold uppercase tracking-widest px-6 py-2.5 bg-text text-surface hover:bg-text/90">
                    Retry
                  </button>
                </>
              )}
            </div>
          )}

          {heatmap && (
            <>
              {/* ── KPI STRIP (7 cards) ──────────────────────────────────────── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-2 mb-6">
                {/* Tonight Occ% */}
                <div className="bg-surface border border-border p-4">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Tonight</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">
                    {kpis ? `${Math.round(kpis.tonightOccupancyPct)}%` : "—"}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {kpis ? `${kpis.tonightRoomsOccupied} / ${kpis.tonightTotalRooms} rooms` : "—"}
                  </div>
                </div>

                {/* Orphan Nights */}
                {(() => {
                  const n = scorecard?.before.orphan_nights ?? kpis?.orphanNightsAtRisk ?? 0;
                  const isRisk = n > 0;
                  return (
                    <div className={`bg-surface border p-4 ${isRisk ? "border-occuorange/50" : "border-border"}`}>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Orphan Nights</div>
                      <div className={`text-2xl font-serif font-bold tabular-nums ${isRisk ? "text-occuorange" : "text-text"}`}>{n}</div>
                      <div className="text-[10px] text-text-muted mt-0.5">stranded gaps</div>
                    </div>
                  );
                })()}

                {/* Revenue at Risk */}
                {(() => {
                  const v = scorecard?.before.revenue_at_risk ?? 0;
                  const isRisk = v > 0;
                  return (
                    <div className={`bg-surface border p-4 ${isRisk ? "border-occuorange/30" : "border-border"}`}>
                      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Rev at Risk</div>
                      <div className={`text-2xl font-serif font-bold tabular-nums ${isRisk ? "text-occuorange" : "text-text"}`}>
                        {scorecard ? `$${Math.round(v).toLocaleString("en-US")}` : "—"}
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5">fill-model est.</div>
                    </div>
                  );
                })()}

                {/* Avg Rate */}
                <div className="bg-surface border border-border p-4">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Avg Rate</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">
                    {kpis ? `$${Math.round(kpis.avgRateInView).toLocaleString("en-US")}` : "—"}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {kpis ? `${kpis.avgRateNightCount} booked nights` : "—"}
                  </div>
                </div>

                {/* k=2 Windows */}
                <div className="bg-surface border border-border p-4">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">k=2 Windows</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">
                    {scorecardLoading ? "…" : (scorecard?.before.k_windows?.[2] ?? "—")}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">2-night openings</div>
                </div>

                {/* Top Channel */}
                <div className="bg-surface border border-border p-4">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">Top Channel</div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">{topCh?.channel ?? "—"}</div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {topCh ? `~${topCh.sharePct}% share` : "no data"}
                  </div>
                </div>

                {/* Booking Pace */}
                {(() => {
                  const isAhead = paceDelta !== null && paceDelta >= 0;
                  const isBehind = paceDelta !== null && paceDelta < 0;
                  return (
                    <div className={`bg-surface border p-4 ${isAhead ? "border-occugreen/40" : isBehind ? "border-occuorange/30" : "border-border"}`}>
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
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">

                {/* Col 1: 14-Night Occupancy Trend */}
                <div className="bg-surface border border-border p-5">
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
                <div className="bg-surface border border-border p-5">
                  <div className="mb-4 pb-3 border-b border-border/60">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Capacity</div>
                    <div className="font-serif font-bold text-base text-text mt-0.5">Gap Analysis</div>
                  </div>

                  {runMetrics && (() => {
                    const maxGap = Math.max(runMetrics.dist.n1, runMetrics.dist.n2_3, runMetrics.dist.n4_7, runMetrics.dist.n8p, 1);
                    const bars = [
                      { label: "1-night", count: runMetrics.dist.n1, color: "bg-occuorange", note: "hardest to sell" },
                      { label: "2–3 night", count: runMetrics.dist.n2_3, color: "bg-occuorange/50", note: "hard to fill" },
                      { label: "4–7 night", count: runMetrics.dist.n4_7, color: "bg-text/25", note: "convertible" },
                      { label: "8+ night", count: runMetrics.dist.n8p, color: "bg-occugreen/45", note: "easy to sell" },
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
                    {runMetrics && (
                      <div className="mt-3 pt-2 border-t border-border/40 text-[10px] text-text-muted">
                        <span className="font-bold text-text">{runMetrics.orphanNights}</span> orphan night{runMetrics.orphanNights !== 1 ? "s" : ""} in <span className="font-bold text-text">{runMetrics.orphanGaps}</span> gap{runMetrics.orphanGaps !== 1 ? "s" : ""} across {spanDays}-day window
                      </div>
                    )}
                  </div>
                </div>

                {/* Col 3: Channel Intelligence */}
                <div className="bg-surface border border-border p-5">
                  <div className="mb-4 pb-3 border-b border-border/60">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Distribution</div>
                    <div className="font-serif font-bold text-base text-text mt-0.5">Channel Intelligence</div>
                  </div>

                  {channelMix && Object.keys(channelMix).length > 0 ? (() => {
                    const total = Object.values(channelMix).reduce((s, n) => s + n, 0);
                    const CH_COLOR: Record<string, string> = { OTA: "bg-accent/55", DIRECT: "bg-occugreen/55", GDS: "bg-violet-400/50", WALKIN: "bg-amber-400/55" };
                    return (
                      <>
                        <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Booked nights by channel</div>
                        <div className="space-y-2 mb-4">
                          {Object.entries(channelMix).sort((a, b) => b[1] - a[1]).map(([ch, n]) => {
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
                    {topCh && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted">Top channel</span>
                        <span className="font-bold text-text">{topCh.channel} · {topCh.sharePct}%</span>
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
                    {cancelRate !== null && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted flex items-center gap-1">
                          Est. cancel rate <AiTag title="Modelled from channel mix heuristics — not historical data." />
                        </span>
                        <span className={`font-bold ${cancelRate > 15 ? "text-occuorange" : "text-text"}`}>~{cancelRate}%</span>
                      </div>
                    )}
                    {mostCommonLos !== null && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted">Common LOS</span>
                        <span className="font-bold text-text">{mostCommonLos} night{mostCommonLos !== 1 ? "s" : ""}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── BOTTOM: Action Queue + Capacity Scorecard ────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">

                {/* Action Queue */}
                <div className="bg-surface border border-border p-5">
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
                <div className="bg-surface border border-border p-5">
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
              {intelligenceFeed.length > 0 && (
                <div className={`border p-5 transition-colors ${showInsights ? "bg-accent/5 border-accent/20" : "bg-surface border-border"}`}>
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
                        {!showInsights && (
                          <div className="text-[11px] text-text-muted mt-0.5">{intelligenceFeed.length} signal{intelligenceFeed.length !== 1 ? "s" : ""} from this {weekSpan}W window</div>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setShowInsights(v => !v)}
                      className="text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 border border-border bg-surface hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
                    >
                      {showInsights ? "Collapse" : "Expand"}
                    </button>
                  </div>
                  {showInsights && (
                    <ul className="mt-4 space-y-2.5 pl-10">
                      {intelligenceFeed.map((line, i) => (
                        <li key={i} className="text-sm text-text leading-relaxed flex items-start gap-2">
                          <span className="text-accent/70 mt-1 text-xs shrink-0">→</span>
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

            </>
          )}
        </div>
      )}
    </div>
  );
}
