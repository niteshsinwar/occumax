import { useMemo, useState } from "react";
import type { HeatmapResponse, HeatmapRow, RoomCategory, SwapStep } from "../../types";
import { HeatmapGrid } from "../Heatmap/HeatmapGrid";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { BirdseyeFilters, type BirdseyeWeekSpan } from "../BirdseyeFilters";
import { Info } from "lucide-react";

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
      if ((c as any)?.offer_type === "SANDWICH_ORPHAN") n += 1;
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

/**
 * Occupancy tab (hackathon): usable capacity KPIs + before/after preview + playbooks.
 */
export type OccupancyOptimizationTabProps = {
  heatmap: HeatmapResponse | null;
  weekSpan: BirdseyeWeekSpan;
  onWeekSpanChange: (v: BirdseyeWeekSpan) => void;
  availableCategories: RoomCategory[];
  selectedCategories: RoomCategory[];
  onToggleCategory: (c: RoomCategory) => void;

  /** Days visible in the current slice (weekSpan * 7 bounded by heatmap length). */
  spanDays: number;
  /** Slice of rows limited to selected categories (and potentially other filters). */
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
  runSandwichPlaybook: () => Promise<void>;
  commitSwapShuffle: () => Promise<void>;

  /** Optional k-night optimizer controls (advanced). */
  kNightNights: number;
  onKNightNightsChange: (n: number) => void;
  kNightLoading: boolean;
  kNightCommitLoading: boolean;
  kNightSwapPlan: SwapStep[] | null;
  runKNightPreview: () => Promise<void>;
  commitKNightShuffle: () => Promise<void>;
};

export function OccupancyOptimizationTab(props: OccupancyOptimizationTabProps) {
  const {
    heatmap,
    weekSpan,
    onWeekSpanChange,
    availableCategories,
    selectedCategories,
    onToggleCategory,
    spanDays,
    filteredRows,
    simulatedRows,
    swapPlan,
    swapCommitLoading,
    refreshAllData,
    runOptimisePreview,
    clearOptimisePreview,
    runSandwichPlaybook,
    commitSwapShuffle,
    kNightNights,
    onKNightNightsChange,
    kNightLoading,
    kNightCommitLoading,
    kNightSwapPlan,
    runKNightPreview,
    commitKNightShuffle,
  } = props;

  const [showAdvanced, setShowAdvanced] = useState(false);

  function KpiInfo({ label, text }: { label: string; text: string }) {
    return (
      <span className="inline-flex items-center" title={`${label}: ${text}`}>
        <Info className="w-3 h-3 text-text-muted/70 hover:text-text-muted" />
      </span>
    );
  }

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
    const minlosBlocks = computeMinLosOrphanNightBlocks(rowsInView, spanDays);
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
      hardToFill: run.dist.n1 + run.dist.n2_3,
      easyToSell: run.dist.n4_7 + run.dist.n8p,
      minlosBlocks,
      orphanNightOffers,
      k2,
      k3,
      k2After,
      k3After,
      topFrag: topFragmentedRooms(rowsInView, spanDays),
      runDist: run.dist,
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
    <div>
      <div className="mb-6 space-y-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs tracking-widest text-text-muted uppercase font-bold">Occupancy</div>
            <div className="font-serif font-bold text-2xl text-text">Capacity recovery workspace</div>
            <div className="text-[11px] text-text-muted mt-2 max-w-2xl leading-relaxed">
              Slice first (dates + room types), then run recovery actions and validate the impact in the grid.
            </div>
          </div>
          <button
            type="button"
            className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-border"
            onClick={() => refreshAllData()}
            title="Refresh heatmap data from the API"
          >
            <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh
          </button>
        </div>

        {/* Slice controls (match Dashboard flow) */}
        {heatmap && (
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <BirdseyeFilters
              weekSpan={weekSpan}
              onWeekSpanChange={onWeekSpanChange}
              availableCategories={availableCategories}
              selectedCategories={selectedCategories}
              onToggleCategory={onToggleCategory}
            />
          </div>
        )}

        {/* Primary actions (most used) */}
        <div className="bg-surface border border-border shadow-subtle p-3 sm:p-4">
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => runOptimisePreview()}
              disabled={!heatmap}
              title="Generate a room-rearrangement preview plan and projected deltas"
            >
              Preview Recovery Shuffle
            </button>
            <button
              type="button"
              className="bg-surface text-text font-semibold hover:bg-surface-2 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-border disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => runSandwichPlaybook()}
              disabled={!heatmap}
              title="Relaxes MinLOS on orphan-night gaps and refreshes offers"
            >
              Apply Orphan Night Offers
            </button>
            {swapPlan && swapPlan.length > 0 && (
              <button
                type="button"
                className="bg-occugreen text-white font-semibold hover:bg-occugreen/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-occugreen/40 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => commitSwapShuffle()}
                disabled={swapCommitLoading}
                title="Write the preview shuffle to the DB so the heatmap improves immediately"
              >
                {swapCommitLoading ? "Applying…" : <><CheckCircle2 className="w-3.5 h-3.5" /> Apply Recovery Shuffle ({swapPlan.length})</>}
              </button>
            )}
            {swapPlan && (
              <button
                type="button"
                className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
                onClick={() => clearOptimisePreview()}
                title="Clear the current preview plan"
              >
                Clear preview
              </button>
            )}
            <button
              type="button"
              className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
              onClick={() => setShowAdvanced(v => !v)}
              title="Show k-night optimisation tools"
            >
              Advanced {showAdvanced ? "▲" : "▼"}
            </button>
          </div>

          {showAdvanced && heatmap && (
            <div className="mt-3 pt-3 border-t border-border/60 flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">
                  k-night optimisation
                </div>
                <KpiInfo
                  label="k-night optimisation"
                  text="Rearranges existing SOFT bookings to maximize bookable windows of length k within the current slice."
                />
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
      </div>

      {kpis && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 gap-3">
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Tonight occupancy</div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">
              {kpis.tonightOccPct.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
            </div>
            <div className="text-[10px] text-text-muted">{kpis.tonightOccupied} / {kpis.totalRooms} rooms</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Nights at risk</div>
            <div className="text-2xl font-serif font-bold text-occuorange tabular-nums">{kpis.orphanNights}</div>
            <div className="text-[10px] text-text-muted">{kpis.orphanGaps} orphan gap(s)</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Hard to fill</div>
            <div className="text-2xl font-serif font-bold text-occuorange tabular-nums">{kpis.hardToFill}</div>
            <div className="text-[10px] text-text-muted">1–3 night gaps</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Easy to sell</div>
            <div className="text-2xl font-serif font-bold text-occugreen tabular-nums">{kpis.easyToSell}</div>
            <div className="text-[10px] text-text-muted">4+ night runs</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Usable k=2</div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">
              {kpis.k2}
              {kpis.k2After !== null && (
                <span className={`text-xs font-black ml-2 ${kpis.k2After - kpis.k2 > 0 ? "text-occugreen" : "text-text-muted"}`}>
                  {kpis.k2After - kpis.k2 > 0 ? `+${kpis.k2After - kpis.k2}` : "0"}
                </span>
              )}
            </div>
            <div className="text-[10px] text-text-muted">2-night windows</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">Usable k=3</div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">
              {kpis.k3}
              {kpis.k3After !== null && (
                <span className={`text-xs font-black ml-2 ${kpis.k3After - kpis.k3 > 0 ? "text-occugreen" : "text-text-muted"}`}>
                  {kpis.k3After - kpis.k3 > 0 ? `+${kpis.k3After - kpis.k3}` : "0"}
                </span>
              )}
            </div>
            <div className="text-[10px] text-text-muted">3-night windows</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">MinLOS blocks</div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">{kpis.minlosBlocks}</div>
            <div className="text-[10px] text-text-muted">{kpis.orphanNightOffers} orphan-night offer(s)</div>
          </div>
        </div>
      )}

      {kWindowBars && (
        <div className="mt-6 bg-surface border border-border p-6">
          <div className="flex items-center justify-between gap-3 mb-4 pb-3 border-b border-border/60">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold">Usable capacity</div>
              <div className="font-serif font-bold text-lg text-text">k-night windows (current vs projected)</div>
            </div>
            {simulatedRows && (
              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-4">
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-text/20 border border-border/60 inline-block" /> Current</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occugreen/50 border border-occugreen/30 inline-block" /> Projected</span>
              </div>
            )}
          </div>
          <div className="space-y-3">
            {kWindowBars.ks.map((kk, idx) => {
              const cur = kWindowBars.current[idx];
              const proj = kWindowBars.projected ? kWindowBars.projected[idx] : null;
              const pct = Math.max((cur / kWindowBars.maxVal) * 100, cur > 0 ? 5 : 0);
              const pctProj = proj !== null ? Math.max((proj / kWindowBars.maxVal) * 100, proj > 0 ? 5 : 0) : 0;
              return (
                <div key={kk} className="grid grid-cols-[56px_1fr] gap-3 items-center">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted text-right">k={kk}</div>
                  <div className="space-y-1.5">
                    <div className="h-6 bg-surface-2 border border-border/50 relative overflow-hidden">
                      <div className="h-full bg-text/20" style={{ width: `${pct}%` }} />
                      <div className="absolute left-2 top-0 h-full flex items-center text-[10px] font-bold text-text">{cur}</div>
                    </div>
                    {proj !== null && (
                      <div className="h-6 bg-occugreen/5 border border-occugreen/20 relative overflow-hidden">
                        <div className="h-full bg-occugreen/50" style={{ width: `${pctProj}%` }} />
                        <div className="absolute left-2 top-0 h-full flex items-center text-[10px] font-bold text-occugreen">{proj}</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main workspace: heatmap + operational panel */}
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
              rows={simulatedRows ?? rowsInView}
              maxDays={spanDays}
              highlightSandwichGaps
            />
          </div>

          <div className="space-y-6">
            {/* Operational run metrics */}
            {kpis && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-surface border border-border p-4 group hover:border-accent/40 transition-colors">
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-text-muted font-bold mb-1">
                    <span>Empty gaps</span>
                    <KpiInfo
                      label="Empty gaps"
                      text="Number of short EMPTY runs (≤5 nights) bounded by non-EMPTY nights on both sides within the same room row."
                    />
                  </div>
                  <div className="text-2xl font-serif font-bold text-text tabular-nums">{kpis.orphanGaps}</div>
                  <div className="text-[10px] text-text-muted mt-1">{kpis.orphanNights} orphan night{kpis.orphanNights === 1 ? "" : "s"} (≤ 5)</div>
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
                    {(kpis.runDist.n1 + kpis.runDist.n2_3).toLocaleString("en-US")}
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">1–3 night gaps</div>
                </div>
              </div>
            )}

            {/* Diagnostics */}
            {kpis && (
              <div className="bg-surface border border-border p-6">
                <div className="flex items-center justify-between gap-3 mb-4 pb-3 border-b border-border/60">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold">Diagnostics</div>
                    <div className="font-serif font-bold text-lg text-text">Where fragmentation lives</div>
                  </div>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-occuorange" /> Top offenders
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-xs text-text-muted">
                    Short gaps (1–3 nights) are the hardest to sell. These rooms have the most short gaps in the next {spanDays} nights.
                  </div>
                  <div className="space-y-2">
                    {kpis.topFrag.map(r => (
                      <div key={r.roomId} className="flex items-center justify-between border border-border bg-surface-2/30 px-3 py-2 text-xs">
                        <div className="font-mono font-bold text-text">Room {r.roomId}</div>
                        <div className="text-text-muted">{r.category}</div>
                        <div className="text-occuorange font-bold">{r.shortGaps} short gap(s)</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Optional: k-night window bars (current vs projected) */}
            {kWindowBars && (
              <div className="bg-surface border border-border p-6">
                <div className="flex items-center justify-between gap-3 mb-4 pb-3 border-b border-border/60">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold">Usable capacity</div>
                    <div className="font-serif font-bold text-lg text-text">k-night windows (current vs projected)</div>
                  </div>
                  {simulatedRows && (
                    <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-4">
                      <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-text/20 border border-border/60 inline-block" /> Current</span>
                      <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occugreen/50 border border-occugreen/30 inline-block" /> Projected</span>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  {kWindowBars.ks.map((kk, idx) => {
                    const cur = kWindowBars.current[idx];
                    const proj = kWindowBars.projected ? kWindowBars.projected[idx] : null;
                    const pct = Math.max((cur / kWindowBars.maxVal) * 100, cur > 0 ? 5 : 0);
                    const pctProj = proj !== null ? Math.max((proj / kWindowBars.maxVal) * 100, proj > 0 ? 5 : 0) : 0;
                    return (
                      <div key={kk} className="grid grid-cols-[56px_1fr] gap-3 items-center">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted text-right">k={kk}</div>
                        <div className="space-y-1.5">
                          <div className="h-6 bg-surface-2 border border-border/50 relative overflow-hidden">
                            <div className="h-full bg-text/20" style={{ width: `${pct}%` }} />
                            <div className="absolute left-2 top-0 h-full flex items-center text-[10px] font-bold text-text">{cur}</div>
                          </div>
                          {proj !== null && (
                            <div className="h-6 bg-occugreen/5 border border-occugreen/20 relative overflow-hidden">
                              <div className="h-full bg-occugreen/50" style={{ width: `${pctProj}%` }} />
                              <div className="absolute left-2 top-0 h-full flex items-center text-[10px] font-bold text-occugreen">{proj}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

