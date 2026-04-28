import { useCallback, useEffect, useMemo, useState } from "react";
import { analysePricing, commitPricing, dashboardSandwichPlaybook, getHeatmap } from "../../api/client";
import type {
  HeatmapResponse,
  HeatmapRow,
  PricingAnalyseResponse,
  PricingCommitItem,
  PricingRecommendation,
  PricingWhatIfScenario,
  RoomCategory,
} from "../../types";
import { useToast } from "../shared/Toast";
import {
  CheckCircle2,
  DollarSign,
  Loader2,
  RefreshCw,
  Sparkles,
  Tags,
  TrendingDown,
  TrendingUp,
  Wand2,
  XCircle,
} from "lucide-react";
import { addDays, formatISO, parseISO } from "date-fns";
import { AiTag } from "../shared/AiTag";

/**
 * Pricing Insights and Optimization tab.
 * Hackathon focus: tie pricing actions to fragmentation + usable capacity recovery.
 */
export function PricingOptimizationTab() {
  const { show, Toasts } = useToast();

  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [pricing, setPricing] = useState<PricingAnalyseResponse | null>(null);
  const [loadingHeatmap, setLoadingHeatmap] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<{ updated: number; skipped: number } | null>(null);

  const [spanDays, setSpanDays] = useState(14);
  const [selectedCategories, setSelectedCategories] = useState<RoomCategory[]>([]);

  type Decision = "accepted" | "rejected" | "override" | null;
  type RowState = { decision: Decision; overrideValue: string };
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const refreshHeatmap = useCallback(async () => {
    setLoadingHeatmap(true);
    try {
      const res = await getHeatmap();
      const data = res.data as HeatmapResponse;
      setHeatmap(data);
      const cats = [...new Set(data.rows.map(r => r.category))] as RoomCategory[];
      if (selectedCategories.length === 0) setSelectedCategories(cats);
    } catch {
      show("Failed to load heatmap", "error");
    } finally {
      setLoadingHeatmap(false);
    }
  }, [selectedCategories.length, show]);

  useEffect(() => {
    void refreshHeatmap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableCategories = useMemo(() => {
    if (!heatmap) return [] as RoomCategory[];
    return [...new Set(heatmap.rows.map(r => r.category))].sort() as RoomCategory[];
  }, [heatmap]);

  const activeRows = useMemo(() => {
    if (!heatmap) return [] as HeatmapRow[];
    const cats = new Set(selectedCategories);
    return heatmap.rows.filter(r => cats.has(r.category));
  }, [heatmap, selectedCategories]);

  const maxDays = useMemo(() => Math.max(1, Math.min(60, Math.floor(spanDays || 14))), [spanDays]);

  function computeMinLosOrphanNightBlocks(rowsIn: HeatmapRow[], maxDaysIn: number): number {
    let blocked = 0;
    for (const row of rowsIn) {
      const cells = row.cells.slice(0, maxDaysIn);
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

  function computeOrphanNightOfferCount(rowsIn: HeatmapRow[], maxDaysIn: number): number {
    let n = 0;
    for (const row of rowsIn) {
      for (const c of row.cells.slice(0, maxDaysIn)) {
        if (c.offer_type === "SANDWICH_ORPHAN") n += 1;
      }
    }
    return n;
  }

  function computeStrandedDateCategoryScores(rowsIn: HeatmapRow[], maxDaysIn: number): Map<string, number> {
    // key = `${category}::${date}` value = count of rooms with stranded night(s)
    const map = new Map<string, number>();
    const bump = (category: string, date: string) => {
      const key = `${category}::${date}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    };

    for (const row of rowsIn) {
      const cells = row.cells.slice(0, maxDaysIn);
      let i = 0;
      while (i < cells.length) {
        if (cells[i]?.block_type !== "EMPTY") { i++; continue; }
        const start = i;
        while (i < cells.length && cells[i]?.block_type === "EMPTY") i++;
        const len = i - start;
        const beforeType = start > 0 ? cells[start - 1]?.block_type : null;
        const afterType = i < cells.length ? cells[i]?.block_type : null;
        const isSandwiched = beforeType !== null && afterType !== null && beforeType !== "EMPTY" && afterType !== "EMPTY";
        const isStranded = isSandwiched && len >= 1 && len <= 3;
        if (isStranded) {
          for (let j = start; j < i; j++) bump(String(row.category), cells[j]!.date);
        }
      }

      // additionally: count MinLOS-blocked orphan-night singles as “high urgency”
      for (let k = 1; k < cells.length - 1; k++) {
        const c = cells[k];
        if (!c || c.block_type !== "EMPTY") continue;
        const before = cells[k - 1];
        const after = cells[k + 1];
        if (!before || !after) continue;
        if (before.block_type === "EMPTY" || after.block_type === "EMPTY") continue;
        if (c.min_stay_active && c.min_stay_nights > 1) bump(String(row.category), c.date);
      }
    }
    return map;
  }

  const strandedScores = useMemo(() => computeStrandedDateCategoryScores(activeRows, maxDays), [activeRows, maxDays]);

  const topStranded = useMemo(() => {
    const entries = [...strandedScores.entries()]
      .map(([k, v]) => {
        const [category, date] = k.split("::");
        return { category, date, roomsImpacted: v };
      })
      .sort((a, b) => b.roomsImpacted - a.roomsImpacted)
      .slice(0, 10);
    return entries;
  }, [strandedScores]);

  const minLosBlocks = useMemo(() => computeMinLosOrphanNightBlocks(activeRows, maxDays), [activeRows, maxDays]);
  const sandwichOffers = useMemo(() => computeOrphanNightOfferCount(activeRows, maxDays), [activeRows, maxDays]);

  const runAnalysis = useCallback(async () => {
    setAnalysing(true);
    setPricing(null);
    setCommitted(null);
    try {
      const res = await analysePricing();
      const data = res.data as PricingAnalyseResponse;
      setPricing(data);
      setRows(Object.fromEntries(
        data.recommendations.map(r => [
          `${r.category}::${r.date}`,
          { decision: null, overrideValue: String(r.suggested_rate) },
        ])
      ));
    } catch {
      show("Pricing analysis failed", "error");
    } finally {
      setAnalysing(false);
    }
  }, [show]);

  const activeRecs = useMemo(() => {
    if (!pricing) return [] as PricingRecommendation[];
    const cats = new Set(selectedCategories);
    return pricing.recommendations.filter(r => cats.has(r.category as RoomCategory));
  }, [pricing, selectedCategories]);

  const recsByCategory = useMemo(() => {
    const map = new Map<string, PricingRecommendation[]>();
    for (const r of activeRecs) {
      const key = r.category;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    for (const [, list] of map) list.sort((a, b) => a.date.localeCompare(b.date));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [activeRecs]);

  const matchedToStranded = useMemo(() => {
    const strandedKeys = new Set([...strandedScores.keys()]);
    return activeRecs.filter(r => strandedKeys.has(`${r.category}::${r.date}`));
  }, [activeRecs, strandedScores]);

  const suggestedDiscounts = useMemo(() => matchedToStranded.filter(r => r.change_pct < 0), [matchedToStranded]);
  const suggestedIncreases = useMemo(() => activeRecs.filter(r => r.change_pct > 0 && r.occupancy_pct >= 80), [activeRecs]);

  const acceptedCount = useMemo(
    () => Object.values(rows).filter(r => r.decision === "accepted" || r.decision === "override").length,
    [rows],
  );

  const setDecision = (key: string, d: Decision) =>
    setRows(prev => ({ ...prev, [key]: { ...prev[key], decision: d } }));

  const setOverride = (key: string, val: string) =>
    setRows(prev => ({ ...prev, [key]: { ...prev[key], overrideValue: val, decision: "override" } }));

  const acceptAllStrandedDiscounts = () => {
    const keys = new Set(suggestedDiscounts.map(r => `${r.category}::${r.date}`));
    setRows(prev => Object.fromEntries(
      Object.entries(prev).map(([k, r]) => {
        if (!keys.has(k)) return [k, r];
        if (r.decision === "rejected") return [k, r];
        return [k, { ...r, decision: "accepted" as const }];
      })
    ));
  };

  const handleCommit = async () => {
    if (!pricing) return;
    const items: PricingCommitItem[] = [];
    for (const rec of pricing.recommendations) {
      if (!selectedCategories.includes(rec.category as RoomCategory)) continue;
      const key = `${rec.category}::${rec.date}`;
      const row = rows[key];
      if (!row || row.decision === "rejected" || row.decision === null) continue;
      const rate = row.decision === "override"
        ? Math.round(parseFloat(row.overrideValue) / 100) * 100
        : rec.suggested_rate;
      if (!isNaN(rate) && rate > 0) items.push({ category: rec.category, date: rec.date, new_rate: rate });
    }
    if (!items.length) { show("No accepted recommendations to commit", "error"); return; }
    setCommitting(true);
    try {
      const res = await commitPricing(items);
      setCommitted(res.data);
      show(`${res.data.updated} rate updates applied`, "success");
    } catch {
      show("Commit failed", "error");
    } finally {
      setCommitting(false);
    }
  };

  const runSandwichRefresh = async () => {
    if (!heatmap) return;
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, maxDays);
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      await dashboardSandwichPlaybook({ start: startStr, end: endStr, categories: selectedCategories });
      show("Sandwich playbook applied (MinLOS relaxed + 50% offers refreshed)", "success");
      await refreshHeatmap();
    } catch {
      show("Failed to apply orphan-night playbook", "error");
    }
  };

  return (
    <div className="bg-surface border border-border min-h-[600px] flex flex-col relative">
      <Toasts />

      {/* header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <Tags className="w-4 h-4 text-accent" />
          <div>
            <div className="text-sm font-bold text-text flex items-center gap-2">
              Pricing Optimization{" "}
              <AiTag title="RateIQ analyzes occupancy and stranded gaps for rate actions, and runs a predictive what-if discount ladder (demand, net price, revenue index) to contextualize discount depth." />
            </div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted font-bold">
              Fragmentation-aware rate actions · tie discounts to stranded inventory
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-[11px] uppercase tracking-widest font-bold text-text-muted hover:text-text border border-border px-3 py-2 hover:bg-surface-2 transition-colors flex items-center gap-1.5 disabled:opacity-40"
            onClick={refreshHeatmap}
            disabled={loadingHeatmap}
          >
            {loadingHeatmap ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
          <button
            className="bg-text text-surface text-[11px] uppercase tracking-widest font-bold px-5 py-2 hover:bg-text/90 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40"
            onClick={runAnalysis}
            disabled={analysing}
          >
            {analysing ? <Loader2 className="w-3 h-3 animate-spin" /> : <DollarSign className="w-3 h-3" />}
            Run Analysis
          </button>
          {pricing && !committed && (
            <button
              className="bg-occugreen text-white text-[11px] uppercase tracking-widest font-bold px-5 py-2 hover:brightness-110 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40"
              onClick={handleCommit}
              disabled={committing || acceptedCount === 0}
            >
              {committing
                ? <><Loader2 className="w-3 h-3 animate-spin" /> Committing</>
                : <><CheckCircle2 className="w-3 h-3" /> Commit ({acceptedCount})</>}
            </button>
          )}
        </div>
      </div>

      {/* controls */}
      <div className="px-6 py-4 border-b border-border bg-surface-2/20 flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Window</span>
          <input
            type="number"
            min={7}
            max={60}
            value={spanDays}
            onChange={(e) => setSpanDays(parseInt(e.target.value || "14", 10))}
            className="w-20 bg-surface border border-border text-text text-xs font-mono px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">days</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Categories</span>
          {availableCategories.map((c) => {
            const on = selectedCategories.includes(c);
            return (
              <button
                key={c}
                onClick={() => setSelectedCategories(prev => on ? prev.filter(x => x !== c) : [...prev, c])}
                className={`text-[10px] font-bold uppercase tracking-widest border px-2.5 py-1 transition-colors ${
                  on ? "bg-accent/10 border-accent/40 text-accent" : "bg-surface border-border text-text-muted hover:text-text"
                }`}
              >
                {c}
              </button>
            );
          })}
          {availableCategories.length > 0 && (
            <button
              onClick={() => setSelectedCategories(availableCategories)}
              className="text-[10px] font-bold uppercase tracking-widest border border-border px-2.5 py-1 text-text-muted hover:text-text hover:bg-surface transition-colors"
            >
              All
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="text-[11px] uppercase tracking-widest font-bold border border-accent/30 text-accent px-4 py-2 hover:bg-accent/10 transition-colors flex items-center gap-1.5"
            onClick={runSandwichRefresh}
          >
            <Wand2 className="w-3 h-3" />
            Refresh Orphan-night Offers
          </button>
          {suggestedDiscounts.length > 0 && (
            <button
              className="text-[11px] uppercase tracking-widest font-bold border border-border text-text-muted px-4 py-2 hover:bg-surface transition-colors flex items-center gap-1.5"
              onClick={acceptAllStrandedDiscounts}
            >
              <Sparkles className="w-3 h-3" />
              Accept stranded discounts ({suggestedDiscounts.length})
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="px-6 py-4 border-b border-border grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="border border-border bg-surface-2/40 px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">MinLOS orphan-night blocks</div>
          <div className="text-2xl font-serif font-bold text-text mt-1">{minLosBlocks}</div>
          <div className="text-[10px] text-text-muted mt-1">Blocked orphan nights in window</div>
        </div>
        <div className="border border-border bg-surface-2/40 px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Active orphan-night offers</div>
          <div className="text-2xl font-serif font-bold text-text mt-1">{sandwichOffers}</div>
          <div className="text-[10px] text-text-muted mt-1">Discount markers in heatmap</div>
        </div>
        <div className="border border-border bg-surface-2/40 px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Stranded hotspots</div>
          <div className="text-2xl font-serif font-bold text-text mt-1">{topStranded.length}</div>
          <div className="text-[10px] text-text-muted mt-1">Top (category, date) combos</div>
        </div>
        <div className="border border-border bg-surface-2/40 px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">High-demand increases</div>
          <div className="text-2xl font-serif font-bold text-text mt-1">{suggestedIncreases.length}</div>
          <div className="text-[10px] text-text-muted mt-1">Occ ≥ 80% and rate-up</div>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto">
        {!pricing && !analysing && !committed && (
          <div className="py-20 text-center px-6">
            <DollarSign className="w-8 h-8 text-accent/30 mb-4 mx-auto" />
            <div className="font-serif font-bold text-xl text-text mb-2">Fragmentation-aware pricing</div>
            <div className="text-xs text-text-muted max-w-xl mx-auto leading-relaxed">
              This tab links stranded inventory (short orphan gaps, MinLOS orphan-night blocks, and orphan-night offers)
              to daily pricing actions so you can show “recovered usable capacity” + “pricing impact” in the demo.
            </div>
          </div>
        )}

        {committed && (
          <div className="px-6 py-10 border-b border-border bg-occugreen/[0.03] flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Rates updated</div>
              <div className="text-4xl font-serif font-bold text-occugreen mt-1">
                {committed.updated} slot{committed.updated !== 1 ? "s" : ""} updated
              </div>
              {committed.skipped > 0 && (
                <div className="text-xs text-text-muted mt-1">
                  {committed.skipped} skipped (below floor rate)
                </div>
              )}
              <button
                className="mt-5 text-xs uppercase tracking-widest font-bold border border-border px-5 py-2 hover:bg-surface transition-colors text-text"
                onClick={runAnalysis}
              >
                Run new analysis
              </button>
            </div>
            <TrendingUp className="w-14 h-14 text-occugreen opacity-70" />
          </div>
        )}

        {analysing && (
          <div className="py-24 text-center text-text-muted text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
            Running RateIQ pricing analysis…
          </div>
        )}

        {/* stranded hotspots */}
        {pricing && !committed && (
          <div className="border-b border-border">
            <div className="px-6 py-3 bg-surface-2/60 border-b border-border/50 flex items-center gap-3">
              <span className="text-[10px] font-bold uppercase tracking-widest border border-border px-2.5 py-1 bg-surface text-text">
                Stranded inventory hotspots
              </span>
              <span className="text-xs text-text-muted">Where short gaps + MinLOS blocks concentrate</span>
            </div>

            {topStranded.length === 0 ? (
              <div className="px-6 py-10 text-sm text-text-muted">No stranded hotspots detected in the selected window.</div>
            ) : (
              <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {topStranded.map(h => {
                  const key = `${h.category}::${h.date}`;
                  const rec = activeRecs.find(r => r.category === h.category && r.date === h.date);
                  const row = rows[key];
                  const isAccepted = row?.decision === "accepted" || row?.decision === "override";
                  const isRejected = row?.decision === "rejected";
                  const hasDiscount = rec ? rec.change_pct < 0 : false;
                  return (
                    <div key={key} className={`border px-4 py-3 bg-surface ${isAccepted ? "border-occugreen/40 bg-occugreen/[0.03]" : "border-border"}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">{h.category}</div>
                          <div className="font-mono text-xs text-text mt-1">{h.date}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">rooms impacted</div>
                          <div className="text-lg font-serif font-bold text-text">{h.roomsImpacted}</div>
                        </div>
                      </div>

                      {rec ? (
                        <div className="mt-3 flex items-center justify-between text-xs">
                          <div className="text-text-muted">
                            Suggested:{" "}
                            <span className={`font-mono font-bold ${hasDiscount ? "text-occured" : "text-occugreen"}`}>
                              ${rec.suggested_rate.toLocaleString("en-US")}
                            </span>
                            <span className="text-text-muted"> ({rec.change_pct > 0 ? "+" : ""}{rec.change_pct}%)</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              className="p-1.5 hover:bg-occugreen/10 text-occugreen/60 hover:text-occugreen transition-colors rounded-sm disabled:opacity-30"
                              title="Accept"
                              onClick={() => setDecision(key, "accepted")}
                              disabled={isRejected}
                            >
                              <CheckCircle2 className="w-4 h-4" />
                            </button>
                            <button
                              className={`p-1.5 rounded-sm transition-colors ${
                                isRejected ? "text-occured bg-occured/10" : "text-text-muted hover:text-occured hover:bg-occured/10"
                              }`}
                              title={isRejected ? "Undo reject" : "Reject"}
                              onClick={() => setDecision(key, isRejected ? null : "rejected")}
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 text-xs text-text-muted">
                          No AI recommendation for this date/category.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* AI summary + decision table */}
        {pricing && !committed && (
          <>
            <div className="px-6 py-4 bg-accent/5 border-b border-accent/20 text-sm text-text leading-relaxed">
              <span className="text-[10px] font-bold uppercase tracking-widest text-accent mr-2">AI Summary</span>
              {pricing.summary}
            </div>

            {pricing.what_if && pricing.what_if.scenarios.length > 0 && (
              <div className="px-6 py-5 border-b border-border bg-surface-2/30">
                <div className="flex items-start gap-3 mb-4">
                  <Wand2 className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-1">
                      Predictive simulation · what-if discounts
                    </div>
                    <p className="text-sm text-text font-medium leading-snug">{pricing.what_if.headline}</p>
                    <p className="text-xs text-text-muted mt-2 leading-relaxed">{pricing.what_if.methodology}</p>
                  </div>
                </div>
                <div className="overflow-x-auto rounded border border-border/60 bg-surface">
                  <table className="w-full text-sm min-w-[640px]">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-widest text-text-muted font-bold border-b border-border/50 bg-surface-2/80">
                        <th className="px-4 py-2.5 text-left">Discount</th>
                        <th className="px-4 py-2.5 text-right">Demand lift</th>
                        <th className="px-4 py-2.5 text-right" title="Net ADR vs baseline (100)">
                          Net price idx
                        </th>
                        <th className="px-4 py-2.5 text-right" title="Expected room revenue vs baseline (100)">
                          Revenue idx
                        </th>
                        <th className="px-4 py-2.5 text-left">Rationale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pricing.what_if.scenarios.map((row: PricingWhatIfScenario, idx: number) => {
                        const isRec = idx === pricing.what_if!.recommended_index;
                        return (
                          <tr
                            key={`${row.discount_pct}-${idx}`}
                            className={`border-b border-border/30 last:border-0 ${
                              isRec ? "bg-accent/[0.08]" : "hover:bg-surface-2/50"
                            }`}
                          >
                            <td className="px-4 py-3">
                              <span className="font-mono font-bold text-text">{row.discount_pct}%</span>
                              {isRec && (
                                <span className="ml-2 text-[9px] font-bold uppercase tracking-wide text-accent border border-accent/40 px-1.5 py-0.5 rounded">
                                  Suggested
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-xs">
                              {row.demand_lift_pct > 0 ? "+" : ""}
                              {row.demand_lift_pct}%
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-xs text-text-muted">{row.net_price_index}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text">{row.revenue_index}</td>
                            <td className="px-4 py-3 text-xs text-text-muted max-w-md leading-relaxed">{row.rationale}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-text-muted mt-3 leading-relaxed">
                  Indices are illustrative vs a no-discount baseline (100). Use alongside per-date recommendations above — not a substitute for floor rates or channel rules.
                </p>
              </div>
            )}

            {recsByCategory.length === 0 ? (
              <div className="py-16 text-center text-sm text-text-muted">
                No recommendations for selected categories.
              </div>
            ) : (
              recsByCategory.map(([category, recs]) => (
                <div key={category} className="border-b border-border last:border-0">
                  <div className="px-6 py-3 bg-surface-2/60 border-b border-border/50 flex items-center gap-3 sticky top-0 z-10">
                    <span className="text-[10px] font-bold uppercase tracking-widest border border-border px-2.5 py-1 bg-surface text-text">
                      {category}
                    </span>
                    <span className="text-xs text-text-muted">{recs.length} date{recs.length !== 1 ? "s" : ""} flagged</span>
                  </div>

                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-widest text-text-muted font-bold border-b border-border/40">
                        <th className="px-6 py-2.5 text-left">Date</th>
                        <th className="px-4 py-2.5 text-right">Occ</th>
                        <th className="px-4 py-2.5 text-right">Before</th>
                        <th className="px-4 py-2.5 text-center w-10"></th>
                        <th className="px-4 py-2.5 text-right">After</th>
                        <th className="px-4 py-2.5 text-right">Hotspot</th>
                        <th className="px-6 py-2.5 text-left">Reason</th>
                        <th className="px-6 py-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recs.map(rec => {
                        const key = `${rec.category}::${rec.date}`;
                        const row = rows[key];
                        if (!row) return null;
                        const isOverride = row.decision === "override";
                        const isAccepted = row.decision === "accepted" || isOverride;
                        const isRejected = row.decision === "rejected";
                        const isIncrease = rec.change_pct > 0;
                        const hotspotRooms = strandedScores.get(key) ?? 0;
                        return (
                          <tr
                            key={key}
                            className={`border-b border-border/30 transition-colors ${
                              isRejected ? "opacity-35" :
                              isAccepted ? "bg-occugreen/[0.03]" :
                              "hover:bg-surface-2/40"
                            }`}
                          >
                            <td className="px-6 py-3 font-mono text-xs text-text whitespace-nowrap">{rec.date}</td>
                            <td className="px-4 py-3 text-right">
                              <span className={`text-xs font-bold ${
                                rec.occupancy_pct > 80 ? "text-occugreen" :
                                rec.occupancy_pct < 40 ? "text-occured" : "text-text-muted"
                              }`}>
                                {rec.occupancy_pct}%
                              </span>
                              <div className="text-[9px] text-text-muted">{rec.otb} OTB</div>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-xs text-text-muted line-through decoration-text-muted/40">
                              ${rec.current_rate.toLocaleString("en-US")}
                            </td>
                            <td className="px-1 py-3 text-center">
                              {isIncrease
                                ? <TrendingUp className="w-3.5 h-3.5 text-occugreen mx-auto" />
                                : <TrendingDown className="w-3.5 h-3.5 text-occured mx-auto" />}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {isOverride ? (
                                <div className="flex items-center justify-end gap-1">
                                  <span className="text-[10px] text-text-muted">$</span>
                                  <input
                                    type="number"
                                    step="100"
                                    value={row.overrideValue}
                                    onChange={e => setOverride(key, e.target.value)}
                                    className="w-24 bg-surface border border-accent text-text text-xs font-mono text-right px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent"
                                  />
                                </div>
                              ) : (
                                <span className={`font-mono text-xs font-bold ${isIncrease ? "text-occugreen" : "text-occured"}`}>
                                  ${rec.suggested_rate.toLocaleString("en-US")}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 ${
                                hotspotRooms > 0 ? "bg-accent/10 text-accent" : "bg-surface-2 text-text-muted"
                              }`}>
                                {hotspotRooms > 0 ? `${hotspotRooms} rooms` : "—"}
                              </span>
                            </td>
                            <td className="px-6 py-3 text-xs text-text-muted max-w-lg leading-relaxed">{rec.reason}</td>
                            <td className="px-6 py-3">
                              <div className="flex items-center justify-end gap-1">
                                {!isAccepted && (
                                  <button
                                    title="Accept suggested rate"
                                    className="p-1.5 hover:bg-occugreen/10 text-occugreen/50 hover:text-occugreen transition-colors rounded-sm"
                                    onClick={() => setDecision(key, "accepted")}
                                  >
                                    <CheckCircle2 className="w-4 h-4" />
                                  </button>
                                )}
                                <button
                                  title={isOverride ? "Cancel override" : "Override rate"}
                                  className={`p-1.5 rounded-sm transition-colors ${
                                    isOverride ? "text-accent bg-accent/10" : "text-text-muted hover:text-accent hover:bg-accent/10"
                                  }`}
                                  onClick={() => setDecision(key, isOverride ? null : "override")}
                                >
                                  <Sparkles className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  title={isRejected ? "Undo reject" : "Reject"}
                                  className={`p-1.5 rounded-sm transition-colors ${
                                    isRejected ? "text-occured bg-occured/10" : "text-text-muted hover:text-occured hover:bg-occured/10"
                                  }`}
                                  onClick={() => setDecision(key, isRejected ? null : "rejected")}
                                >
                                  <XCircle className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

