import { useMemo, useState } from "react";
import type { HeatmapResponse, HeatmapRow, SwapStep } from "../../types";
import { HeatmapGrid } from "../Heatmap/HeatmapGrid";
import { AlertTriangle, CheckCircle2, RefreshCw, Info } from "lucide-react";

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
      {/* ── Header + actions ───────────────────────────────────────────────────── */}
      <div className="mb-6 space-y-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs tracking-widest text-text-muted uppercase font-bold">Occupancy</div>
            <div className="font-serif font-bold text-2xl text-text">Capacity recovery workspace</div>
            <div className="text-[11px] text-text-muted mt-2 max-w-2xl leading-relaxed">
              Run recovery actions and validate the impact in the grid.
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

        <div className="bg-surface border border-border shadow-subtle p-3 sm:p-4">
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => runOptimisePreview()}
              disabled={!heatmap}
            >
              Preview Recovery Shuffle
            </button>
            {swapPlan && swapPlan.length > 0 && (
              <button
                type="button"
                className="bg-occugreen text-white font-semibold hover:bg-occugreen/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-occugreen/40 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => commitSwapShuffle()}
                disabled={swapCommitLoading}
              >
                {swapCommitLoading ? "Applying…" : <><CheckCircle2 className="w-3.5 h-3.5" /> Apply Shuffle ({swapPlan.length})</>}
              </button>
            )}
            {swapPlan && (
              <button
                type="button"
                className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
                onClick={() => clearOptimisePreview()}
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
                  type="number" min={1} max={14} value={kNightNights}
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

      {/* ── KPI strip ─────────────────────────────────────────────────────────── */}
      {kpis && (
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-4 gap-3 mb-6">
          <div className="bg-surface border border-border p-4">
            <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-1">Tonight occupancy</div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">
              {kpis.tonightOccPct.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
            </div>
            <div className="text-[10px] text-text-muted mt-0.5">{kpis.tonightOccupied} / {kpis.totalRooms} rooms</div>
          </div>
          <div className="bg-surface border border-border border-l-2 border-l-occuorange/60 p-4">
            <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-1">Orphan nights</div>
            <div className="text-2xl font-serif font-bold text-occuorange tabular-nums">{kpis.orphanNights}</div>
            <div className="text-[10px] text-text-muted mt-0.5">{kpis.orphanGaps} gap{kpis.orphanGaps !== 1 ? "s" : ""} · ≤5 nights each</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-1 flex items-center gap-1.5">
              k=2 windows
              {kpis.k2After !== null && kpis.k2After - kpis.k2 > 0 && (
                <span className="text-occugreen font-black">↑</span>
              )}
            </div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">
              {kpis.k2}
              {kpis.k2After !== null && kpis.k2After - kpis.k2 !== 0 && (
                <span className={`text-xs font-black ml-2 ${kpis.k2After - kpis.k2 > 0 ? "text-occugreen" : "text-text-muted"}`}>
                  {kpis.k2After - kpis.k2 > 0 ? `+${kpis.k2After - kpis.k2}` : kpis.k2After - kpis.k2}
                </span>
              )}
            </div>
            <div className="text-[10px] text-text-muted mt-0.5">2-night bookable windows</div>
          </div>
          <div className="bg-surface border border-border p-4">
            <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-1 flex items-center gap-1.5">
              k=3 windows
              {kpis.k3After !== null && kpis.k3After - kpis.k3 > 0 && (
                <span className="text-occugreen font-black">↑</span>
              )}
            </div>
            <div className="text-2xl font-serif font-bold text-text tabular-nums">
              {kpis.k3}
              {kpis.k3After !== null && kpis.k3After - kpis.k3 !== 0 && (
                <span className={`text-xs font-black ml-2 ${kpis.k3After - kpis.k3 > 0 ? "text-occugreen" : "text-text-muted"}`}>
                  {kpis.k3After - kpis.k3 > 0 ? `+${kpis.k3After - kpis.k3}` : kpis.k3After - kpis.k3}
                </span>
              )}
            </div>
            <div className="text-[10px] text-text-muted mt-0.5">3-night bookable windows</div>
          </div>
        </div>
      )}

      {/* ── Inventory Heatmap — flagship, full width ───────────────────────────── */}
      {heatmap && (
        <div className="bg-surface border border-border p-5 mb-4">
          <div className="mb-4 pb-3 border-b border-border/60 flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Inventory</div>
              <div className="font-serif font-bold text-xl text-text mt-0.5">Heatmap</div>
              <div className="text-[9px] text-text-muted mt-1 uppercase tracking-widest font-bold">
                {spanDays}-night window · orphan gaps outlined
              </div>
            </div>
            <div className="flex items-center gap-3">
              {simulatedRows && (
                <div className="text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 bg-occugreen/8 text-occugreen border border-occugreen/25">
                  Preview active
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-bold uppercase tracking-widest text-text-muted">
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occugreen/55 inline-block border border-occugreen/20" /> Guest</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-accent/40 inline-block border border-accent/20" /> Channel</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-text/20 inline-block border border-border" /> Blocked</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-surface-2 inline-block border border-border" /> Available</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occuorange/20 inline-block border border-occuorange/40" /> Orphan gap</span>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <HeatmapGrid
              dates={heatmap.dates}
              rows={simulatedRows ?? rowsInView}
              maxDays={spanDays}
              highlightSandwichGaps
            />
          </div>
        </div>
      )}

      {/* ── Analytics panels — below heatmap, 3-column ─────────────────────────── */}
      {heatmap && kpis && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Panel 1: Gap metrics */}
          <div className="bg-surface border border-border p-4">
            <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-3">Gap metrics</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-surface-2/60 border border-border p-3">
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Orphan gaps</div>
                <div className="text-xl font-serif font-bold text-text tabular-nums mt-1">{kpis.orphanGaps}</div>
                <div className="text-[10px] text-text-muted mt-0.5">{kpis.orphanNights} nights (≤5)</div>
              </div>
              <div className="bg-surface-2/60 border border-border p-3">
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Hard to fill</div>
                <div className="text-xl font-serif font-bold text-occuorange tabular-nums mt-1">{kpis.hardToFill}</div>
                <div className="text-[10px] text-text-muted mt-0.5">1–3 night gaps</div>
              </div>
              <div className="bg-surface-2/60 border border-border p-3">
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Easy to sell</div>
                <div className="text-xl font-serif font-bold text-occugreen tabular-nums mt-1">{kpis.easyToSell}</div>
                <div className="text-[10px] text-text-muted mt-0.5">4+ night runs</div>
              </div>
              <div className="bg-surface-2/60 border border-border p-3">
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">MinLOS blocks</div>
                <div className="text-xl font-serif font-bold text-text tabular-nums mt-1">{kpis.minlosBlocks}</div>
                <div className="text-[10px] text-text-muted mt-0.5">orphan-night locks</div>
              </div>
            </div>

            {/* Gap distribution inline */}
            <div className="mt-4 pt-3 border-t border-border/60">
              <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Distribution</div>
              {(() => {
                const bars = [
                  { label: "1-night",   count: kpis.runDist.n1,   color: "bg-occuorange",    note: "hardest to sell" },
                  { label: "2–3",       count: kpis.runDist.n2_3, color: "bg-occuorange/50", note: "hard to fill" },
                  { label: "4–7",       count: kpis.runDist.n4_7, color: "bg-text/25",       note: "convertible" },
                  { label: "8+",        count: kpis.runDist.n8p,  color: "bg-occugreen/45",  note: "easy to sell" },
                ];
                const maxCount = Math.max(...bars.map(b => b.count), 1);
                return (
                  <div className="space-y-1.5">
                    {bars.map(({ label, count, color, note }) => (
                      <div key={label} className="grid grid-cols-[40px_1fr_20px] gap-1.5 items-center">
                        <div className="text-[9px] font-bold text-text-muted text-right uppercase tracking-widest">{label}</div>
                        <div className="h-2.5 bg-surface-2 border border-border/40 overflow-hidden relative group">
                          <div className={`h-full ${color} transition-all`} style={{ width: `${count > 0 ? Math.max((count / maxCount) * 100, 5) : 0}%` }} />
                          <span className="absolute right-1 top-0 h-full hidden group-hover:flex items-center text-[8px] text-text-muted">{note}</span>
                        </div>
                        <div className="text-[10px] font-bold text-text tabular-nums">{count}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Panel 2: Top offenders */}
          <div className="bg-surface border border-border p-4">
            <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1 flex items-center gap-2">
              <AlertTriangle className="w-3 h-3 text-occuorange" /> Top offenders
            </div>
            <div className="text-[10px] text-text-muted mb-3">Rooms with most 1–3 night gaps</div>
            <div className="space-y-1.5">
              {kpis.topFrag.map(r => (
                <div key={r.roomId} className="flex items-center justify-between bg-surface-2/50 border border-border/50 px-3 py-2">
                  <div className="font-mono font-bold text-text text-xs">Room {r.roomId}</div>
                  <div className="text-text-muted text-[10px] uppercase tracking-widest">{r.category}</div>
                  <div className="text-occuorange font-bold text-xs">{r.shortGaps} gap{r.shortGaps !== 1 ? "s" : ""}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Panel 3: k-night windows */}
          {kWindowBars ? (
            <div className="bg-surface border border-border p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">k-night windows</div>
                {simulatedRows && (
                  <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-3">
                    <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-text/20 border border-border/60 inline-block" /> Now</span>
                    <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-occugreen/50 border border-occugreen/30 inline-block" /> After</span>
                  </div>
                )}
              </div>
              <div className="space-y-3">
                {kWindowBars.ks.map((kk, idx) => {
                  const cur = kWindowBars.current[idx]!;
                  const proj = kWindowBars.projected ? kWindowBars.projected[idx]! : null;
                  const pct = Math.max((cur / kWindowBars.maxVal) * 100, cur > 0 ? 5 : 0);
                  const pctProj = proj !== null ? Math.max((proj / kWindowBars.maxVal) * 100, proj > 0 ? 5 : 0) : 0;
                  return (
                    <div key={kk} className="grid grid-cols-[36px_1fr] gap-2 items-center">
                      <div className="text-[10px] font-bold text-text-muted text-right">k={kk}</div>
                      <div className="space-y-1">
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
          ) : (
            <div className="bg-surface border border-border p-4 flex items-center justify-center text-[10px] text-text-muted uppercase tracking-widest">
              No data
            </div>
          )}
        </div>
      )}
    </div>
  );
}

