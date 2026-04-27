import { useCallback, useEffect, useMemo, useState } from "react";
import { dashboardCommitShuffle, dashboardOptimiseKNightPreview, dashboardSandwichPlaybook, getHeatmap } from "../../api/client";
import type { HeatmapResponse, HeatmapRow, RoomCategory, SwapStep } from "../../types";
import { HeatmapGrid } from "../Heatmap/HeatmapGrid";
import { useToast } from "../shared/Toast";
import { simulateRows } from "../../utils/simulateRows";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { addDays, formatISO, parseISO } from "date-fns";

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
export function OccupancyOptimizationTab() {
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [k, setK] = useState<number>(2);
  const [kSwapPlan, setKSwapPlan] = useState<SwapStep[] | null>(null);
  const [kLoading, setKLoading] = useState(false);
  const [kCommitLoading, setKCommitLoading] = useState(false);
  const [sandwichLoading, setSandwichLoading] = useState(false);

  const { show, Toasts } = useToast();

  const loadHeatmap = useCallback(async () => {
    try {
      const h = await getHeatmap();
      setHeatmap(h.data);
    } catch {
      show("Failed to load heatmap", "error");
    }
  }, [show]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  const maxDays = 20;

  const rowsInView = useMemo(() => (heatmap ? heatmap.rows : []), [heatmap]);
  const spanDays = useMemo(() => Math.min(maxDays, heatmap?.dates.length ?? 0), [heatmap]);

  const simulatedRows = useMemo(() => {
    if (!heatmap || !kSwapPlan || kSwapPlan.length === 0) return null;
    return simulateRows(heatmap.rows, kSwapPlan);
  }, [heatmap, kSwapPlan]);

  const kpis = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const tonightIdx = 0;
    const totalRooms = heatmap.rows.length;
    let tonightOccupied = 0;
    for (const r of heatmap.rows) {
      const c = r.cells[tonightIdx];
      if (c && c.block_type !== "EMPTY") tonightOccupied += 1;
    }
    const tonightOccPct = totalRooms > 0 ? (tonightOccupied / totalRooms) * 100 : 0;

    const run = computeRunMetrics(heatmap.rows, spanDays);
    const minlosBlocks = computeMinLosOrphanNightBlocks(heatmap.rows, spanDays);
    const orphanNightOffers = computeOrphanNightOfferCount(heatmap.rows, spanDays);

    const k2 = computeKNightWindows(heatmap.rows, spanDays, 2);
    const k3 = computeKNightWindows(heatmap.rows, spanDays, 3);
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
      topFrag: topFragmentedRooms(heatmap.rows, spanDays),
      runDist: run.dist,
    };
  }, [heatmap, spanDays, simulatedRows]);

  const kWindowBars = useMemo(() => {
    if (!heatmap || spanDays === 0) return null;
    const ks = [1, 2, 3, 4];
    const current = ks.map(kk => computeKNightWindows(rowsInView, spanDays, kk));
    const projected = simulatedRows ? ks.map(kk => computeKNightWindows(simulatedRows, spanDays, kk)) : null;
    const maxVal = Math.max(...current, ...(projected ?? []), 1);
    return { ks, current, projected, maxVal };
  }, [heatmap, rowsInView, simulatedRows, spanDays]);

  const previewK = useCallback(async () => {
    if (!heatmap) return;
    setKLoading(true);
    setKSwapPlan(null);
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, spanDays);
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const targetNights = Math.max(1, Math.min(14, Math.floor(k || 1)));
      const categories: RoomCategory[] = Array.from(new Set(heatmap.rows.map(r => r.category)));
      const res = await dashboardOptimiseKNightPreview({
        start: startStr,
        end: endStr,
        categories,
        target_nights: targetNights,
      });
      const body = res.data as { shuffle_count: number; swap_plan: SwapStep[]; target_nights: number };
      setKSwapPlan(body.swap_plan ?? []);
      if ((body.swap_plan?.length ?? 0) === 0) show(`No k-night improvements found for k=${body.target_nights} in this slice.`, "info");
      else show(`Preview ready (k=${body.target_nights}): ${body.shuffle_count} shuffle steps`, "success");
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { detail?: string; error?: string } } };
      const detail = e?.response?.data?.detail ?? e?.response?.data?.error;
      const status = e?.response?.status;
      show(typeof detail === "string" ? `k-night preview failed (${status ?? "?"}): ${detail}` : `k-night preview failed (${status ?? "?"})`, "error");
      setKSwapPlan(null);
    } finally {
      setKLoading(false);
    }
  }, [heatmap, k, show, spanDays]);

  const commitK = useCallback(async () => {
    if (!kSwapPlan || kSwapPlan.length === 0) return;
    setKCommitLoading(true);
    try {
      await dashboardCommitShuffle(kSwapPlan);
      show(`Committed ${kSwapPlan.length} shuffle step(s)`, "success");
      setKSwapPlan(null);
      await loadHeatmap();
    } catch {
      show("Commit failed", "error");
    } finally {
      setKCommitLoading(false);
    }
  }, [kSwapPlan, loadHeatmap, show]);

  const applySandwich = useCallback(async () => {
    if (!heatmap) return;
    setSandwichLoading(true);
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, spanDays);
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const categories: RoomCategory[] = Array.from(new Set(heatmap.rows.map(r => r.category)));
      const res = await dashboardSandwichPlaybook({ start: startStr, end: endStr, categories });
      const body = res.data as { orphan_slots_found: number; slots_updated: number };
      if (body.slots_updated > 0) show(`Updated orphan-night offers on ${body.slots_updated} slot(s)`, "success");
      else if (body.orphan_slots_found > 0) show("Orphan nights found, but no changes were needed.", "info");
      else show("No orphan-night gaps found in this slice.", "info");
      await loadHeatmap();
    } catch {
      show("Orphan-night playbook failed", "error");
    } finally {
      setSandwichLoading(false);
    }
  }, [heatmap, loadHeatmap, show, spanDays]);

  return (
    <div>
      <Toasts />

      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <div className="text-xs tracking-widest text-text-muted uppercase font-bold">Occupancy</div>
          <div className="font-serif font-bold text-2xl text-text">Usable capacity & fragmentation</div>
        </div>
        <button
          type="button"
          className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-border"
          onClick={() => loadHeatmap()}
        >
          <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh
        </button>
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

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border p-6">
          <div className="flex items-start justify-between gap-3 mb-4 pb-3 border-b border-border/60">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold">Playbooks</div>
              <div className="font-serif font-bold text-lg text-text">Auto-recombine fragmented slots</div>
            </div>
            <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-accent" /> Hackathon MVP
            </div>
          </div>

          <div className="space-y-4">
            <div className="border border-border bg-surface-2/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Orphan-night offers</div>
                  <div className="text-xs text-text-muted mt-1">
                    Relaxes MinLOS to 1 and applies a <span className="font-bold text-text">50% offer</span> on trapped single nights (shows instantly in the grid).
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => applySandwich()}
                  disabled={sandwichLoading}
                  className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-text disabled:opacity-60"
                >
                  {sandwichLoading ? "Applying…" : "Apply"}
                </button>
              </div>
            </div>

            <div className="border border-border bg-surface-2/30 p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">k-night window optimiser</div>
                  <div className="text-xs text-text-muted mt-1">
                    Rearranges existing SOFT bookings to maximize the number of bookable <span className="font-bold text-text">k-night stays</span> in this slice.
                  </div>
                </div>
                <div className="flex items-end gap-2 shrink-0">
                  <div className="space-y-1">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">k</div>
                    <input
                      type="number"
                      min={1}
                      max={14}
                      value={k}
                      onChange={e => setK(Math.max(1, Math.min(14, parseInt(e.target.value) || 1)))}
                      className="w-20 bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => previewK()}
                    disabled={kLoading}
                    className="bg-surface border border-border text-text font-semibold hover:bg-surface-2 active:scale-95 transition-all text-xs uppercase tracking-widest px-4 py-2.5 disabled:opacity-60"
                  >
                    {kLoading ? "Previewing…" : "Preview"}
                  </button>
                  {kSwapPlan && kSwapPlan.length > 0 && (
                    <button
                      type="button"
                      onClick={() => commitK()}
                      disabled={kCommitLoading}
                      className="bg-occugreen text-white font-semibold hover:bg-occugreen/90 active:scale-95 transition-all text-xs uppercase tracking-widest px-4 py-2.5 disabled:opacity-60 flex items-center gap-2"
                    >
                      {kCommitLoading ? "Committing…" : <><CheckCircle2 className="w-3.5 h-3.5" /> Commit ({kSwapPlan.length})</>}
                    </button>
                  )}
                </div>
              </div>
              {kSwapPlan && (
                <div className="mt-3 text-[10px] uppercase tracking-widest font-bold text-text-muted flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5 text-occugreen" />
                  {kSwapPlan.length > 0 ? `${kSwapPlan.length} shuffle step(s) ready` : "No shuffle steps found"}
                </div>
              )}
            </div>
          </div>
        </div>

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

          {kpis && (
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
          )}
        </div>
      </div>

      {heatmap && (
        <div className="mt-6 bg-surface border border-border p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-text-muted font-bold">Inventory matrix</div>
              <div className="font-serif font-bold text-lg text-text">Current vs projected</div>
            </div>
            {kSwapPlan && kSwapPlan.length > 0 && (
              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">
                Showing projected using preview plan (not committed)
              </div>
            )}
          </div>

          {kSwapPlan && kSwapPlan.length > 0 && simulatedRows ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-px bg-border p-[1px]">
              <div className="bg-surface p-4">
                <HeatmapGrid dates={heatmap.dates} rows={heatmap.rows} title="Current" compact maxDays={spanDays} hideLegend />
              </div>
              <div className="bg-surface p-4">
                <HeatmapGrid dates={heatmap.dates} rows={simulatedRows} title="Projected" compact maxDays={spanDays} />
              </div>
            </div>
          ) : (
            <HeatmapGrid dates={heatmap.dates} rows={heatmap.rows} maxDays={spanDays} />
          )}
        </div>
      )}
    </div>
  );
}

