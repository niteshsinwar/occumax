import { useState, useCallback, useEffect, useMemo } from "react";
import { getHeatmap, fireOptimise, commitPlan, api, getChannelPerformance, channelAllocate, getChannelRecommendations, getChannelPartners } from "../api/client";
import type { HeatmapResponse, HeatmapRow, GapInfo, SwapStep, OptimiseResult, ChannelPerformanceResponse, ChannelStat, PartnerStat, ChannelRecommendResponse, ChannelRecommendation } from "../types";
import { HeatmapGrid } from "../components/Heatmap/HeatmapGrid";
import { useToast } from "../components/shared/Toast";
import { PricingPanel } from "../components/PricingPanel";
import { Zap, CheckCircle2, XCircle, Lock, Unlock, TrendingUp, DollarSign, BarChart2, RefreshCw, Sparkles, AlertTriangle } from "lucide-react";

type ManagerTab = "yield" | "pricing" | "channels";

type Stage = "idle" | "processing" | "preview" | "applied" | "converged";

// ── Run-metric helpers ────────────────────────────────────────────────────────

interface RunMetrics {
  orphanGaps: number;
  orphanNights: number;
  dist: { n1: number; n2_3: number; n4_7: number; n8p: number };
}

/**
 * Scan heatmap rows and classify consecutive EMPTY runs by length.
 * Orphan = EMPTY run ≤5 nights bounded by SOFT/HARD on both sides.
 */
function computeRunMetrics(rows: HeatmapRow[], maxDays = 20): RunMetrics {
  const runs: Array<{ length: number; isOrphan: boolean }> = [];
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    let i = 0;
    while (i < cells.length) {
      if (cells[i].block_type !== "EMPTY") { i++; continue; }
      const start = i;
      while (i < cells.length && cells[i].block_type === "EMPTY") i++;
      const length = i - start;
      const before = start > 0 ? cells[start - 1].block_type : null;
      const after  = i < cells.length ? cells[i].block_type : null;
      const isOrphan =
        length <= 5 &&
        (before === "SOFT" || before === "HARD") &&
        (after  === "SOFT" || after  === "HARD");
      runs.push({ length, isOrphan });
    }
  }
  const orphans = runs.filter(r => r.isOrphan);
  return {
    orphanGaps:   orphans.length,
    orphanNights: orphans.reduce((s, r) => s + r.length, 0),
    dist: {
      n1:   runs.filter(r => r.length === 1).length,
      n2_3: runs.filter(r => r.length >= 2 && r.length <= 3).length,
      n4_7: runs.filter(r => r.length >= 4 && r.length <= 7).length,
      n8p:  runs.filter(r => r.length >= 8).length,
    },
  };
}

/**
 * Apply gap shuffle plans to heatmap rows (client-side simulation — no DB write).
 * Returns a new rows array with SOFT/EMPTY cells swapped per each step.
 */
function simulateRows(rows: HeatmapRow[], swapPlan: SwapStep[]): HeatmapRow[] {
  if (swapPlan.length === 0) return rows;
  const cloned = rows.map(row => ({ ...row, cells: row.cells.map(c => ({ ...c })) }));
  const cellMap: Record<string, typeof cloned[0]["cells"][0]> = {};
  cloned.forEach(row => row.cells.forEach(cell => { cellMap[cell.slot_id] = cell; }));
  
  for (const step of swapPlan) {
    for (const dateStr of step.dates) {
      const from = cellMap[`${step.from_room}_${dateStr}`];
      const to   = cellMap[`${step.to_room}_${dateStr}`];
      if (from?.block_type === "SOFT" && to?.block_type === "EMPTY") {
        from.block_type = "EMPTY";
        to.block_type   = "SOFT";
      }
    }
  }
  return cloned;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ManagerDashboard() {
  const [activeTab,     setActiveTab]     = useState<ManagerTab>("yield");
  const [heatmap,       setHeatmap]       = useState<HeatmapResponse | null>(null);
  const [gaps,          setGaps]          = useState<GapInfo[]>([]);
  const [swapPlan,      setSwapPlan]      = useState<SwapStep[]>([]);
  const [stage,         setStage]         = useState<Stage>("idle");
  const [loadingCommit, setLoadingCommit] = useState(false);
  const [slotModal,     setSlotModal]     = useState<{ id: string; room: string; date: string; block: string } | null>(null);
  const [appliedGains,  setAppliedGains]  = useState<{ gapsElim: number; nightsFreed: number; shuffleCount: number } | null>(null);
  const [convergedState, setConvergedState] = useState<"clean" | "stuck">("clean");
  const [channelData,    setChannelData]    = useState<ChannelPerformanceResponse | null>(null);
  const [channelLoading, setChannelLoading] = useState(false);
  const [channelWindow,  setChannelWindow]  = useState<7 | 30 | 60>(30);

  // Channel allocation form state — partner list fetched from backend
  const [allocSources, setAllocSources] = useState<string[]>([]);
  const ALLOC_CATS = ["STANDARD","STUDIO","DELUXE","SUITE","PREMIUM","ECONOMY"];
  const todayStr = new Date().toISOString().split("T")[0];
  const defaultOut = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
  const [allocSource,   setAllocSource]   = useState("");
  const [allocCat,      setAllocCat]      = useState("DELUXE");
  const [allocIn,       setAllocIn]       = useState(todayStr);
  const [allocOut,      setAllocOut]      = useState(defaultOut);
  const [allocCount,    setAllocCount]    = useState(1);
  const [allocLoading,  setAllocLoading]  = useState(false);
  const [allocResult,   setAllocResult]   = useState<{ message: string; rooms: string[]; booking_ids: string[] } | null>(null);

  // AI channel recommendations
  const [aiRecs,        setAiRecs]        = useState<ChannelRecommendResponse | null>(null);
  const [aiRecsLoading, setAiRecsLoading] = useState(false);
  const [committedRecs, setCommittedRecs] = useState<Set<number>>(new Set());
  const [skippedRecs,   setSkippedRecs]   = useState<Set<number>>(new Set());

  const { show, Toasts } = useToast();

  // ── Data loading ────────────────────────────────────────────────────────

  const loadHeatmap = useCallback(async () => {
    try {
      const h = await getHeatmap();
      setHeatmap(h.data);
    } catch {
      show("Failed to load heatmap", "error");
    }
  }, [show]);

  useEffect(() => { loadHeatmap(); }, [loadHeatmap]);

  const loadChannelData = useCallback(async (window_days: number) => {
    setChannelLoading(true);
    try {
      const res = await getChannelPerformance({ window_days });
      setChannelData(res.data as ChannelPerformanceResponse);
    } catch {
      show("Failed to load channel data", "error");
    } finally {
      setChannelLoading(false);
    }
  }, [show]);

  const handleAllocate = async () => {
    if (!allocIn || !allocOut || allocCount < 1) return;
    setAllocLoading(true);
    setAllocResult(null);
    try {
      const res = await channelAllocate({
        booking_source: allocSource,
        category: allocCat,
        check_in: allocIn,
        check_out: allocOut,
        room_count: allocCount,
      });
      setAllocResult(res.data);
      show(res.data.message, "success");
      loadChannelData(channelWindow);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Allocation failed";
      show(msg, "error");
    } finally {
      setAllocLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "channels") loadChannelData(channelWindow);
  }, [activeTab, channelWindow, loadChannelData]);

  useEffect(() => {
    getChannelPartners().then(res => {
      const d = res.data as { ota: {name:string}[]; gds: {name:string}[]; direct: {name:string}[] };
      const sources = [
        ...d.direct.map(p => p.name),
        ...d.ota.map(p => p.name),
        ...d.gds.map(p => p.name),
      ];
      setAllocSources(sources);
      setAllocSource(prev => prev || sources[2] || sources[0]); // default to first OTA
    }).catch(() => {
      const fallback = ["Direct","Walk-in","MakeMyTrip","Goibibo","Agoda","Booking.com","Expedia","Amadeus","Sabre","Travelport"];
      setAllocSources(fallback);
      setAllocSource(prev => prev || "MakeMyTrip");
    });
  }, []);

  const handleRunAiAnalysis = async () => {
    setAiRecsLoading(true);
    setAiRecs(null);
    setCommittedRecs(new Set());
    setSkippedRecs(new Set());
    try {
      const res = await getChannelRecommendations();
      setAiRecs(res.data as ChannelRecommendResponse);
    } catch {
      show("AI channel analysis failed", "error");
    } finally {
      setAiRecsLoading(false);
    }
  };

  const handleCommitRec = async (rec: ChannelRecommendation, idx: number) => {
    try {
      await channelAllocate({
        booking_source: rec.booking_source,
        category: rec.category,
        check_in: rec.check_in,
        check_out: rec.check_out,
        room_count: rec.room_count,
      });
      setCommittedRecs(prev => new Set(prev).add(idx));
      show(`Allocated ${rec.room_count} ${rec.category} room(s) to ${rec.booking_source}`, "success");
      loadChannelData(channelWindow);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Allocation failed";
      show(msg, "error");
    }
  };

  // ── Optimization trigger ────────────────────────────────────────────────
  // Backend runs HHI optimisation inline and returns OptimiseResult.
  // Nothing is written to the DB yet — that only happens on commit.

  const runOptimization = async () => {
    setStage("processing");
    try {
      const res    = await fireOptimise();
      const result = res.data as OptimiseResult;
      await loadHeatmap();

      if (result.fully_clean || result.converged) {
        setConvergedState(result.fully_clean ? "clean" : "stuck");
        setGaps([]);
        setSwapPlan([]);
        setStage("converged");
        return;
      }

      setGaps(result.gaps);
      setSwapPlan(result.swap_plan);
      setStage("preview");
    } catch {
      show("Failed to run optimization", "error");
      setStage("idle");
    }
  };

  // ── Commit plan ─────────────────────────────────────────────────────────

  const handleCommit = async () => {
    if (!swapPlan.length) return;

    const gapsElim    = projectedMetrics ? (currentMetrics?.orphanGaps   ?? 0) - projectedMetrics.orphanGaps   : 0;
    const nightsFreed = projectedMetrics ? (currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights : 0;

    setLoadingCommit(true);
    show(`Committing ${swapPlan.length} optimization steps…`, "info");
    try {
      await commitPlan(swapPlan);
      setAppliedGains({ gapsElim, nightsFreed, shuffleCount: swapPlan.length });
      setGaps([]);
      setSwapPlan([]);
      await loadHeatmap();
      setStage("applied");
      show(`${swapPlan.length} room moves applied — calendar optimised`, "success");
    } catch {
      show("Commit failed", "error");
    } finally {
      setLoadingCommit(false);
    }
  };

  // ── Slot patch ──────────────────────────────────────────────────────────

  const handleSlotPatch = async (block_type: "EMPTY" | "HARD") => {
    if (!slotModal) return;
    try {
      await api.patch(`/admin/slots/${slotModal.id}`, { block_type, reason: "Manual edit by manager" });
      setSlotModal(null);
      await loadHeatmap();
    } catch (e: any) {
      show(e?.response?.data?.detail || "Cannot edit this slot", "error");
    }
  };

  // ── Derived state ────────────────────────────────────────────────────────

  const simulatedRows = useMemo(
    () => heatmap ? simulateRows(heatmap.rows, swapPlan) : [],
    [heatmap, swapPlan],
  );

  const currentMetrics = useMemo(
    () => heatmap ? computeRunMetrics(heatmap.rows) : null,
    [heatmap],
  );

  const projectedMetrics = useMemo(
    () => (stage === "preview" && gaps.length > 0) ? computeRunMetrics(simulatedRows) : null,
    [simulatedRows, stage, gaps.length],
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      <Toasts />

      {/* ── SLOT EDIT MODAL ───────────────────────────────────────────── */}
      {slotModal && (
        <div className="fixed inset-0 bg-text/60 backdrop-blur-sm flex items-center justify-center z-[999]">
          <div className="bg-surface border border-border shadow-2xl p-6 w-full max-w-sm">
            <h2 className="font-serif font-bold text-xl text-text mb-2">Configure Slot</h2>
            <div className="text-sm text-text-muted mb-6 flex items-center gap-2">
              Room {slotModal.room} · {slotModal.date}
              <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 border ${
                slotModal.block === "EMPTY" ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                : slotModal.block === "SOFT" ? "bg-sky-100 text-sky-800 border-sky-300"
                : "bg-stone-100 text-stone-700 border-stone-300"
              }`}>
                {slotModal.block}
              </span>
            </div>
            {slotModal.block === "SOFT" ? (
              <div className="bg-occuorange/10 border border-occuorange/20 text-occuorange text-xs font-semibold p-3 mb-6">
                Active guest reservation. Cannot override manually.
              </div>
            ) : (
              <div className="flex gap-2 mb-6">
                {slotModal.block !== "EMPTY" && (
                  <button
                    className="flex-1 bg-occugreen text-white text-sm font-semibold hover:bg-occugreen/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                    onClick={() => handleSlotPatch("EMPTY")}
                  >
                    <Unlock className="w-3.5 h-3.5" /> Free
                  </button>
                )}
                {slotModal.block !== "HARD" && (
                  <button
                    className="flex-1 bg-text text-surface text-sm font-semibold hover:bg-text/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                    onClick={() => handleSlotPatch("HARD")}
                  >
                    <Lock className="w-3.5 h-3.5" /> Block
                  </button>
                )}
              </div>
            )}
            <button
              className="w-full bg-surface-2 text-text text-sm font-semibold hover:bg-border active:scale-95 py-2.5 transition-all border border-border"
              onClick={() => setSlotModal(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── TAB BAR ───────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between mb-8 border-b border-border/50">
        <div className="flex gap-0">
          {(["yield", "pricing", "channels"] as ManagerTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === tab
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text hover:border-border"
              }`}
            >
              {tab === "yield"    && <><Zap        className="w-3.5 h-3.5" /> Room Optimisation</>}
              {tab === "pricing"  && <><DollarSign className="w-3.5 h-3.5" /> Pricing</>}
              {tab === "channels" && <><BarChart2  className="w-3.5 h-3.5" /> Channels</>}
            </button>
          ))}
        </div>

        {/* Tab-specific action buttons */}
        {activeTab === "yield" && (
          <div className="flex gap-3 pb-3">
            {(stage === "idle" || stage === "applied" || stage === "converged") && (
              <button
                className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all shadow-sm flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-text"
                onClick={runOptimization}
              >
                <Zap className="w-3.5 h-3.5 text-accent" /> Find & Fix Gaps
              </button>
            )}
            {stage === "processing" && (
              <button className="bg-surface-2 text-text font-semibold disabled:opacity-40 flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-border" disabled>
                <div className="w-3 h-3 border border-text border-t-accent rounded-full animate-spin" /> Processing
              </button>
            )}
            {stage === "preview" && (
              <>
                <button
                  className="bg-accent text-white font-semibold hover:brightness-110 active:scale-95 disabled:opacity-40 shadow-sm flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-accent"
                  onClick={handleCommit}
                  disabled={loadingCommit || !swapPlan.length}
                >
                  {loadingCommit
                    ? <><div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" /> Committing</>
                    : <><CheckCircle2 className="w-3.5 h-3.5" /> Commit All ({swapPlan.length})</>}
                </button>
                <button
                  className="bg-surface hover:bg-surface-2 border border-border text-text text-xs uppercase tracking-widest px-6 py-3 font-semibold rounded-sm transition-colors flex items-center gap-2"
                  onClick={() => { setGaps([]); setSwapPlan([]); setStage("idle"); }}
                >
                  <XCircle className="w-3.5 h-3.5 text-text-muted" /> Discard
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── YIELD TAB SUBTITLE ────────────────────────────────────────── */}
      {activeTab === "yield" && (
        <div className="text-xs tracking-wider text-text-muted mb-6 uppercase -mt-4">
          {stage === "idle"       && "Find and fix empty nights trapped between bookings"}
          {stage === "processing" && "Scanning your booking calendar..."}
          {stage === "preview"    && "Here's what we can fix — review and confirm"}
          {stage === "applied"    && "Changes applied successfully"}
          {stage === "converged"  && (convergedState === "clean"
            ? "Your calendar is clean — no gaps to fix right now"
            : "Some gaps exist but can't be moved without disturbing current guests")}
        </div>
      )}

      {/* ── PRICING TAB ───────────────────────────────────────────────── */}
      {activeTab === "pricing" && (
        <div className="bg-surface border border-border min-h-[600px] flex flex-col relative">
          {stage !== "applied" && stage !== "converged" ? (
            /* ── LOCKED overlay ─────────────────────────────────────────── */
            <div className="flex-1 flex flex-col items-center justify-center py-24 text-center px-6">
              <div className="w-14 h-14 rounded-full border-2 border-border flex items-center justify-center mb-6">
                <Lock className="w-6 h-6 text-text-muted" />
              </div>
              <h3 className="font-serif font-bold text-xl text-text mb-3">
                Fix your gaps first for better pricing
              </h3>
              <p className="text-xs text-text-muted max-w-sm leading-relaxed mb-6">
                Run the room optimisation scan first. Pricing recommendations are most accurate when your calendar is well-organised — it helps us understand your real demand pattern.
              </p>
              <button
                className="text-xs uppercase tracking-widest font-bold border border-border px-6 py-3 hover:bg-surface-2 transition-colors text-text flex items-center gap-2"
                onClick={() => setActiveTab("yield")}
              >
                <Zap className="w-3.5 h-3.5 text-accent" /> Go to Room Optimisation
              </button>
            </div>
          ) : (
            <PricingPanel />
          )}
        </div>
      )}

      {/* ── CHANNELS TAB ──────────────────────────────────────────────── */}
      {activeTab === "channels" && (
        <div className="space-y-6">
          {/* Header + window selector */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-serif font-bold text-xl text-text">Channel Performance</h2>
              <p className="text-xs text-text-muted mt-1 uppercase tracking-widest">Revenue by booking source · commission-adjusted net yield</p>
            </div>
            <div className="flex items-center gap-2">
              {([7, 30, 60] as const).map(w => (
                <button key={w}
                  onClick={() => setChannelWindow(w)}
                  className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 border transition-colors ${channelWindow === w ? "bg-text text-surface border-text" : "bg-surface text-text-muted border-border hover:bg-surface-2"}`}
                >
                  {w}d
                </button>
              ))}
              <button onClick={() => loadChannelData(channelWindow)} className="ml-2 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 border border-border bg-surface hover:bg-surface-2 flex items-center gap-1.5 text-text-muted">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
          </div>

          {channelLoading && (
            <div className="py-20 text-center">
              <div className="w-6 h-6 border-2 border-border border-t-accent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-xs text-text-muted uppercase tracking-widest">Loading channel data…</p>
            </div>
          )}

          {!channelLoading && channelData && (
            <>
              {/* KPI summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-surface border border-border p-4">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Total Gross</div>
                  <div className="text-2xl font-serif font-bold text-text">₹{channelData.total_gross_revenue.toLocaleString()}</div>
                  <div className="text-[10px] text-text-muted mt-1">{channelData.total_room_nights} room nights</div>
                </div>
                <div className="bg-surface border border-occugreen/30 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Net Revenue</div>
                  <div className="text-2xl font-serif font-bold text-occugreen">₹{channelData.total_net_revenue.toLocaleString()}</div>
                  <div className="text-[10px] text-text-muted mt-1">after commissions</div>
                </div>
                <div className="bg-occuorange/5 border border-occuorange/30 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-occuorange" />Commission Drain</div>
                  <div className="text-2xl font-serif font-bold text-occuorange">₹{(channelData.total_gross_revenue - channelData.total_net_revenue).toLocaleString()}</div>
                  <div className="text-[10px] text-text-muted mt-1">paid to channels</div>
                </div>
                <div className="bg-surface border border-border p-4">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Avg Rate</div>
                  <div className="text-2xl font-serif font-bold text-text">
                    ₹{channelData.total_room_nights > 0 ? Math.round(channelData.total_gross_revenue / channelData.total_room_nights).toLocaleString() : 0}
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">gross ADR</div>
                </div>
              </div>

              {/* Channel breakdown table */}
              <div className="bg-surface border border-border">
                <div className="px-6 py-3 border-b border-border bg-surface-2/60 flex items-center gap-2">
                  <BarChart2 className="w-3.5 h-3.5 text-accent" />
                  <span className="text-xs font-bold uppercase tracking-widest text-text">Channel Breakdown</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-widest text-text-muted font-bold border-b border-border/50">
                        <th className="px-6 py-3 text-left">Channel</th>
                        <th className="px-4 py-3 text-right">Nights</th>
                        <th className="px-4 py-3 text-right">Share</th>
                        <th className="px-4 py-3 text-right">Gross ADR</th>
                        <th className="px-4 py-3 text-right">Commission</th>
                        <th className="px-4 py-3 text-right">Gross Revenue</th>
                        <th className="px-4 py-3 text-right">Net Revenue</th>
                        <th className="px-6 py-3 text-left">Net Bar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channelData.channels.map((ch: ChannelStat) => {
                        const maxNet = Math.max(...channelData.channels.map(c => c.net_revenue));
                        const barWidth = maxNet > 0 ? Math.round((ch.net_revenue / maxNet) * 100) : 0;
                        const isOta = ch.channel === "OTA" || ch.channel === "GDS";
                        const channelBadge = `text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 border ${
                          ch.channel === "OTA"    ? "bg-amber-50 text-amber-700 border-amber-200" :
                          ch.channel === "GDS"    ? "bg-violet-50 text-violet-700 border-violet-200" :
                          ch.channel === "DIRECT" ? "bg-teal-50 text-teal-700 border-teal-200" :
                          ch.channel === "WALKIN" ? "bg-orange-50 text-orange-700 border-orange-200" :
                                                    "bg-surface-2 text-text-muted border-border"
                        }`;
                        return (
                          <>
                            {/* Channel summary row */}
                            <tr key={ch.channel} className="border-b border-border/30 bg-surface hover:bg-surface-2/30 transition-colors">
                              <td className="px-6 py-3">
                                <span className={channelBadge}>{ch.channel}</span>
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text">{ch.room_nights}</td>
                              <td className="px-4 py-3 text-right">
                                <span className="text-xs font-bold text-text">{ch.share_pct}%</span>
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs text-text">₹{ch.avg_rate.toLocaleString()}</td>
                              <td className="px-4 py-3 text-right">
                                {ch.commission_pct > 0 ? (
                                  <span className="text-[10px] font-bold text-occuorange bg-occuorange/8 border border-occuorange/20 px-1.5 py-0.5">{ch.commission_pct}%</span>
                                ) : (
                                  <span className="text-[10px] font-bold text-occugreen bg-occugreen/8 border border-occugreen/20 px-1.5 py-0.5">0%</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs text-text-muted">₹{ch.gross_revenue.toLocaleString()}</td>
                              <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text">₹{ch.net_revenue.toLocaleString()}</td>
                              <td className="px-6 py-3">
                                <div className="w-32 bg-surface-2 border border-border/30 h-3 relative">
                                  <div className={`h-full ${isOta ? "bg-occuorange/60" : "bg-occugreen/60"}`} style={{ width: `${barWidth}%` }} />
                                </div>
                              </td>
                            </tr>
                            {/* Partner sub-rows — shown for channels that have named partners */}
                            {ch.partners.map((pt: PartnerStat) => (
                              <tr key={`${ch.channel}-${pt.partner}`} className="border-b border-border/10 bg-surface-2/20">
                                <td className="px-6 py-1.5 pl-10">
                                  <span className="text-[10px] text-text-muted font-medium">↳ {pt.partner}</span>
                                </td>
                                <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">{pt.room_nights}</td>
                                <td className="px-4 py-1.5 text-right text-[10px] text-text-muted">{pt.share_of_channel_pct}% of {ch.channel}</td>
                                <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">₹{pt.avg_rate.toLocaleString()}</td>
                                <td className="px-4 py-1.5" />
                                <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">₹{pt.gross_revenue.toLocaleString()}</td>
                                <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">₹{pt.net_revenue.toLocaleString()}</td>
                                <td className="px-6 py-1.5" />
                              </tr>
                            ))}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* AI Allocation Recommendation */}
              <div className="bg-accent/5 border border-accent/20 p-6">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-accent" />
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">Revenue Intelligence · Channel Optimisation</div>
                    <p className="text-sm text-text leading-relaxed mb-4">{channelData.recommendation}</p>
                    {/* Allocation advice */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
                      {channelData.channels.slice(0, 3).map((ch: ChannelStat) => {
                        const netPct = channelData.total_gross_revenue > 0
                          ? Math.round((ch.net_revenue / channelData.total_gross_revenue) * 100) : 0;
                        const advice = ch.commission_pct === 0
                          ? "Maximise allocation — zero commission, full revenue retained"
                          : ch.share_pct > 50
                          ? "High dependency — reduce allocation, push direct equivalent"
                          : ch.share_pct < 10
                          ? "Low volume — consider increasing if direct inventory is full"
                          : "Balanced — maintain current allocation";
                        return (
                          <div key={ch.channel} className="bg-surface border border-border p-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[10px] font-bold uppercase tracking-widest text-text">{ch.channel}</span>
                              <span className="text-[10px] font-bold text-text-muted">{netPct}% of net</span>
                            </div>
                            <div className="text-[10px] text-text-muted leading-relaxed">{advice}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
              {/* ── AI Channel Recommendation Panel ──────────────────────── */}
              <div className="border border-accent/20 bg-accent/5 p-6">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                      <Sparkles className="w-4 h-4 text-accent" />
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-accent">Gemini AI · Channel Allocation</div>
                      <div className="text-[10px] text-text-muted mt-0.5">Analyses 14-day gaps + partner history to recommend where to push inventory</div>
                    </div>
                  </div>
                  <button
                    onClick={handleRunAiAnalysis}
                    disabled={aiRecsLoading}
                    className="bg-accent text-white text-[10px] font-bold uppercase tracking-widest px-5 py-2.5 hover:brightness-110 active:scale-95 disabled:opacity-50 flex items-center gap-2 transition-all"
                  >
                    {aiRecsLoading
                      ? <><div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" /> Analysing…</>
                      : <><Sparkles className="w-3 h-3" /> Run AI Analysis</>}
                  </button>
                </div>

                {aiRecsLoading && (
                  <div className="py-10 text-center">
                    <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-xs text-text-muted">Gemini is analysing your inventory gaps and channel history…</p>
                  </div>
                )}

                {aiRecs && !aiRecsLoading && (
                  <div className="space-y-3">
                    {aiRecs.summary && (
                      <div className="bg-surface border border-border p-4 text-sm text-text leading-relaxed">
                        {aiRecs.summary}
                      </div>
                    )}
                    {aiRecs.recommendations.length === 0 && (
                      <div className="py-8 text-center text-xs text-text-muted">No recommendations — your channel mix looks healthy.</div>
                    )}
                    {aiRecs.recommendations.map((rec: ChannelRecommendation, idx: number) => {
                      const isCommitted = committedRecs.has(idx);
                      const isSkipped   = skippedRecs.has(idx);
                      const confColor = rec.confidence === "HIGH" ? "text-occugreen border-occugreen/40 bg-occugreen/5"
                        : rec.confidence === "MEDIUM" ? "text-occuorange border-occuorange/40 bg-occuorange/5"
                        : "text-text-muted border-border bg-surface-2";
                      const typeColor = rec.channel_type === "OTA" ? "bg-amber-50 text-amber-700 border-amber-200"
                        : rec.channel_type === "GDS" ? "bg-violet-50 text-violet-700 border-violet-200"
                        : "bg-teal-50 text-teal-700 border-teal-200";
                      return (
                        <div key={idx} className={`bg-surface border p-4 transition-all ${isCommitted ? "border-occugreen/40 opacity-70" : isSkipped ? "border-border opacity-40" : "border-border"}`}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-2">
                                <span className="font-bold text-sm text-text">{rec.booking_source}</span>
                                <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 border ${typeColor}`}>{rec.channel_type}</span>
                                <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 border ${confColor}`}>{rec.confidence}</span>
                                <span className="text-[10px] text-text-muted font-medium">{rec.category}</span>
                                <span className="text-[10px] text-text-muted">{rec.check_in} → {rec.check_out}</span>
                                <span className="text-[10px] text-text-muted">{rec.room_count} room{rec.room_count > 1 ? "s" : ""}</span>
                              </div>
                              <p className="text-xs text-text-muted leading-relaxed mb-3">{rec.reasoning}</p>
                              <div className="flex items-center gap-4 text-[10px] font-mono">
                                <span className="text-text-muted">Gross <span className="text-text font-bold">₹{rec.expected_gross.toLocaleString()}</span></span>
                                {rec.commission_cost > 0 && <span className="text-occuorange">Commission −₹{rec.commission_cost.toLocaleString()}</span>}
                                <span className="text-occugreen font-bold">Net ₹{rec.expected_net.toLocaleString()}</span>
                              </div>
                            </div>
                            <div className="flex flex-col gap-2 shrink-0">
                              {isCommitted ? (
                                <span className="text-[10px] font-bold text-occugreen flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Committed</span>
                              ) : isSkipped ? (
                                <span className="text-[10px] font-bold text-text-muted flex items-center gap-1"><XCircle className="w-3 h-3" /> Skipped</span>
                              ) : (
                                <>
                                  <button
                                    onClick={() => handleCommitRec(rec, idx)}
                                    className="bg-text text-surface text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 hover:opacity-90 active:scale-95 flex items-center gap-1 transition-all"
                                  >
                                    <CheckCircle2 className="w-3 h-3" /> Commit
                                  </button>
                                  <button
                                    onClick={() => setSkippedRecs(prev => new Set(prev).add(idx))}
                                    className="bg-surface border border-border text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 hover:bg-surface-2 active:scale-95 flex items-center gap-1 transition-all text-text-muted"
                                  >
                                    <XCircle className="w-3 h-3" /> Skip
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!aiRecs && !aiRecsLoading && (
                  <div className="py-8 text-center text-xs text-text-muted border border-dashed border-accent/20">
                    Press "Run AI Analysis" — Gemini will check your gaps and recommend channel allocations.
                  </div>
                )}
              </div>

              {/* ── Channel Allocation Commit Panel ──────────────────────── */}
              <div className="border border-border bg-surface p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-8 h-8 bg-text/5 border border-border flex items-center justify-center shrink-0">
                    <TrendingUp className="w-4 h-4 text-text" />
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-text">Commit Channel Allocation</div>
                    <div className="text-[10px] text-text-muted mt-0.5">Pre-block inventory for a booking source based on AI recommendation</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Booking Source</label>
                    <select
                      value={allocSource}
                      onChange={e => setAllocSource(e.target.value)}
                      className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                    >
                      {allocSources.map((s: string) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Category</label>
                    <select
                      value={allocCat}
                      onChange={e => setAllocCat(e.target.value)}
                      className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                    >
                      {ALLOC_CATS.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Check-in</label>
                    <input
                      type="date" value={allocIn} min={todayStr}
                      onChange={e => setAllocIn(e.target.value)}
                      className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Check-out</label>
                    <input
                      type="date" value={allocOut} min={allocIn}
                      onChange={e => setAllocOut(e.target.value)}
                      className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Rooms</label>
                    <input
                      type="number" min={1} max={10} value={allocCount}
                      onChange={e => setAllocCount(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      onClick={handleAllocate}
                      disabled={allocLoading}
                      className="w-full bg-text text-surface font-bold uppercase tracking-widest text-[10px] px-3 py-2 hover:opacity-90 active:scale-95 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
                    >
                      {allocLoading ? <><AlertTriangle className="w-3 h-3 animate-pulse" />Working…</> : <>Allocate</>}
                    </button>
                  </div>
                </div>

                {allocResult && (
                  <div className="bg-occugreen/5 border border-occugreen/30 p-3 text-xs">
                    <div className="font-bold text-occugreen uppercase tracking-widest text-[10px] mb-1">Allocation committed</div>
                    <div className="text-text">{allocResult.message}</div>
                    {allocResult.rooms.length > 0 && (
                      <div className="text-text-muted mt-1">Rooms: {allocResult.rooms.join(", ")} · Booking IDs: {allocResult.booking_ids.join(", ")}</div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {!channelLoading && !channelData && (
            <div className="py-20 text-center border border-border bg-surface">
              <BarChart2 className="w-8 h-8 text-accent/30 mx-auto mb-4" />
              <p className="text-sm text-text-muted">No channel data available for this period.</p>
            </div>
          )}
        </div>
      )}

      {/* ── YIELD TAB ─────────────────────────────────────────────────── */}
      {activeTab === "yield" && <>

      {/* ── OPERATIONAL KPI CARDS ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        {[
          {
            label: "Empty Gaps",
            value: currentMetrics?.orphanGaps ?? "—",
            sub: `${currentMetrics?.orphanNights ?? 0} nights stuck between bookings`,
            color: "border-occured text-occured",
          },
          {
            label: "Hard to Fill",
            value: (currentMetrics?.dist.n1 ?? 0) + (currentMetrics?.dist.n2_3 ?? 0),
            sub: "1–3 night gaps — guests rarely book these",
            color: "border-occuorange text-occuorange",
          },
          (() => {
            const delta = projectedMetrics != null
              ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps
              : null;
            const nightsDelta = projectedMetrics != null
              ? (currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights
              : null;
            const improved = delta !== null && delta > 0;
            const neutral  = delta !== null && delta === 0;
            return {
              label: "Gaps Fixed",
              value: delta === null ? "—" : improved ? `+${delta}` : delta === 0 ? "0" : "~0",
              sub: nightsDelta === null
                ? "run scan to see impact"
                : nightsDelta > 0 ? `${nightsDelta} nights recovered`
                : nightsDelta < 0 ? "gaps consolidated — minor tradeoffs"
                : "no orphan change",
              color: improved ? "border-occugreen text-occugreen"
                : neutral    ? "border-border text-text-muted"
                :              "border-occuorange text-occuorange",
            };
          })(),
          {
            label: "Easy to Sell",
            value: projectedMetrics != null
              ? projectedMetrics.dist.n4_7 + projectedMetrics.dist.n8p
              : (currentMetrics?.dist.n4_7 ?? 0) + (currentMetrics?.dist.n8p ?? 0),
            sub: projectedMetrics != null
              ? `after applying fixes (was ${(currentMetrics?.dist.n4_7 ?? 0) + (currentMetrics?.dist.n8p ?? 0)})`
              : "stretches of 4+ nights — bookable",
            color: "border-accent text-accent",
          },
        ].map((m, i) => (
          <div key={i} className="bg-surface border border-border shadow-subtle p-5 relative overflow-hidden">
            <div className={`absolute top-0 left-0 w-1 h-full ${m.color.split(" ")[0].replace("border", "bg")}`} />
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-[0.1em]">{m.label}</div>
            <div className={`text-3xl font-serif font-bold mt-2 ${m.color.split(" ")[1]}`}>{m.value}</div>
            <div className="text-xs text-text-muted mt-1 font-medium">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* ── RUN DISTRIBUTION WIDGET ───────────────────────────────────── */}
      {currentMetrics && stage !== "processing" && (
        <RunDistributionWidget current={currentMetrics} projected={projectedMetrics} stage={stage} />
      )}

      {/* ── PROCESSING STATE ──────────────────────────────────────────── */}
      {stage === "processing" && (
        <div className="bg-surface-2 border border-border p-10 mb-8 flex items-center justify-center">
          <div className="flex flex-col items-center max-w-sm text-center">
            <div className="w-10 h-10 border-2 border-border border-t-accent rounded-full animate-spin mb-6" />
            <h3 className="text-lg font-serif font-bold text-text">Scanning your booking calendar...</h3>
            <p className="text-xs text-text-muted mt-2 tracking-wide">
              Looking for empty nights trapped between bookings that can be moved to create longer, more bookable stretches.
            </p>
          </div>
        </div>
      )}

      {/* ── HEATMAP(S) ────────────────────────────────────────────────── */}
      {heatmap && stage !== "processing" && (
        <div className="bg-surface border border-border">
          {stage === "preview" && gaps.length > 0 ? (
            <>
              <div className="px-6 py-4 flex justify-between items-center bg-surface-2/50 border-b border-border">
                <h3 className="font-serif font-bold text-lg text-text">Before & After Preview</h3>
                <span className="text-[10px] uppercase font-bold tracking-widest text-occuorange border border-occuorange/30 bg-occuorange/5 px-3 py-1">
                  Not applied yet
                </span>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-px bg-border p-[1px]">
                <div className="bg-surface p-6">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={heatmap.rows}
                    title="Current Topology"
                    compact
                    maxDays={20}
                    hideLegend
                    onCellClick={setSlotModal}
                  />
                </div>
                <div className="bg-surface p-6">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={simulatedRows}
                    title="Projected After Commit"
                    compact
                    maxDays={20}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="p-6">
              <h3 className="font-serif font-bold text-lg text-text mb-6">Inventory Matrix</h3>
              <HeatmapGrid
                dates={heatmap.dates}
                rows={heatmap.rows}
                maxDays={20}
                onCellClick={setSlotModal}
              />
            </div>
          )}
        </div>
      )}

      {/* ── GAP PLAN SUMMARY (preview only) ───────────────────────────── */}
      {stage === "preview" && gaps.length > 0 && (
        <div className="bg-surface border border-accent mt-8 p-6 shadow-subtle">
          <div className="flex justify-between flex-wrap gap-4 mb-6">
            <div>
              <h3 className="font-serif font-bold text-xl text-text">Ready to apply</h3>
              <div className="text-xs text-text-muted uppercase tracking-wider mt-1">
                {gaps.length} gap{gaps.length !== 1 ? "s" : ""} found · {swapPlan.length} room move{swapPlan.length !== 1 ? "s" : ""} needed
              </div>
            </div>
            <div className="text-right">
              {(() => {
                const gapDelta    = projectedMetrics != null ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps : null;
                const nightsDelta = projectedMetrics != null ? (currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights : null;
                const improved    = gapDelta !== null && gapDelta > 0;
                return (
                  <>
                    <div className="text-[10px] text-text-muted uppercase tracking-widest">
                      {improved ? "Gaps Eliminated" : "Calendar Optimised"}
                    </div>
                    <div className={`text-3xl font-serif font-bold ${improved ? "text-occugreen" : "text-accent"}`}>
                      {gapDelta === null ? gaps.length : improved ? gapDelta : gaps.length}
                    </div>
                    {nightsDelta !== null && (
                      <div className="text-xs text-text-muted mt-1">
                        {nightsDelta > 0
                          ? `${nightsDelta} nights freed up`
                          : nightsDelta < 0
                          ? "bookings consolidated across rooms"
                          : "calendar rearranged"}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          <div className="grid gap-2 mb-8 max-h-80 overflow-y-auto pr-2">
            {gaps.map((gap, i) => <GapEntry key={i} gap={gap} />)}
          </div>

          <div className="flex flex-wrap gap-4">
            <button
              className="flex-1 bg-occugreen text-white font-bold hover:brightness-110 active:scale-95 uppercase tracking-widest text-xs px-6 py-4 shadow-sm"
              onClick={handleCommit}
              disabled={loadingCommit}
            >
              {loadingCommit ? "Applying changes..." : "Apply Changes"}
            </button>
            <button
              className="bg-surface border border-border text-text uppercase tracking-widest font-bold text-xs px-8 py-4 hover:bg-surface-2"
              onClick={() => { setGaps([]); setSwapPlan([]); setStage("idle"); }}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {/* ── APPLIED BANNER ────────────────────────────────────────────── */}
      {stage === "applied" && appliedGains && (
        <div className="mt-8 bg-surface border border-border p-8 flex items-center justify-between shadow-subtle relative overflow-hidden">
          <div className="absolute top-0 left-0 h-1 w-full bg-occugreen" />
          <div>
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-[0.15em]">Done!</div>
            <div className="text-4xl font-serif font-bold text-occugreen mt-1">
              {appliedGains.shuffleCount} room moves applied
            </div>
            <div className="text-xs text-text-muted mt-2 font-medium">
              Calendar optimised · {appliedGains.nightsFreed > 0 ? `${appliedGains.nightsFreed} nights freed` : "bookings consolidated"} · {appliedGains.shuffleCount} swap{appliedGains.shuffleCount !== 1 ? "s" : ""}
            </div>
          </div>
          <TrendingUp className="w-12 h-12 text-occugreen opacity-80" />
        </div>
      )}

      {/* ── CONVERGED BANNER ──────────────────────────────────────────── */}
      {stage === "converged" && (
        <div className="mt-8 bg-surface-2 border border-border p-8 flex items-center justify-between relative overflow-hidden">
          <div className={`absolute top-0 left-0 h-1 w-full ${convergedState === "clean" ? "bg-occugreen" : "bg-text-muted"}`} />
          <div>
            <div className="text-[10px] font-bold text-text uppercase tracking-[0.15em]">Scan complete</div>
            <div className="text-2xl font-serif font-bold text-text mt-1">
              {convergedState === "clean" ? "Your calendar looks great!" : "Some gaps can't be fixed right now"}
            </div>
            <div className="text-xs text-text-muted mt-2 max-w-md leading-relaxed">
              {convergedState === "clean"
                ? "No empty gaps between bookings. Your rooms are well-organised and ready to sell."
                : "A few empty nights remain between bookings but moving them would disrupt current guests. Check back as new bookings come in."}
            </div>
          </div>
          <Lock className={`w-12 h-12 opacity-20 ${convergedState === "clean" ? "text-occugreen" : "text-text"}`} />
        </div>
      )}

      {/* ── IDLE EMPTY STATE ──────────────────────────────────────────── */}
      {stage === "idle" && !heatmap && (
        <div className="bg-surface border border-border py-24 px-6 text-center">
          <Zap className="w-8 h-8 text-accent/50 mx-auto mb-6" />
          <h2 className="text-2xl font-serif font-bold text-text mb-2">Find empty gaps in your calendar</h2>
          <p className="text-xs text-text-muted font-medium mb-8 max-w-sm mx-auto leading-relaxed">
            Scan your bookings to find nights stuck between reservations. We'll suggest room moves that free them up for new guests.
          </p>
          <button
            className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 shadow-sm text-xs uppercase tracking-widest px-8 py-3.5 mx-auto block"
            onClick={runOptimization}
          >
            Scan Now
          </button>
        </div>
      )}

      </>}
    </div>
  );
}

// ── GapEntry — one row per detected orphan gap ────────────────────────────────

function GapEntry({ gap }: { gap: GapInfo }) {
  return (
    <div className="bg-surface-2 border border-border/50 p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full bg-accent" />
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[9px] font-bold tracking-wider uppercase bg-accent-dim text-accent px-2 py-0.5 border border-accent/20">
          Room move
        </span>
        <span className="text-xs text-text font-medium">
          Room {gap.room_id} · {gap.gap_length}-night gap · {gap.date_range}
        </span>
        <span className="ml-auto text-[10px] font-bold text-occugreen uppercase tracking-wider">
          {gap.gap_length} nights recovered
        </span>
      </div>
      <div className="pl-2 border-l border-border/60 ml-2 space-y-1.5">
        {gap.shuffle_plan.map((step, i) => (
          <div key={i} className="text-[11px] text-text-muted flex items-center gap-2">
            <span className="text-text font-mono tracking-tighter">{step.booking_id.slice(-6)}</span>
            <span className="bg-surface border border-border px-1.5 py-0.5">{step.from_room}</span>
            <span className="text-border">&rarr;</span>
            <span className="bg-surface border border-border font-bold text-text px-1.5 py-0.5">{step.to_room}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RunDistributionWidget ─────────────────────────────────────────────────────

const BUCKETS: Array<{
  label: string;
  key: keyof RunMetrics["dist"];
  desc: string;
  positiveIsMore: boolean;
}> = [
  { label: "1 night",    key: "n1",   desc: "Almost impossible to fill",          positiveIsMore: false },
  { label: "2–3 nights", key: "n2_3", desc: "Short gaps — hard to sell",           positiveIsMore: false },
  { label: "4–7 nights", key: "n4_7", desc: "Standard stays — easy to book",       positiveIsMore: true  },
  { label: "8+ nights",  key: "n8p",  desc: "Long stretches — high value guests",  positiveIsMore: true  },
];

function RunDistributionWidget({
  current,
  projected,
  stage,
}: {
  current: RunMetrics;
  projected: RunMetrics | null;
  stage: Stage;
}) {
  const showProjected = projected !== null && (stage === "preview" || stage === "applied");
  const maxVal = Math.max(
    ...BUCKETS.flatMap(b => [current.dist[b.key], projected ? projected.dist[b.key] : 0]),
    1,
  );

  return (
    <div className="bg-surface border border-border shadow-subtle p-6 mb-8">
      <div className="flex items-center justify-between mb-5 pb-4 border-b border-border/50">
        <div>
          <h3 className="font-serif font-bold text-lg text-text">Booking gap analysis</h3>
          <p className="text-[10px] text-text-muted mt-0.5 uppercase tracking-widest font-bold">
            {showProjected ? "Current vs after applying fixes" : "How your empty nights are distributed — next 20 days"}
          </p>
        </div>
        {showProjected && (
          <div className="flex items-center gap-5 text-[9px] font-bold uppercase tracking-widest text-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-text/20 inline-block border border-border/60" /> Current
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-occugreen/50 inline-block border border-occugreen/30" /> Projected
            </span>
          </div>
        )}
      </div>

      <div className="space-y-5">
        {BUCKETS.map(({ label, key, desc, positiveIsMore }) => {
          const cur   = current.dist[key];
          const proj  = projected?.dist[key] ?? null;
          const delta = proj !== null ? proj - cur : null;
          const isGoodDelta = delta !== null && (positiveIsMore ? delta > 0 : delta < 0);
          const isBadDelta  = delta !== null && delta !== 0 && !isGoodDelta;
          return (
            <div key={key} className="flex items-start gap-4">
              <div className="w-28 shrink-0 text-right pt-0.5">
                <div className="text-[10px] font-bold text-text uppercase tracking-wider leading-tight">{label}</div>
                <div className="text-[9px] text-text-muted mt-0.5 leading-tight hidden sm:block">{desc}</div>
              </div>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-6 bg-surface-2 relative overflow-hidden border border-border/50">
                    <div
                      className={`h-full transition-all duration-500 ${positiveIsMore ? "bg-accent/25" : "bg-occured/20"}`}
                      style={{ width: cur > 0 ? `${Math.max((cur / maxVal) * 100, 5)}%` : "0%" }}
                    />
                    <span className="absolute left-2 top-0 h-full flex items-center text-[10px] font-bold text-text">
                      {cur} run{cur !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                {showProjected && proj !== null && (
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-6 relative overflow-hidden border bg-occugreen/5 border-occugreen/20">
                      <div
                        className="h-full bg-occugreen/50 transition-all duration-700"
                        style={{ width: proj > 0 ? `${Math.max((proj / maxVal) * 100, 5)}%` : "0%" }}
                      />
                      <span className="absolute left-2 top-0 h-full flex items-center gap-2 text-[10px] font-bold text-occugreen">
                        {proj} run{proj !== 1 ? "s" : ""}
                        {delta !== null && delta !== 0 && (
                          <span className={`text-[9px] font-black ${isGoodDelta ? "text-occugreen" : isBadDelta ? "text-occured" : ""}`}>
                            {delta > 0 ? `+${delta}` : delta}
                          </span>
                        )}
                        {delta === 0 && <span className="text-[9px] text-text-muted font-normal">no change</span>}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
