import { useMemo, useState } from "react";
import type { HeatmapResponse, HeatmapRow, PredictOptimalLosResponse, SwapStep } from "../../types";
import { HeatmapGrid } from "../Heatmap/HeatmapGrid";
import { displayRoomLabel } from "../../utils/roomLabels";
import { AiTag } from "../shared/AiTag";
import { AlertTriangle, CheckCircle2, RefreshCw, Info, Sparkles, ChevronDown } from "lucide-react";
// Exogenous Demand Signals are rendered once at the top of the Overview page.

type RunMetrics = {
  orphanGaps: number;
  orphanNights: number;
  dist: { n1: number; n2_3: number; n4_7: number; n8p: number };
};

function computeRunMetrics(rows: HeatmapRow[], maxDays: number): RunMetrics {
  const runs: Array<{ length: number; isOrphan: boolean }> = [];
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    let i = 0;
    while (i < cells.length) {
      if (cells[i]?.block_type !== "EMPTY") { i++; continue; }
      const start = i;
      while (i < cells.length && cells[i]?.block_type === "EMPTY") i++;
      const length = i - start;
      const before = start > 0 ? cells[start - 1]?.block_type : null;
      const after = i < cells.length ? cells[i]?.block_type : null;
      const isOrphan =
        length <= 5 &&
        before !== null && before !== "EMPTY" &&
        after !== null && after !== "EMPTY";
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

function computeKNightWindows(rows: HeatmapRow[], maxDays: number, k: number): number {
  const kk = Math.max(1, Math.floor(k || 1));
  let total = 0;
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    let run = 0;
    for (const c of cells) {
      if (c?.block_type === "EMPTY") run += 1;
      else {
        if (run >= kk) total += (run - kk + 1);
        run = 0;
      }
    }
    if (run >= kk) total += (run - kk + 1);
  }
  return total;
}

function computeMinLosOrphanNightBlocks(rows: HeatmapRow[], maxDays: number): number {
  let blocked = 0;
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    for (let i = 1; i < cells.length - 1; i++) {
      const c = cells[i];
      if (!c || c.block_type !== "EMPTY") continue;
      const before = cells[i - 1];
      const after = cells[i + 1];
      if (!before || !after) continue;
      if (before.block_type === "EMPTY" || after.block_type === "EMPTY") continue;
      if (c.min_stay_active && c.min_stay_nights > 1) blocked += 1;
    }
  }
  return blocked;
}

function computeOrphanNightOfferCount(rows: HeatmapRow[], maxDays: number): number {
  let n = 0;
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    for (const c of cells) {
      if (c.offer_type === "SANDWICH_ORPHAN") n += 1;
    }
  }
  return n;
}

function topFragmentedRooms(rows: HeatmapRow[], maxDays: number): Array<{ roomId: string; category: string; shortGaps: number }> {
  const scored = rows.map(r => {
    const cells = r.cells.slice(0, maxDays);
    let shortGaps = 0;
    let i = 0;
    while (i < cells.length) {
      if (cells[i]?.block_type !== "EMPTY") { i++; continue; }
      const start = i;
      while (i < cells.length && cells[i]?.block_type === "EMPTY") i++;
      const len = i - start;
      if (len >= 1 && len <= 3) shortGaps += 1;
    }
    return { roomId: r.room_id, category: String(r.category), shortGaps };
  });
  return scored.sort((a, b) => b.shortGaps - a.shortGaps).slice(0, 5);
}

function KpiInfo({ label, text }: { label: string; text: string }) {
  return (
    <span className="inline-flex items-center" title={`${label}: ${text}`}>
      <Info className="w-3 h-3 text-text-muted/70 hover:text-text-muted" />
    </span>
  );
}

/**
 * Occupancy Overview subtab: predictive LOS banner, six mockup-style KPI cards, recovery actions,
 * before/after heatmaps (`optihost` palette), then k-window / offenders / distribution analytics.
 */
export type OccupancyOptimizationTabProps = {
  heatmap: HeatmapResponse | null;

  /** Days visible in the current heatmap window. */
  spanDays: number;
  /** All heatmap rows. */
  filteredRows: HeatmapRow[];
  /** Optional “projected” rows if a preview plan is active. */
  simulatedRows: HeatmapRow[] | null;

  /** Main preview shuffle plan + commit state. */
  swapPlan: SwapStep[] | null;
  swapCommitLoading: boolean;

  /** Actions are owned by the Dashboard (single source of truth). */
  refreshAllData: () => void;
  runOptimisePreview: () => Promise<void>;
  clearOptimisePreview: () => void;
  commitSwapShuffle: () => Promise<void>;

  /** Optional k-night optimizer controls (advanced). */
  kNightNights: number;
  onKNightNightsChange: (n: number) => void;
  kNightLoading: boolean;
  kNightCommitLoading: boolean;
  kNightSwapPlan: SwapStep[] | null;
  runKNightPreview: () => Promise<void>;
  commitKNightShuffle: () => Promise<void>;

  /** Occupancy pillar — predictive LOS layer + aligned shuffle preview (optional). */
  occupancyHeatmapDays?: number;
  predictiveLos?: PredictOptimalLosResponse | null;
  predictiveLosLoading?: boolean;
  predictiveLosError?: string | null;
  /** False until the first Poly AI insight fetch completes (gates Preview Recovery Shuffle when LOS preview is enabled). */
  predictiveLosReady?: boolean;
  onReloadPredictiveLos?: () => void;
  /** When set, “Preview Recovery Shuffle” maximizes k-night windows for Poly AI LOS instead of orphan-gap DFS preview. */
  runOccupancyRecoveryShufflePreview?: () => Promise<void>;
  /** Clears both orphan-gap preview and k-night preview for this workspace. */
  clearOccupancyRecoveryShufflePreview?: () => void;
};

export function OccupancyOptimizationTab(props: OccupancyOptimizationTabProps) {
  const {
    heatmap,
    spanDays,
    filteredRows,
    simulatedRows,
    swapPlan,
    swapCommitLoading,
    refreshAllData,
    runOptimisePreview,
    clearOptimisePreview,
    commitSwapShuffle,
    kNightNights,
    onKNightNightsChange,
    kNightLoading,
    kNightCommitLoading,
    kNightSwapPlan,
    runKNightPreview,
    commitKNightShuffle,
    occupancyHeatmapDays,
    predictiveLos,
    predictiveLosLoading,
    predictiveLosError,
    predictiveLosReady = true,
    onReloadPredictiveLos,
    runOccupancyRecoveryShufflePreview,
    clearOccupancyRecoveryShufflePreview,
  } = props;

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [insightDetailOpen, setInsightDetailOpen] = useState(false);
  const gridDays = Math.min(spanDays, occupancyHeatmapDays ?? spanDays);

  const rowsInView = useMemo(() => filteredRows, [filteredRows]);

  const kpis = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const tonightIdx = 0;
    const totalRooms = rowsInView.length;
    let tonightOccupied = 0;
    for (const r of rowsInView) {
      const c = r.cells[tonightIdx];
      if (c && c.block_type !== "EMPTY") tonightOccupied += 1;
    }
    const tonightOccPct = totalRooms > 0 ? (tonightOccupied / totalRooms) * 100 : 0;

    const run = computeRunMetrics(rowsInView, spanDays);
    const runAfter = simulatedRows ? computeRunMetrics(simulatedRows, spanDays) : null;
    const minlosBlocks = computeMinLosOrphanNightBlocks(rowsInView, spanDays);
    const minlosBlocksAfter = simulatedRows ? computeMinLosOrphanNightBlocks(simulatedRows, spanDays) : null;
    const orphanNightOffers = computeOrphanNightOfferCount(rowsInView, spanDays);

    const k2 = computeKNightWindows(rowsInView, spanDays, 2);
    const k3 = computeKNightWindows(rowsInView, spanDays, 3);
    const k2After = simulatedRows ? computeKNightWindows(simulatedRows, spanDays, 2) : null;
    const k3After = simulatedRows ? computeKNightWindows(simulatedRows, spanDays, 3) : null;

    return {
      tonightOccPct,
      tonightOccupied,
      totalRooms,
      orphanNights: run.orphanNights,
      orphanGaps: run.orphanGaps,
      orphanNightsAfter: runAfter?.orphanNights ?? null,
      orphanGapsAfter: runAfter?.orphanGaps ?? null,
      hardToFill: run.dist.n1 + run.dist.n2_3,
      hardToFillAfter: runAfter ? runAfter.dist.n1 + runAfter.dist.n2_3 : null,
      easyToSell: run.dist.n4_7 + run.dist.n8p,
      minlosBlocks,
      minlosBlocksAfter,
      orphanNightOffers,
      k2,
      k3,
      k2After,
      k3After,
      topFrag: topFragmentedRooms(rowsInView, spanDays),
      topFragAfter: simulatedRows ? topFragmentedRooms(simulatedRows, spanDays) : null,
      runDist: run.dist,
      runDistAfter: runAfter?.dist ?? null,
    };
  }, [heatmap, rowsInView, spanDays, simulatedRows]);

  const kWindowBars = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const ks = [1, 2, 3, 4];
    const current = ks.map(kk => computeKNightWindows(rowsInView, spanDays, kk));
    const projected = simulatedRows ? ks.map(kk => computeKNightWindows(simulatedRows, spanDays, kk)) : null;
    const maxVal = Math.max(...current, ...(projected ?? []), 1);
    return { ks, current, projected, maxVal };
  }, [heatmap, rowsInView, simulatedRows, spanDays]);

  return (
    <div className="space-y-8">
      {/* ── Title row ─────────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] tracking-[0.15em] text-text-muted uppercase font-bold">Occupancy</div>
          <h2 className="font-serif font-bold text-2xl text-text mt-1">Capacity recovery</h2>
          <p className="text-[11px] text-text-muted mt-2 max-w-2xl leading-relaxed">
            Align inventory healing with the AI LOS target, preview shuffles, then validate in the heatmap.
          </p>
        </div>
        <button
          type="button"
          className="bg-surface text-text font-semibold hover:bg-surface-2 active:scale-[0.99] transition-all flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] px-5 py-2.5 rounded-[10px] border border-border shadow-subtle"
          onClick={() => refreshAllData()}
          title="Refresh heatmap data from the API"
        >
          <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh
        </button>
      </div>

      {/* ── Predictive constraint layer (mockup: warm banner + refresh) ───────── */}
      {runOccupancyRecoveryShufflePreview && (
        <div
          className={`rounded-[12px] border px-5 py-5 sm:px-6 sm:py-6 shadow-[0_6px_24px_rgba(44,27,24,0.06)] ${
            predictiveLosLoading ? "bg-occuyellow-dim/80 border-occuyellow/35" : "bg-[#FDF7E6] border-[#e6d8b8]"
          }`}
        >
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5">
            <div className="flex items-start gap-4 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-occuyellow/15 border border-occuyellow/25 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-occuyellow" />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">
                  Predictive constraint layer
                  <AiTag
                    className="inline align-middle ml-2"
                    title="Poly AI uses DB-derived pace, on-books occupancy, booking LOS, and explicit current-event context. Refresh reloads the recommendation."
                  />
                </div>

                <div className="text-sm text-text leading-relaxed">
                  {predictiveLosLoading && (
                    <span className="text-text-muted">Computing optimal demand-aligned length of stay…</span>
                  )}
                  {!predictiveLosLoading && predictiveLosError && (
                    <span className="text-occured font-semibold">{predictiveLosError}</span>
                  )}
                  {!predictiveLosLoading && !predictiveLosError && !predictiveLos && (
                    <span className="text-text-muted">
                      Fetching Poly AI recommendation for this {occupancyHeatmapDays ?? gridDays}-night occupancy window…
                    </span>
                  )}
                  {!predictiveLosLoading && !predictiveLosError && predictiveLos && (
                    <>
                      <span className="font-bold text-text">
                        Recommended Length of Stay (LOS):{" "}
                        <span className="tabular-nums">{predictiveLos.recommended_los_nights}</span> night
                        {predictiveLos.recommended_los_nights !== 1 ? "s" : ""}
                      </span>{" "}
                      <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-text-muted">
                        (
                        {(() => {
                          const c = predictiveLos.confidence.toUpperCase();
                          if (c.includes("HIGH")) return "High";
                          if (c.includes("MEDIUM")) return "Medium";
                          if (c.includes("LOW")) return "Low";
                          return predictiveLos.confidence;
                        })()}{" "}
                        confidence)
                      </span>
                      <p className="mt-2 text-[13px] text-text-muted leading-relaxed">{predictiveLos.rationale}</p>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setInsightDetailOpen(v => !v)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold text-text/80 hover:text-text underline underline-offset-4 decoration-text/25"
                  aria-expanded={insightDetailOpen}
                >
                  Learn more
                  <ChevronDown className={`w-4 h-4 transition-transform ${insightDetailOpen ? "rotate-180" : ""}`} />
                </button>

                {insightDetailOpen && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-text-muted uppercase tracking-[0.12em] font-bold border border-[#e6d8b8] divide-y sm:divide-y-0 sm:divide-x divide-[#e6d8b8] rounded-[10px] overflow-hidden bg-surface/60">
                    <div className="px-3 py-3">
                      Past 2yr baseline
                      <div className="text-[9px] font-normal normal-case tracking-normal text-text-muted mt-1 leading-relaxed">
                        Pace vs same calendar windows (−1yr / −2yr) from analytics (hotel rollup).
                      </div>
                    </div>
                    <div className="px-3 py-3">
                      Current-event awareness
                      <div className="text-[9px] font-normal normal-case tracking-normal text-text-muted mt-1 leading-relaxed">
                        Event, travel, and market signals are passed as explicit context, separate from DB analytics.
                      </div>
                    </div>
                    <div className="px-3 py-3">
                      Current bookings
                      <div className="text-[9px] font-normal normal-case tracking-normal text-text-muted mt-1 leading-relaxed">
                        In-window LOS histogram and on-books occupancy inform the AI prior.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {onReloadPredictiveLos && (
              <button
                type="button"
                className="shrink-0 self-stretch lg:self-start bg-surface text-text font-bold hover:bg-surface-2 active:scale-[0.99] transition-all text-[10px] uppercase tracking-[0.15em] px-5 py-3 rounded-[10px] border border-border shadow-subtle disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => onReloadPredictiveLos()}
                disabled={predictiveLosLoading || !heatmap}
              >
                Refresh AI insight
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── KPI strip (mockup: six centered metric cards) ───────────────────── */}
      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <div className="rounded-[10px] bg-surface border border-border/80 shadow-[0_6px_20px_rgba(44,27,24,0.06)] px-4 py-5 text-center">
            <div className="text-[9px] uppercase tracking-[0.12em] text-text-muted font-bold leading-tight">
              Tonight occupancy
            </div>
            <div className="mt-2 text-2xl font-bold text-text tabular-nums tracking-tight">
              {kpis.tonightOccPct.toFixed(0)}
              <span className="text-lg font-semibold text-text-muted">%</span>
            </div>
            <div className="mt-1 text-[11px] text-text-muted">
              ({kpis.tonightOccupied}/{kpis.totalRooms} rooms)
            </div>
          </div>
          <div className="rounded-[10px] bg-surface border border-occuorange/25 shadow-[0_6px_20px_rgba(44,27,24,0.06)] px-4 py-5 text-center">
            <div className="text-[9px] uppercase tracking-[0.12em] text-text-muted font-bold leading-tight">
              Stranded nights
            </div>
            <div className="mt-2 text-2xl font-bold text-occuorange tabular-nums tracking-tight">{kpis.orphanNights}</div>
            <div className="mt-1 text-[11px] text-text-muted">
              ({kpis.orphanGaps} gap{kpis.orphanGaps !== 1 ? "s" : ""})
            </div>
            {kpis.orphanNightsAfter !== null && (
              <div className={`mt-2 text-[10px] font-bold tabular-nums ${kpis.orphanNightsAfter <= kpis.orphanNights ? "text-occugreen" : "text-occuorange"}`}>
                After {kpis.orphanNightsAfter} · {kpis.orphanNightsAfter - kpis.orphanNights}
              </div>
            )}
          </div>
          <div className="rounded-[10px] bg-surface border border-border/80 shadow-[0_6px_20px_rgba(44,27,24,0.06)] px-4 py-5 text-center">
            <div className="text-[9px] uppercase tracking-[0.12em] text-text-muted font-bold leading-tight flex items-center justify-center gap-1">
              k=2 windows
              {kpis.k2After !== null && kpis.k2After - kpis.k2 > 0 && (
                <span className="text-occugreen font-black">↑</span>
              )}
            </div>
            <div className="mt-2 text-2xl font-bold text-text tabular-nums tracking-tight">
              {kpis.k2}
              {kpis.k2After !== null && kpis.k2After - kpis.k2 !== 0 && (
                <span className={`text-xs font-black ml-1 ${kpis.k2After - kpis.k2 > 0 ? "text-occugreen" : "text-text-muted"}`}>
                  {kpis.k2After - kpis.k2 > 0 ? `+${kpis.k2After - kpis.k2}` : kpis.k2After - kpis.k2}
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-text-muted">(2-night bookable)</div>
          </div>
          <div className="rounded-[10px] bg-surface border border-border/80 shadow-[0_6px_20px_rgba(44,27,24,0.06)] px-4 py-5 text-center">
            <div className="text-[9px] uppercase tracking-[0.12em] text-text-muted font-bold leading-tight flex items-center justify-center gap-1">
              k=3 windows
              {kpis.k3After !== null && kpis.k3After - kpis.k3 > 0 && (
                <span className="text-occugreen font-black">↑</span>
              )}
            </div>
            <div className="mt-2 text-2xl font-bold text-text tabular-nums tracking-tight">
              {kpis.k3}
              {kpis.k3After !== null && kpis.k3After - kpis.k3 !== 0 && (
                <span className={`text-xs font-black ml-1 ${kpis.k3After - kpis.k3 > 0 ? "text-occugreen" : "text-text-muted"}`}>
                  {kpis.k3After - kpis.k3 > 0 ? `+${kpis.k3After - kpis.k3}` : kpis.k3After - kpis.k3}
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-text-muted">(3-night bookable)</div>
          </div>
          <div className="rounded-[10px] bg-surface border border-border/80 shadow-[0_6px_20px_rgba(44,27,24,0.06)] px-4 py-5 text-center">
            <div className="text-[9px] uppercase tracking-[0.12em] text-text-muted font-bold leading-tight">
              Hard to fill
            </div>
            <div className="mt-2 text-2xl font-bold text-occuorange tabular-nums tracking-tight">{kpis.hardToFill}</div>
            <div className="mt-1 text-[11px] text-text-muted">(1–3 night gaps)</div>
            {kpis.hardToFillAfter !== null && (
              <div className={`mt-2 text-[10px] font-bold tabular-nums ${kpis.hardToFillAfter <= kpis.hardToFill ? "text-occugreen" : "text-occuorange"}`}>
                After {kpis.hardToFillAfter} · {kpis.hardToFillAfter - kpis.hardToFill}
              </div>
            )}
          </div>
          <div className="rounded-[10px] bg-surface border border-border/80 shadow-[0_6px_20px_rgba(44,27,24,0.06)] px-4 py-5 text-center">
            <div className="text-[9px] uppercase tracking-[0.12em] text-text-muted font-bold leading-tight">
              MinLOS blocks
            </div>
            <div className="mt-2 text-2xl font-bold text-text tabular-nums tracking-tight">{kpis.minlosBlocks}</div>
            <div className="mt-1 text-[11px] text-text-muted">(orphan-night locks)</div>
            {kpis.minlosBlocksAfter !== null && kpis.minlosBlocksAfter !== kpis.minlosBlocks && (
              <div className="mt-2 text-[10px] font-bold text-occugreen tabular-nums">
                After {kpis.minlosBlocksAfter} · {kpis.minlosBlocksAfter - kpis.minlosBlocks}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Recovery actions (after KPIs, before heatmaps) ─────────────────────── */}
      <div className="rounded-[12px] bg-surface border border-border shadow-subtle p-4 sm:p-5">
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={() =>
              runOccupancyRecoveryShufflePreview ? void runOccupancyRecoveryShufflePreview() : void runOptimisePreview()
            }
            disabled={
              !heatmap ||
              !!predictiveLosLoading ||
              !!kNightLoading ||
              (!!runOccupancyRecoveryShufflePreview && !predictiveLosReady)
            }
          >
            {kNightLoading ? "Previewing…" : "Preview Recovery Shuffle"}
          </button>
          {(kNightSwapPlan?.length ?? 0) > 0 && (
            <button
              type="button"
              className="bg-occugreen text-white font-semibold hover:bg-occugreen/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-occugreen/40 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => commitKNightShuffle()}
              disabled={kNightCommitLoading}
            >
              {kNightCommitLoading ? "Applying…" : <><CheckCircle2 className="w-3.5 h-3.5" /> Apply Shuffle ({kNightSwapPlan!.length})</>}
            </button>
          )}
          {(kNightSwapPlan?.length ?? 0) === 0 && swapPlan && swapPlan.length > 0 && (
            <button
              type="button"
              className="bg-occugreen text-white font-semibold hover:bg-occugreen/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-occugreen/40 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => commitSwapShuffle()}
              disabled={swapCommitLoading}
            >
              {swapCommitLoading ? "Applying…" : <><CheckCircle2 className="w-3.5 h-3.5" /> Apply Shuffle ({swapPlan.length})</>}
            </button>
          )}
          {(swapPlan || (kNightSwapPlan?.length ?? 0) > 0) && (
            <button
              type="button"
              className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
              onClick={() =>
                clearOccupancyRecoveryShufflePreview ? clearOccupancyRecoveryShufflePreview() : clearOptimisePreview()
              }
            >
              Clear preview
            </button>
          )}
          <button
            type="button"
            className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
            onClick={() => setShowAdvanced(v => !v)}
          >
            Advanced {showAdvanced ? "▲" : "▼"}
          </button>
        </div>

        {showAdvanced && heatmap && (
          <div className="mt-3 pt-3 border-t border-border/60 flex flex-col sm:flex-row sm:items-end gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">k-night optimisation</div>
              <KpiInfo label="k-night optimisation" text="Rearranges existing SOFT bookings to maximize bookable windows of length k within the current slice." />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <input
                type="number"
                min={1}
                max={14}
                value={kNightNights}
                onChange={e => onKNightNightsChange(Math.max(1, Math.min(14, parseInt(e.target.value) || 1)))}
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

      {/* ── Full-width heatmap; analytics band below ───────────────────────────── */}
      {heatmap && (
        <div className="w-full max-w-none space-y-6">
          <div className="min-w-0 w-full space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
              <div>
                <h3 className="font-serif font-bold text-xl text-text tracking-tight">Inventory Heatmap</h3>
                <p className="text-[10px] text-text-muted mt-1 uppercase tracking-[0.12em] font-bold">
                  {gridDays}-night window · sandwich orphan gaps ringed
                  {occupancyHeatmapDays ? ` · ${occupancyHeatmapDays} columns` : ""}
                </p>
              </div>
              {simulatedRows && (
                <div className="text-[9px] font-bold uppercase tracking-[0.15em] px-3 py-1.5 rounded-full bg-occugreen/10 text-occugreen border border-occugreen/25 shrink-0">
                  Preview active
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 w-full min-w-0">
              <div className="min-w-0 rounded-[12px] bg-surface border border-border/80 shadow-[0_8px_28px_rgba(44,27,24,0.08)] p-4 sm:p-5 lg:min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-text mb-4">
                  Before (live slice)
                </div>
                <HeatmapGrid
                  dates={heatmap.dates}
                  rows={rowsInView}
                  maxDays={gridDays}
                  highlightSandwichGaps
                  hideLegend
                  palette="optihost"
                />
              </div>
              <div className="min-w-0 rounded-[12px] bg-surface border border-border/80 shadow-[0_8px_28px_rgba(44,27,24,0.08)] p-4 sm:p-5 lg:min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-text mb-4">
                  After (preview)
                </div>
                <HeatmapGrid
                  dates={heatmap.dates}
                  rows={simulatedRows ?? rowsInView}
                  maxDays={gridDays}
                  highlightSandwichGaps
                  hideLegend
                  palette="optihost"
                />
                {!simulatedRows && (
                  <div className="mt-3 text-[11px] text-text-muted">
                    Matches live until you run <span className="font-semibold text-text">Preview Recovery Shuffle</span>.
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[9px] font-bold uppercase tracking-[0.12em] text-text-muted pt-2">
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-md bg-[#e6d28c] border border-black/10 shadow-sm shrink-0" /> Guest
              </span>
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-md bg-[#7a9fbc] border border-black/10 shadow-sm shrink-0" /> Channel
              </span>
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-md bg-[#d4a574] border border-black/10 shadow-sm shrink-0" /> Blocked
              </span>
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-md bg-[#c8e6d4] border border-black/10 shadow-sm shrink-0" /> Available
              </span>
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-md bg-[#c8e6d4] border-2 border-occuorange/60 shadow-sm shrink-0" /> Orphan gap
              </span>
            </div>
          </div>

          {/* Bottom band: k-night windows · top offenders · distribution (horizontal on lg+) */}
          {kpis && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch w-full">
              {kWindowBars && (
                <div className="bg-surface border border-border p-5 min-w-0 flex flex-col">
                  <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">k-night windows</div>
                    {simulatedRows && (
                      <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-3 shrink-0">
                        <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-text/20 border border-border/60 inline-block" /> Now</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occugreen/50 border border-occugreen/30 inline-block" /> After</span>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 flex-1">
                    {kWindowBars.ks.map((kk, idx) => {
                      const cur = kWindowBars.current[idx]!;
                      const proj = kWindowBars.projected ? kWindowBars.projected[idx]! : null;
                      const pct = Math.max((cur / kWindowBars.maxVal) * 100, cur > 0 ? 5 : 0);
                      const pctProj = proj !== null ? Math.max((proj / kWindowBars.maxVal) * 100, proj > 0 ? 5 : 0) : 0;
                      return (
                        <div key={kk} className="grid grid-cols-[36px_1fr] gap-2 items-center">
                          <div className="text-[10px] font-bold text-text-muted text-right">k={kk}</div>
                          <div className="space-y-1 min-w-0">
                            <div className="h-5 bg-surface-2 border border-border/50 relative overflow-hidden">
                              <div className="h-full bg-text/20" style={{ width: `${pct}%` }} />
                              <div className="absolute left-2 top-0 h-full flex items-center text-[9px] font-bold text-text">{cur}</div>
                            </div>
                            {proj !== null && (
                              <div className="h-5 bg-occugreen/5 border border-occugreen/20 relative overflow-hidden">
                                <div className="h-full bg-occugreen/50" style={{ width: `${pctProj}%` }} />
                                <div className="absolute left-2 top-0 h-full flex items-center text-[9px] font-bold text-occugreen">{proj}</div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="bg-surface border border-border p-5 min-w-0 flex flex-col">
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1 flex items-center gap-2 shrink-0">
                  <AlertTriangle className="w-3 h-3 text-occuorange" /> Top offenders
                </div>
                <div className="text-[10px] text-text-muted mb-3 shrink-0">
                  Rooms with most 1–3 night gaps{kpis.topFragAfter ? " after preview" : ""}
                </div>
                <div className="space-y-1.5 flex-1">
                  {(kpis.topFragAfter ?? kpis.topFrag).map(r => (
                    <div key={r.roomId} className="flex items-center justify-between gap-2 bg-surface-2/50 border border-border/50 px-3 py-2">
                      <div className="font-mono font-bold text-text text-xs truncate" title={`Room ID: ${r.roomId}`}>
                        Room {displayRoomLabel(r.roomId, r.category, heatmap?.rows)}
                      </div>
                      <div className="text-text-muted text-[10px] uppercase tracking-widest shrink-0">{r.category}</div>
                      <div className="text-occuorange font-bold text-xs shrink-0">{r.shortGaps} gap{r.shortGaps !== 1 ? "s" : ""}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-surface border border-border p-5 min-w-0 flex flex-col">
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-3 shrink-0">Distribution</div>
                {(() => {
                  const bars = [
                    { label: "1-night",   count: kpis.runDist.n1,   color: "bg-occuorange",    note: "hardest to sell" },
                    { label: "2–3 night", count: kpis.runDist.n2_3, color: "bg-occuorange/50", note: "hard to fill" },
                    { label: "4–7 night", count: kpis.runDist.n4_7, color: "bg-text/25",       note: "convertible" },
                    { label: "8+ night",  count: kpis.runDist.n8p,  color: "bg-occugreen/45",  note: "easy to sell" },
                  ];
                  const maxCount = Math.max(...bars.map(b => b.count), 1);
                  return (
                    <div className="space-y-2 flex-1">
                    {bars.map(({ label, count, color, note }) => {
                      const afterCount = kpis.runDistAfter
                        ? label === "1-night"
                          ? kpis.runDistAfter.n1
                          : label === "2–3 night"
                            ? kpis.runDistAfter.n2_3
                            : label === "4–7 night"
                              ? kpis.runDistAfter.n4_7
                              : kpis.runDistAfter.n8p
                        : null;
                      return (
                        <div key={label} className="grid grid-cols-[52px_1fr_52px] gap-2 items-center">
                          <div className="text-[9px] font-bold text-text-muted text-right uppercase tracking-widest">{label}</div>
                          <div className="h-3 bg-surface-2 border border-border/40 overflow-hidden relative group min-w-0">
                            <div className={`h-full ${color} transition-all`} style={{ width: `${count > 0 ? Math.max((count / maxCount) * 100, 5) : 0}%` }} />
                            <span className="absolute right-1 top-0 h-full hidden group-hover:flex items-center text-[8px] text-text-muted">{note}</span>
                          </div>
                          <div className="text-[10px] font-bold text-text tabular-nums">
                            {afterCount !== null ? `${count}→${afterCount}` : count}
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
