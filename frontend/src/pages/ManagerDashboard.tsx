import { useState, useCallback, useEffect, useMemo } from "react";
import { getHeatmap, fireOptimise, commitPlan, api } from "../api/client";
import type { HeatmapResponse, HeatmapRow, GapInfo, SwapStep, OptimiseResult } from "../types";
import { HeatmapGrid } from "../components/Heatmap/HeatmapGrid";
import { BirdseyeInventoryHighlights } from "../components/BirdseyeInventoryHighlights";
import { useToast } from "../components/shared/Toast";
import { PricingPanel } from "../components/PricingPanel";
import { computeEmptyRunInventory } from "../utils/inventoryAvailability";
import { Zap, CheckCircle2, XCircle, Lock, Unlock, TrendingUp, DollarSign, Grid3x3, RefreshCw } from "lucide-react";

type ManagerTab = "yield" | "pricing" | "birdseyeview";

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
      show(`Optimization applied: ${gapsElim} gaps resolved`, "success");
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

  const birdseyeMaxDays = 20;

  /** Consecutive EMPTY runs by length and room category for the Bird's Eye side panel. */
  const birdseyeSnapshot = useMemo(
    () => (heatmap ? computeEmptyRunInventory(heatmap.rows, birdseyeMaxDays) : null),
    [heatmap],
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
          {(["yield", "pricing", "birdseyeview"] as ManagerTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === tab
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text hover:border-border"
              }`}
            >
              {tab === "yield"   && <><Zap        className="w-3.5 h-3.5" /> Yield Operations</>}
              {tab === "pricing" && (
                <>
                  <DollarSign className="w-3.5 h-3.5" /> Dynamic Pricing
                  {stage !== "applied" && stage !== "converged" && (
                    <Lock className="w-2.5 h-2.5 ml-0.5 opacity-50" />
                  )}
                </>
              )}
              {tab === "birdseyeview" && <><Grid3x3 className="w-3.5 h-3.5" /> Bird's Eye View</>}
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
                <Zap className="w-3.5 h-3.5 text-accent" /> Run Analysis
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
        {activeTab === "birdseyeview" && (
          <div className="flex gap-3 pb-3">
            <button
              type="button"
              className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-border"
              onClick={() => loadHeatmap()}
            >
              <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh data
            </button>
          </div>
        )}
      </div>

      {/* ── YIELD TAB SUBTITLE ────────────────────────────────────────── */}
      {activeTab === "yield" && (
        <div className="text-xs tracking-wider text-text-muted mb-6 uppercase -mt-4">
          {stage === "idle"       && "Real-time calendar analytics"}
          {stage === "processing" && "Analyzing inventory topology"}
          {stage === "preview"    && "Optimization ready — review before commit"}
          {stage === "applied"    && "Optimization successfully integrated"}
          {stage === "converged"  && (convergedState === "clean"
            ? "Active inventory is fully consolidated — no orphan gaps detected"
            : "Orphan gaps detected — booking density prevents further rearrangement")}
        </div>
      )}

      {/* ── PRICING TAB ───────────────────────────────────────────────── */}
      {/* ── BIRD'S EYE TAB ───────────────────────────────────────────── */}
      {activeTab === "birdseyeview" && (
        <>
          <div className="text-xs tracking-wider text-text-muted mb-6 uppercase -mt-4">
            Occupancy matrix with bookable empty-night runs by length and room type
          </div>

          {heatmap && stage !== "processing" && birdseyeSnapshot && (
            <div className="flex flex-col lg:flex-row gap-6 items-stretch">
              <div className="w-full lg:w-[70%] lg:min-w-0 min-h-[320px]">
                <div className="bg-surface border border-border p-4 sm:p-6 h-full overflow-x-auto">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={heatmap.rows}
                    title="Current Occupancy"
                    compact
                    maxDays={birdseyeMaxDays}
                    hideLegend
                    onCellClick={setSlotModal}
                  />
                </div>
              </div>
              <aside className="w-full lg:w-[30%] lg:max-w-md lg:shrink-0 flex flex-col min-h-0">
                <BirdseyeInventoryHighlights snapshot={birdseyeSnapshot} maxDays={birdseyeMaxDays} />
              </aside>
            </div>
          )}

          {stage === "processing" && (
            <div className="bg-surface-2 border border-border p-10 mb-8 flex items-center justify-center">
              <div className="flex flex-col items-center max-w-sm text-center">
                <div className="w-10 h-10 border-2 border-border border-t-accent rounded-full animate-spin mb-6" />
                <h3 className="text-lg font-serif font-bold text-text">Yield analysis in progress</h3>
                <p className="text-xs text-text-muted mt-2 tracking-wide">
                  Switch back to Yield Operations to monitor the run, or wait for it to finish — the heatmap will refresh automatically.
                </p>
              </div>
            </div>
          )}

          {!heatmap && stage !== "processing" && (
            <div className="bg-surface border border-border py-16 px-6 text-center">
              <Grid3x3 className="w-8 h-8 text-accent/50 mx-auto mb-4" />
              <h2 className="text-xl font-serif font-bold text-text mb-2">No calendar data</h2>
              <p className="text-xs text-text-muted font-medium mb-6 max-w-sm mx-auto leading-relaxed">
                The occupancy matrix could not be loaded. Check the API connection, then try again.
              </p>
              <button
                type="button"
                className="bg-text text-surface font-semibold hover:bg-text/90 text-xs uppercase tracking-widest px-8 py-3"
                onClick={() => loadHeatmap()}
              >
                Retry load
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === "pricing" && (
        <div className="bg-surface border border-border min-h-[600px] flex flex-col relative">
          {stage !== "applied" && stage !== "converged" ? (
            /* ── LOCKED overlay ─────────────────────────────────────────── */
            <div className="flex-1 flex flex-col items-center justify-center py-24 text-center px-6">
              <div className="w-14 h-14 rounded-full border-2 border-border flex items-center justify-center mb-6">
                <Lock className="w-6 h-6 text-text-muted" />
              </div>
              <h3 className="font-serif font-bold text-xl text-text mb-3">
                Yield Optimization Required
              </h3>
              <p className="text-xs text-text-muted max-w-sm leading-relaxed mb-6">
                Run and commit the room arrangement plan first. Pricing reads
                category occupancy from the slot state — committing the yield plan
                settles the inventory picture before AI analyses demand.
              </p>
              <button
                className="text-xs uppercase tracking-widest font-bold border border-border px-6 py-3 hover:bg-surface-2 transition-colors text-text flex items-center gap-2"
                onClick={() => setActiveTab("yield")}
              >
                <Zap className="w-3.5 h-3.5 text-accent" /> Go to Yield Operations
              </button>
            </div>
          ) : (
            <PricingPanel />
          )}
        </div>
      )}

      {/* ── YIELD TAB ─────────────────────────────────────────────────── */}
      {activeTab === "yield" && <>

      {/* ── OPERATIONAL KPI CARDS ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        {[
          {
            label: "Orphan Gaps",
            value: currentMetrics?.orphanGaps ?? "—",
            sub: `${currentMetrics?.orphanNights ?? 0} nights trapped between bookings`,
            color: "border-occured text-occured",
          },
          {
            label: "Short Runs ≤3n",
            value: (currentMetrics?.dist.n1 ?? 0) + (currentMetrics?.dist.n2_3 ?? 0),
            sub: "1–3 night runs — difficult to sell",
            color: "border-occuorange text-occuorange",
          },
          {
            label: "Gaps Eliminated",
            value: projectedMetrics != null
              ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps
              : "—",
            sub: projectedMetrics != null
              ? `${(currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights} orphan nights freed`
              : "run analysis to project",
            color: "border-occugreen text-occugreen",
          },
          {
            label: "Long Runs 4n+",
            value: projectedMetrics != null
              ? projectedMetrics.dist.n4_7 + projectedMetrics.dist.n8p
              : (currentMetrics?.dist.n4_7 ?? 0) + (currentMetrics?.dist.n8p ?? 0),
            sub: projectedMetrics != null
              ? `after commit (was ${(currentMetrics?.dist.n4_7 ?? 0) + (currentMetrics?.dist.n8p ?? 0)})`
              : "bookable runs of 4+ nights",
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
            <h3 className="text-lg font-serif font-bold text-text">Analyzing Inventory Topology</h3>
            <p className="text-xs text-text-muted mt-2 tracking-wide">
              The HHI algorithm is identifying fragmented booking segments and computing optimal consolidation moves.
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
                <h3 className="font-serif font-bold text-lg text-text">Tactical Preview</h3>
                <span className="text-[10px] uppercase font-bold tracking-widest text-occuorange border border-occuorange/30 bg-occuorange/5 px-3 py-1">
                  Simulation
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
              <h3 className="font-serif font-bold text-xl text-text">Commit Resolution</h3>
              <div className="text-xs text-text-muted uppercase tracking-wider mt-1">
                {gaps.length} gap{gaps.length !== 1 ? "s" : ""} identified · {swapPlan.length} swap step{swapPlan.length !== 1 ? "s" : ""} required
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-text-muted uppercase tracking-widest">Gaps Eliminated</div>
              <div className="text-3xl font-serif font-bold text-occugreen">
                {projectedMetrics != null
                  ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps
                  : gaps.length}
              </div>
              {projectedMetrics != null && (
                <div className="text-xs text-text-muted mt-1">
                  +{(currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights} nights added to bookable runs
                </div>
              )}
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
              {loadingCommit ? "Committing to Database..." : "Authorize Strategy Sync"}
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
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-[0.15em]">Execution Confirmed</div>
            <div className="text-4xl font-serif font-bold text-occugreen mt-1">
              {appliedGains.gapsElim} gap{appliedGains.gapsElim !== 1 ? "s" : ""} eliminated
            </div>
            <div className="text-xs text-text-muted mt-2 font-medium">
              {appliedGains.nightsFreed} orphan nights consolidated · {appliedGains.shuffleCount} gap{appliedGains.shuffleCount !== 1 ? "s" : ""} resolved
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
            <div className="text-[10px] font-bold text-text uppercase tracking-[0.15em]">System Equilibrium</div>
            <div className="text-2xl font-serif font-bold text-text mt-1">
              {convergedState === "clean" ? "Inventory Fully Consolidated" : "Matrix Converged — Structural Limit"}
            </div>
            <div className="text-xs text-text-muted mt-2 max-w-md leading-relaxed">
              {convergedState === "clean"
                ? "Active inventory is fully consolidated. No orphan gaps detected. Standby for organic demand ingestion."
                : "Orphan gaps remain but cannot be resolved — booking density prevents further rearrangement. No moves available without guest interruption."}
            </div>
          </div>
          <Lock className={`w-12 h-12 opacity-20 ${convergedState === "clean" ? "text-occugreen" : "text-text"}`} />
        </div>
      )}

      {/* ── IDLE EMPTY STATE ──────────────────────────────────────────── */}
      {stage === "idle" && !heatmap && (
        <div className="bg-surface border border-border py-24 px-6 text-center">
          <Zap className="w-8 h-8 text-accent/50 mx-auto mb-6" />
          <h2 className="text-2xl font-serif font-bold text-text mb-2">Initialize System Scan</h2>
          <p className="text-xs text-text-muted font-medium mb-8 max-w-sm mx-auto leading-relaxed">
            Execute a full calendar sweep to identify fragmented inventory and compute consolidation moves.
          </p>
          <button
            className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 shadow-sm text-xs uppercase tracking-widest px-8 py-3.5 mx-auto block"
            onClick={runOptimization}
          >
            Execute Scan
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
          Vector Shift
        </span>
        <span className="text-xs text-text font-medium">
          Room {gap.room_id} · {gap.gap_length}n orphan gap · {gap.date_range}
        </span>
        <span className="ml-auto text-[10px] font-bold text-occugreen uppercase tracking-wider">
          {gap.gap_length}n freed
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
  { label: "1 night",    key: "n1",   desc: "Unfillable — near-certain vacancy",  positiveIsMore: false },
  { label: "2–3 nights", key: "n2_3", desc: "Short stays only — hard to book",    positiveIsMore: false },
  { label: "4–7 nights", key: "n4_7", desc: "Standard stay — bookable",           positiveIsMore: true  },
  { label: "8+ nights",  key: "n8p",  desc: "Long-stay inventory — high value",   positiveIsMore: true  },
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
          <h3 className="font-serif font-bold text-lg text-text">Consecutive Available Runs</h3>
          <p className="text-[10px] text-text-muted mt-0.5 uppercase tracking-widest font-bold">
            {showProjected ? "Current vs projected after commit" : "Current inventory topology — 20-day window"}
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
