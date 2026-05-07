import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { analysePricing, commitPricing, getHeatmap } from "../../api/client";
import type {
  HeatmapResponse,
  HeatmapRow,
  PricingAnalyseResponse,
  PricingCalendarCell,
  PricingCommitItem,
} from "../../types";
import { useToast } from "../shared/Toast";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { AiTag } from "../shared/AiTag";
import { format, parseISO } from "date-fns";
import { getPrimaryShockTrigger } from "../../mock/contextFeed";

const PRICING_CACHE_KEY = "rateiq_last_analysis";

// ── Loading animation messages ────────────────────────────────────────────────

const LOADING_MESSAGES = [
  "Connecting to market data feeds...",
  "Analyzing weather patterns for next 20 days...",
  "Scanning NJ events and conference calendar...",
  "Processing market sentiment and travel trends...",
  "Evaluating occupancy and orphan room patterns...",
  "Reviewing 2-year historical booking trends...",
  "Synthesizing all pricing signals...",
  "Finalizing recommendations...",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeOrphanNightsFromHeatmap(rows: HeatmapRow[], maxDays: number): {
  count: number;
  categories: string[];
} {
  const cats = new Set<string>();
  let count = 0;
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    for (let i = 1; i < cells.length - 1; i++) {
      const c = cells[i];
      const before = cells[i - 1];
      const after = cells[i + 1];
      if (!c || !before || !after) continue;
      if (c.block_type !== "EMPTY") continue;
      if (before.block_type === "EMPTY" || after.block_type === "EMPTY") continue;
      count += 1;
      cats.add(row.category);
    }
  }
  return { count, categories: [...cats].sort() };
}

function computeRevenueStats(rows: HeatmapRow[], maxDays: number): {
  unsoldRooms: number;
  revenueAtRisk: number;
  revenueOnBooks: number;
  roomsDiscounted: number;
} {
  let unsoldRooms = 0;
  let revenueAtRisk = 0;
  let revenueOnBooks = 0;
  let roomsDiscounted = 0;

  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    for (const c of cells) {
      if (!c) continue;
      if (c.block_type === "EMPTY") {
        unsoldRooms += 1;
        revenueAtRisk += c.current_rate;
        if (c.current_rate < row.base_rate * 0.95) roomsDiscounted += 1;
      } else {
        revenueOnBooks += c.current_rate;
      }
    }
  }
  return { unsoldRooms, revenueAtRisk, revenueOnBooks, roomsDiscounted };
}

function findFirstSandwichNight(rows: HeatmapRow[], maxDays: number): {
  roomId: string;
  category: string;
  date: string;
  currentRate: number;
  baseRate: number;
} | null {
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    for (let i = 1; i < cells.length - 1; i++) {
      const c = cells[i];
      const before = cells[i - 1];
      const after = cells[i + 1];
      if (!c || !before || !after) continue;
      if (c.block_type !== "EMPTY") continue;
      if (before.block_type === "EMPTY" || after.block_type === "EMPTY") continue;
      return {
        roomId: String(row.room_id),
        category: String(row.category),
        date: String(c.date),
        currentRate: Number(c.current_rate ?? row.base_rate),
        baseRate: Number(row.base_rate),
      };
    }
  }
  return null;
}

// ── Calendar cell component ───────────────────────────────────────────────────

interface CellProps {
  cell: PricingCalendarCell;
  selected: boolean;
  onToggle: () => void;
  customRate?: number;
  onCustomRate: (rate: number | null) => void;
}

function CalendarCellView({ cell, selected, onToggle, customRate, onCustomRate }: CellProps) {
  const cellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const displayRate = customRate ?? cell.suggested_rate;
  const isCustom = customRate !== undefined;

  const effectiveChangePct = cell.current_rate > 0
    ? ((displayRate - cell.current_rate) / cell.current_rate) * 100
    : cell.change_pct;
  const effectiveAction = effectiveChangePct > 2 ? "INCREASE" : effectiveChangePct < -2 ? "DISCOUNT" : "MAINTAIN";

  const cellBg =
    cell.is_orphan
      ? "bg-text/10 border-text/20 opacity-60"
      : effectiveAction === "INCREASE"
      ? selected
        ? "bg-occugreen/20 border-occugreen/60"
        : "bg-occugreen/10 border-occugreen/30"
      : effectiveAction === "DISCOUNT"
      ? selected
        ? "bg-occured/20 border-occured/50"
        : "bg-occured/10 border-occured/25"
      : selected
      ? "bg-surface-2 border-border"
      : "bg-surface border-border/50";

  const handleMouseEnter = () => {
    if (cellRef.current && !isEditing) {
      const r = cellRef.current.getBoundingClientRect();
      setTipPos({ x: r.left, y: r.top });
    }
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setTipPos(null);
    setEditValue(String(Math.round(displayRate)));
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const confirmEdit = () => {
    const parsed = parseInt(editValue);
    if (!isNaN(parsed) && parsed > 0) {
      onCustomRate(Math.round(parsed / 5) * 5);
    }
    setIsEditing(false);
  };

  return (
    <td className="p-0.5">
      <div
        ref={cellRef}
        className={`border cursor-pointer px-2 py-1.5 min-w-[88px] transition-all hover:opacity-90 relative group ${cellBg} ${selected ? "ring-1 ring-accent/50" : ""}`}
        onClick={!isEditing ? onToggle : undefined}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setTipPos(null)}
      >
        {cell.is_orphan ? (
          <div className="flex items-center justify-center h-8">
            <AlertTriangle className="w-3 h-3 text-text-muted" />
            <span className="text-[9px] text-text-muted ml-1 uppercase tracking-wide">Orphan</span>
          </div>
        ) : isEditing ? (
          <div className="flex flex-col gap-0.5" onClick={e => e.stopPropagation()}>
            <input
              ref={inputRef}
              autoFocus
              type="number"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") confirmEdit();
                if (e.key === "Escape") setIsEditing(false);
              }}
              onBlur={confirmEdit}
              className="w-full text-xs font-mono font-bold bg-surface border border-accent px-1 py-0.5 text-text outline-none"
            />
            <div className="text-[8px] text-text-muted text-center">↵ confirm · esc cancel</div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="text-xs font-mono font-bold text-text">
                ${displayRate.toLocaleString("en-US")}
                {isCustom && <span className="ml-0.5 text-accent text-[8px]">✎</span>}
              </div>
              <button
                onClick={startEdit}
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 text-text-muted hover:text-accent"
                title="Edit rate"
              >
                <Pencil className="w-2.5 h-2.5" />
              </button>
            </div>
            <div className={`text-[9px] font-bold flex items-center gap-0.5 ${
              effectiveAction === "INCREASE" ? "text-occugreen"
              : effectiveAction === "DISCOUNT" ? "text-occured"
              : "text-text-muted"
            }`}>
              {effectiveAction === "INCREASE" ? <TrendingUp className="w-2.5 h-2.5" /> : null}
              {effectiveAction === "DISCOUNT" ? <TrendingDown className="w-2.5 h-2.5" /> : null}
              {effectiveChangePct > 0 ? "+" : ""}{effectiveChangePct.toFixed(1)}%
            </div>
            <div className="mt-0.5 flex items-center gap-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                cell.confidence === "HIGH" ? "bg-occugreen"
                : cell.confidence === "LOW" ? "bg-occured"
                : "bg-yellow-500"
              }`} />
              <span className="text-[8px] text-text-muted">{cell.occupancy_pct}%</span>
            </div>
          </>
        )}
      </div>

      {/* Tooltip — rendered into body via portal to escape any overflow clipping */}
      {tipPos && !cell.is_orphan && !isEditing && createPortal(
        <div
          className="fixed z-[9999] w-64 bg-surface border border-border shadow-xl p-3 pointer-events-none"
          style={{
            left: Math.min(tipPos.x, window.innerWidth - 272),
            bottom: window.innerHeight - tipPos.y + 6,
          }}
        >
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-1">
            {effectiveAction} · {cell.confidence} confidence
          </div>
          <div className="text-xs text-text leading-relaxed mb-2">{cell.reason}</div>
          {cell.weather_factor && (
            <div className="text-[10px] text-text-muted">
              <span className="font-bold text-text-muted/80">Weather:</span> {cell.weather_factor}
            </div>
          )}
          {cell.event_factor && (
            <div className="text-[10px] text-text-muted">
              <span className="font-bold text-text-muted/80">Event:</span> {cell.event_factor}
            </div>
          )}
          {cell.news_factor && (
            <div className="text-[10px] text-text-muted">
              <span className="font-bold text-text-muted/80">Market:</span> {cell.news_factor}
            </div>
          )}
          <div className="mt-2 pt-2 border-t border-border/40 flex items-center justify-between text-[9px] text-text-muted">
            <span>${cell.current_rate.toLocaleString()} → ${displayRate.toLocaleString()}{isCustom ? " (custom)" : ""}</span>
            <span>{cell.otb} OTB</span>
          </div>
        </div>,
        document.body
      )}
    </td>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PricingOptimizationTab() {
  const { show, Toasts } = useToast();

  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [pricing, setPricing] = useState<PricingAnalyseResponse | null>(null);
  const [loadingHeatmap, setLoadingHeatmap] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<{ updated: number; skipped: number } | null>(null);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const [hasCached, setHasCached] = useState(false);
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [customRates, setCustomRates] = useState<Record<string, number>>({});
  const [shockTriggered, setShockTriggered] = useState(false);

  const WINDOW_DAYS = 20;
  const shock = useMemo(() => getPrimaryShockTrigger(), []);
  const operationalCost = 40;

  // ── Load heatmap on mount ──────────────────────────────────────────────────

  const refreshHeatmap = useCallback(async () => {
    setLoadingHeatmap(true);
    try {
      const res = await getHeatmap();
      setHeatmap(res.data as HeatmapResponse);
    } catch {
      show("Failed to load heatmap", "error");
    } finally {
      setLoadingHeatmap(false);
    }
  }, [show]);

  useEffect(() => {
    void refreshHeatmap();
    setHasCached(!!localStorage.getItem(PRICING_CACHE_KEY));
  }, []);

  // ── Loading message cycling ────────────────────────────────────────────────

  useEffect(() => {
    if (!analysing) return;
    setLoadingMsgIdx(0);
    const id = setInterval(() => {
      setLoadingMsgIdx(i => (i + 1) % LOADING_MESSAGES.length);
    }, 3200);
    return () => clearInterval(id);
  }, [analysing]);

  // ── Summary card data (computed from heatmap) ──────────────────────────────

  const cardStats = useMemo(() => {
    if (!heatmap) return null;
    const orphan = computeOrphanNightsFromHeatmap(heatmap.rows, WINDOW_DAYS);
    const rev = computeRevenueStats(heatmap.rows, WINDOW_DAYS);
    return { ...orphan, ...rev };
  }, [heatmap]);

  const firstSandwich = useMemo(() => {
    if (!heatmap) return null;
    return findFirstSandwichNight(heatmap.rows, WINDOW_DAYS);
  }, [heatmap]);

  const clearanceScenario = useMemo(() => {
    const discountedRate = 110;
    const netProfit = discountedRate - operationalCost;
    const gaugeMax = 120;
    const profitPct = Math.max(0, Math.min(100, (netProfit / gaugeMax) * 100));
    return { discountedRate, netProfit, profitPct, gaugeMax };
  }, [operationalCost]);

  // ── Run analysis ──────────────────────────────────────────────────────────

  const applyAnalysis = useCallback((data: PricingAnalyseResponse) => {
    setPricing(data);
    setCustomRates({});
    setCommitted(null);
    const preSelected = new Set<string>();
    for (const row of data.calendar_rows) {
      for (const cell of row.cells) {
        if (cell.action !== "MAINTAIN" && !cell.is_orphan) {
          preSelected.add(`${row.category}::${cell.date}`);
        }
      }
    }
    setSelectedCells(preSelected);
  }, []);

  const loadCached = useCallback(() => {
    const raw = localStorage.getItem(PRICING_CACHE_KEY);
    if (!raw) return;
    try {
      applyAnalysis(JSON.parse(raw) as PricingAnalyseResponse);
      show("Loaded previous analysis", "success");
    } catch {
      show("Could not load cached analysis", "error");
    }
  }, [applyAnalysis, show]);

  const runAnalysis = useCallback(async () => {
    setAnalysing(true);
    setPricing(null);
    setCommitted(null);
    setSelectedCells(new Set());
    setCustomRates({});
    try {
      const res = await analysePricing();
      const data = res.data as PricingAnalyseResponse;
      applyAnalysis(data);
      try { localStorage.setItem(PRICING_CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
      setHasCached(true);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      show(detail ?? "Pricing analysis failed", "error");
    } finally {
      setAnalysing(false);
    }
  }, [applyAnalysis, show]);

  // ── Toggle cell selection ─────────────────────────────────────────────────

  const toggleCell = useCallback((category: string, date: string) => {
    const key = `${category}::${date}`;
    setSelectedCells(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!pricing) return;
    const all = new Set<string>();
    for (const row of pricing.calendar_rows) {
      for (const cell of row.cells) {
        if (!cell.is_orphan) all.add(`${row.category}::${cell.date}`);
      }
    }
    setSelectedCells(all);
  }, [pricing]);

  const deselectAll = useCallback(() => setSelectedCells(new Set()), []);

  // ── Commit ────────────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    if (!pricing || selectedCells.size === 0) {
      show("No cells selected to commit", "error");
      return;
    }
    const items: PricingCommitItem[] = [];
    for (const row of pricing.calendar_rows) {
      for (const cell of row.cells) {
        const key = `${row.category}::${cell.date}`;
        const rate = customRates[key] ?? cell.suggested_rate;
        if (selectedCells.has(key) && rate > 0) {
          items.push({ category: row.category, date: cell.date, new_rate: rate });
        }
      }
    }
    if (!items.length) { show("No valid items to commit", "error"); return; }
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
  }, [pricing, selectedCells, customRates, show]);

  // ── Derived counts ────────────────────────────────────────────────────────

  const selectedCount = selectedCells.size;

  const actionCounts = useMemo(() => {
    if (!pricing) return { increases: 0, discounts: 0, maintain: 0 };
    let increases = 0, discounts = 0, maintain = 0;
    for (const row of pricing.calendar_rows) {
      for (const cell of row.cells) {
        if (cell.action === "INCREASE") increases++;
        else if (cell.action === "DISCOUNT") discounts++;
        else maintain++;
      }
    }
    return { increases, discounts, maintain };
  }, [pricing]);

  // ── Date header formatter ─────────────────────────────────────────────────

  const formatDateHeader = (iso: string) => {
    try {
      const d = parseISO(iso);
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      return { day: format(d, "EEE"), date: format(d, "d"), isWeekend };
    } catch {
      return { day: "", date: iso.slice(8), isWeekend: false };
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <Toasts />

      {/* Pillar 2: Marginal Revenue Capture */}
      <div className="bg-surface border border-border p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Pillar 2</div>
            <div className="font-serif font-bold text-xl text-text mt-1">Marginal Revenue Capture</div>
            <div className="text-xs text-text-muted mt-2 max-w-3xl leading-relaxed">
              Smart Clearance monetizes “sandwich nights” that cannot be physically moved, while protecting your price floor.
            </div>
          </div>
          <div className="text-[10px] font-bold uppercase tracking-widest px-3 py-2 border border-border bg-surface-2/40 text-text-muted">
            Real-time elasticity · external shocks · A/B trade-offs (demo)
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Context Trigger / News Feed */}
          <div className="border border-border bg-surface p-5">
            <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-3">Context trigger</div>
            <button
              type="button"
              onClick={() => setShockTriggered(true)}
              className={`w-full text-left p-4 border transition-colors ${
                shockTriggered ? "border-accent/40 bg-accent/10" : "border-border bg-surface-2/40 hover:bg-surface-2"
              }`}
            >
              <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">News feed</div>
              <div className="font-bold text-text mt-1">{shock.title}</div>
              <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{shock.detail}</div>
            </button>
            <div className="mt-4 flex items-center justify-between gap-2">
              <div className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 border ${
                shockTriggered ? "border-accent/30 bg-accent/5 text-accent" : "border-border bg-surface-2/30 text-text-muted"
              }`}>
                {shockTriggered ? "Trigger active" : "Waiting"}
              </div>
              <button
                type="button"
                onClick={() => setShockTriggered(false)}
                className="text-[10px] font-bold uppercase tracking-widest px-3 py-2 border border-border bg-surface hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Logical Choice + Profit Gauge */}
          <div className="border border-border bg-surface p-5 xl:col-span-2">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
              <div>
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Logical choice</div>
                <div className="font-serif font-bold text-base text-text mt-0.5">Sell the stranded sandwich night</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                  {firstSandwich
                    ? <>Highlighted candidate: <span className="font-bold text-text">{firstSandwich.category}</span> · <span className="font-mono font-bold text-text">{firstSandwich.date}</span></>
                    : "No sandwich night found in the current 20-day slice (refresh heatmap and retry)."}
                </div>
              </div>
              <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-2">
                <AiTag title="Demo panel: uses shared mock context triggers and a fixed cost model to show decision logic and profit, independent of RateIQ calendar recommendations." />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-surface-2/40 border border-border p-4">
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Target slot</div>
                <div className="space-y-2 text-sm text-text">
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted font-medium">Previously empty</span>
                    <span className="font-mono font-bold tabular-nums">$0</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted font-medium">Discounted offer (Last Minute)</span>
                    <span className="font-mono font-bold tabular-nums">${clearanceScenario.discountedRate}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted font-medium">TCO (Operational cost)</span>
                    <span className="font-mono font-bold tabular-nums">-${operationalCost}</span>
                  </div>
                  <div className="pt-2 mt-2 border-t border-border flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Net profit</span>
                    <span className={`font-mono font-black tabular-nums ${shockTriggered ? "text-occugreen" : "text-text"}`}>
                      {shockTriggered ? `$${clearanceScenario.netProfit}` : "—"}
                    </span>
                  </div>
                </div>
                <div className="mt-3 text-[11px] text-text-muted leading-relaxed">
                  A/B trade-off sim: clearance only activates on a shock trigger and still respects the price floor (demo rule).
                </div>
              </div>

              <div className="bg-surface-2/40 border border-border p-4">
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Profit gauge</div>
                <div className="h-3.5 bg-surface border border-border overflow-hidden">
                  <div
                    className="h-full bg-occugreen/70 transition-all duration-700"
                    style={{ width: shockTriggered ? `${clearanceScenario.profitPct}%` : "0%" }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  <span>$0 (empty)</span>
                  <span>{shockTriggered ? `$${clearanceScenario.netProfit} net` : "$—"}</span>
                </div>
                <div className="mt-3 text-[11px] text-text-muted leading-relaxed">
                  Converts a 100% loss into net profit while explaining cost, not just discount depth.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Existing Pricing features (moved down) */}
      <div className="bg-surface border border-border min-h-[600px] flex flex-col relative">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <DollarSign className="w-4 h-4 text-accent" />
            <div>
              <div className="text-sm font-bold text-text flex items-center gap-2">
                RateIQ Pricing Optimization{" "}
                <AiTag title="RateIQ runs 5 parallel AI calls — weather, events, market news, historical trends, occupancy — then synthesizes into a 20-day pricing calendar per room category." />
              </div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted font-bold">
                Existing features · multi-signal AI · 20-day calendar · click cells to select for commit
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {hasCached && !pricing && (
              <button
                className="text-[11px] uppercase tracking-widest font-bold text-accent border border-accent/30 px-3 py-2 hover:bg-accent/5 transition-colors flex items-center gap-1.5"
                onClick={loadCached}
              >
                <Clock className="w-3 h-3" /> Previous Analysis
              </button>
            )}

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
              {analysing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Run Analysis
            </button>

            {pricing && !committed && (
              <button
                className="bg-occugreen text-white text-[11px] uppercase tracking-widest font-bold px-5 py-2 hover:brightness-110 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40"
                onClick={handleCommit}
                disabled={committing || selectedCount === 0}
              >
                {committing
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Committing</>
                  : <><CheckCircle2 className="w-3 h-3" /> Commit ({selectedCount})</>}
              </button>
            )}
          </div>
        </div>

        {/* Summary cards */}
        <div className="px-6 py-4 border-b border-border grid grid-cols-2 lg:grid-cols-4 gap-3 bg-surface-2/10">
        {/* Card 1: Orphan Nights */}
        <div className="border border-border bg-surface px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Orphan Nights</div>
          <div className="text-3xl font-serif font-bold text-text mt-2">
            {cardStats ? cardStats.count : <span className="text-text-muted">—</span>}
          </div>
          <div className="text-[10px] text-text-muted mt-1 truncate">
            {cardStats?.categories?.length
              ? cardStats.categories.join(", ")
              : "No categories affected"}
          </div>
        </div>

        {/* Card 2: Revenue Snapshot */}
        <div className="border border-border bg-surface px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Revenue Snapshot</div>
          <div className="flex items-end gap-3 mt-2">
            <div>
              <div className="text-[9px] text-occured uppercase tracking-wider font-bold">At Risk</div>
              <div className="text-lg font-serif font-bold text-occured">
                ${cardStats ? Math.round(cardStats.revenueAtRisk).toLocaleString("en-US") : "—"}
              </div>
            </div>
            <div className="text-text-muted text-xs pb-0.5">vs</div>
            <div>
              <div className="text-[9px] text-occugreen uppercase tracking-wider font-bold">On Books</div>
              <div className="text-lg font-serif font-bold text-occugreen">
                ${cardStats ? Math.round(cardStats.revenueOnBooks).toLocaleString("en-US") : "—"}
              </div>
            </div>
          </div>
          <div className="text-[10px] text-text-muted mt-1">
            {cardStats?.unsoldRooms ?? "—"} unsold · {cardStats?.roomsDiscounted ?? "—"} discounted
          </div>
        </div>

        {/* Card 3: Active Discounts */}
        <div className="border border-border bg-surface px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Active Discounts</div>
          <div className="text-3xl font-serif font-bold text-text mt-2">
            {cardStats ? cardStats.roomsDiscounted : <span className="text-text-muted">—</span>}
          </div>
          <div className="text-[10px] text-text-muted mt-1">Rooms below base rate · {WINDOW_DAYS}d window</div>
        </div>

        {/* Card 4: Revenue Rescue */}
        <div className={`border px-4 py-3 transition-colors ${
          pricing ? "border-accent/30 bg-accent/[0.03]" : "border-border bg-surface"
        }`}>
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Revenue Rescue</div>
          {pricing ? (
            <>
              <div className="text-3xl font-serif font-bold text-accent mt-2">
                +${Math.round(pricing.rescue_potential).toLocaleString("en-US")}
              </div>
              <div className="text-[10px] text-text-muted mt-1">
                Recoverable if {actionCounts.increases + actionCounts.discounts} recs committed
              </div>
            </>
          ) : (
            <>
              <div className="text-3xl font-serif font-bold text-text-muted mt-2">—</div>
              <div className="text-[10px] text-text-muted mt-1">Run analysis to compute</div>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">

        {/* Empty state */}
        {!pricing && !analysing && !committed && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="w-12 h-12 rounded-full border border-border flex items-center justify-center mb-4">
              <DollarSign className="w-5 h-5 text-text-muted" />
            </div>
            <div className="font-serif font-bold text-xl text-text mb-2">
              Waiting for analysis
            </div>
            <div className="text-xs text-text-muted max-w-md leading-relaxed">
              Click <span className="font-bold text-text">Run Analysis</span> to launch the multi-signal AI engine.
              It will analyze weather, local events, market news, and occupancy patterns to
              generate a 20-day pricing calendar per room category.
            </div>
          </div>
        )}

        {/* Loading animation */}
        {analysing && (
          <div className="flex-1 flex flex-col items-center justify-center py-20">
            <div className="flex items-center gap-3 mb-6">
              <Loader2 className="w-5 h-5 animate-spin text-accent" />
              <span className="text-sm font-bold text-text uppercase tracking-widest">RateIQ</span>
            </div>
            <div className="h-6 flex items-center justify-center">
              <span
                key={loadingMsgIdx}
                className="text-sm text-text-muted animate-pulse transition-all"
              >
                {LOADING_MESSAGES[loadingMsgIdx]}
              </span>
            </div>
            <div className="mt-8 flex gap-1">
              {LOADING_MESSAGES.map((_, i) => (
                <div
                  key={i}
                  className={`h-0.5 w-6 rounded transition-all duration-500 ${
                    i === loadingMsgIdx ? "bg-accent" : "bg-border"
                  }`}
                />
              ))}
            </div>
            <div className="mt-6 text-[10px] text-text-muted uppercase tracking-widest">
              Analyzing 5 signals · building 20-day calendar
            </div>
          </div>
        )}

        {/* Committed success */}
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

        {/* Calendar view */}
        {pricing && !committed && (
          <div className="flex-1 flex flex-col overflow-hidden">

            {/* AI summary bar */}
            <div className="px-6 py-3 bg-accent/5 border-b border-accent/20 flex items-start gap-2 shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
              <div className="text-xs text-text leading-relaxed">
                <span className="text-[10px] font-bold uppercase tracking-widest text-accent mr-2">Summary</span>
                {pricing.summary}
              </div>
            </div>

            {/* Calendar toolbar */}
            <div className="px-4 py-2 border-b border-border flex items-center gap-3 shrink-0 bg-surface-2/20">
              <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-text-muted">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 bg-occugreen/30 border border-occugreen/50" />
                  {actionCounts.increases} increases
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 bg-occured/20 border border-occured/40" />
                  {actionCounts.discounts} discounts
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 bg-surface border border-border" />
                  {actionCounts.maintain} maintain
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  className="text-[10px] font-bold uppercase tracking-widest text-accent hover:text-accent/80 px-2 py-1 border border-accent/30 hover:bg-accent/5 transition-colors"
                  onClick={selectAll}
                >
                  Select all
                </button>
                <button
                  className="text-[10px] font-bold uppercase tracking-widest text-text-muted hover:text-text px-2 py-1 border border-border hover:bg-surface transition-colors"
                  onClick={deselectAll}
                >
                  <X className="w-3 h-3 inline mr-1" />
                  Clear
                </button>
                <span className="text-[10px] text-text-muted">
                  {selectedCount} selected
                </span>
              </div>
            </div>

            {/* Scrollable calendar grid */}
            <div className="flex-1 overflow-auto">
              <table className="border-collapse text-xs" style={{ tableLayout: "fixed" }}>
                <thead className="sticky top-0 z-20 bg-surface">
                  <tr>
                    {/* Category label column */}
                    <th className="sticky left-0 z-30 bg-surface border-b border-r border-border px-3 py-2 text-left w-24 min-w-[96px]">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                        Category
                      </span>
                    </th>
                    {pricing.dates.map(d => {
                      const { day, date: dateNum, isWeekend } = formatDateHeader(d);
                      return (
                        <th
                          key={d}
                          className={`border-b border-border/50 px-1 py-1.5 text-center min-w-[88px] w-[88px] ${
                            isWeekend ? "bg-accent/5" : ""
                          }`}
                        >
                          <div className={`text-[9px] font-bold uppercase tracking-wider ${
                            isWeekend ? "text-accent" : "text-text-muted"
                          }`}>{day}</div>
                          <div className="text-xs font-mono font-bold text-text">{dateNum}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pricing.calendar_rows.map(row => (
                    <tr key={row.category} className="border-b border-border/30">
                      {/* Sticky category label */}
                      <td className="sticky left-0 z-10 bg-surface border-r border-border px-3 py-1 whitespace-nowrap">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-text">
                          {row.category}
                        </span>
                      </td>
                      {row.cells.map(cell => {
                        const key = `${row.category}::${cell.date}`;
                        return (
                          <CalendarCellView
                            key={cell.date}
                            cell={cell}
                            selected={selectedCells.has(key)}
                            onToggle={() => toggleCell(row.category, cell.date)}
                            customRate={customRates[key]}
                            onCustomRate={rate => {
                              setCustomRates(prev => {
                                const next = { ...prev };
                                if (rate === null) delete next[key];
                                else next[key] = rate;
                                return next;
                              });
                            }}
                          />
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

          </div>
        )}
      </div>
    </div>
    </div>
  );
}
