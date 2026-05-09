import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { analysePricingWithContext, commitPricing, getHeatmap } from "../../api/client";
import type {
  HeatmapCell,
  HeatmapResponse,
  HeatmapRow,
  PricingAnalyseResponse,
  PricingCalendarCell,
  PricingCommitItem,
  RoomCategory,
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
import type { ContextFeedItem } from "../../mock/contextFeed";
import { useOverviewSignals } from "../../context/overviewSignals";
import { getCompetitorRatePoint } from "../../mock/competitorPricing";
import {
  overviewCardClass,
  overviewCardLgClass,
  overviewEyebrowClass,
  overviewMutedBadgeClass,
  overviewSectionTitleClass,
  overviewStackClass,
  overviewSubtitleClass,
} from "./overviewChrome";

const PRICING_CACHE_KEY = "rateiq_last_analysis";

// ── Loading animation messages ────────────────────────────────────────────────

const LOADING_MESSAGES = [
  "Connecting to market data feeds...",
  "Scoping AI analysis to nights with unsold inventory...",
  "Analyzing weather patterns for next 15 days...",
  "Loading Overview context signals (events, weather, travel, market)...",
  "Scoring market impact from selected signals (AI)...",
  "Evaluating occupancy and orphan room patterns...",
  "Reviewing 2-year historical booking trends...",
  "Benchmarking competitor pricing (market research)...",
  "Synthesizing pricing signals for empty nights only (AI)...",
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

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function computeCompositeFromFactors(factors: ContextFeedItem["factors"]): number {
  const ws = factors.reduce((s, f) => s + (f.weight ?? 0), 0);
  if (ws <= 0) return 0;
  const weighted = factors.reduce((s, f) => s + clamp(f.score ?? 0, 0, 100) * (f.weight ?? 0), 0);
  return Math.round(weighted / ws);
}

function computeCategoryDayStats(rows: HeatmapRow[], date: string, category: string): {
  total: number;
  otb: number;
  occPct: number;
  avgRate: number;
  emptyRooms: number;
  sandwichEmptyRooms: number;
} {
  const catRows = rows.filter(r => String(r.category) === category);
  if (catRows.length === 0) return { total: 0, otb: 0, occPct: 0, avgRate: 0, emptyRooms: 0, sandwichEmptyRooms: 0 };

  let total = 0;
  let otb = 0;
  let rateSum = 0;
  let emptyRooms = 0;
  let sandwichEmptyRooms = 0;

  for (const row of catRows) {
    const idx = row.cells.findIndex(c => c?.date === date);
    if (idx < 0) continue;

    const c = row.cells[idx];
    if (!c) continue;
    total += 1;
    rateSum += Number(c.current_rate ?? 0);
    if (c.block_type !== "EMPTY") otb += 1;
    if (c.block_type === "EMPTY") {
      emptyRooms += 1;
      const before = row.cells[idx - 1];
      const after = row.cells[idx + 1];
      if (before && after && before.block_type !== "EMPTY" && after.block_type !== "EMPTY") {
        sandwichEmptyRooms += 1;
      }
    }
  }

  const avgRate = total > 0 ? rateSum / total : 0;
  const occPct = total > 0 ? (otb / total) * 100 : 0;
  return { total, otb, occPct: Math.round(occPct * 10) / 10, avgRate: Math.round(avgRate * 100) / 100, emptyRooms, sandwichEmptyRooms };
}

function heatmapCellAt(row: HeatmapRow, date: string): HeatmapCell | undefined {
  return row.cells.find(c => c.date === date);
}

function roomRowHasEmptyOnDates(row: HeatmapRow, dates: string[]): boolean {
  const want = new Set(dates);
  return row.cells.some(c => want.has(c.date) && c.block_type === "EMPTY");
}

/**
 * Room-level BAR for tooltip math; suggested rate stays category-level from RateIQ (commit applies per category+date).
 */
function mergeRoomPricingCell(base: PricingCalendarCell, roomCurrentRate: number): PricingCalendarCell {
  const suggested = base.suggested_rate;
  const cr = roomCurrentRate;
  const change_pct = cr > 0 ? Math.round(((suggested - cr) / cr) * 1000) / 10 : base.change_pct;
  let action: PricingCalendarCell["action"] = base.action;
  if (suggested > cr * 1.02) action = "INCREASE";
  else if (suggested < cr * 0.98) action = "DISCOUNT";
  else action = "MAINTAIN";
  return { ...base, current_rate: cr, change_pct, action };
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
    <td className="p-px align-top">
      <div
        ref={cellRef}
        className={`border cursor-pointer w-full min-h-[62px] box-border px-1.5 py-1 transition-all hover:opacity-90 relative group ${cellBg} ${selected ? "ring-1 ring-accent/40" : ""}`}
        onClick={!isEditing ? onToggle : undefined}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setTipPos(null)}
      >
        {cell.is_orphan ? (
          <div className="flex items-center justify-center min-h-[28px]">
            <AlertTriangle className="w-3 h-3 text-text-muted shrink-0" />
            <span className="text-[9px] text-text-muted ml-0.5 uppercase tracking-wide leading-none">Orphan</span>
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
              className="w-full text-[11px] font-mono font-bold bg-surface border border-accent px-1 py-0.5 text-text outline-none"
            />
            <div className="text-[9px] text-text-muted text-center">↵ confirm · esc cancel</div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-0.5 leading-tight">
              <div className="text-[12px] font-mono font-bold text-text tabular-nums truncate min-w-0">
                ${displayRate.toLocaleString("en-US")}
                {isCustom && <span className="ml-px text-accent text-[8px]">✎</span>}
              </div>
              <button
                onClick={startEdit}
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 shrink-0 text-text-muted hover:text-accent"
                title="Edit rate"
              >
                <Pencil className="w-2.5 h-2.5" />
              </button>
            </div>
            <div className={`text-[10px] font-bold flex items-center gap-0.5 leading-tight mt-0.5 ${
              effectiveAction === "INCREASE" ? "text-occugreen"
              : effectiveAction === "DISCOUNT" ? "text-occured"
              : "text-text-muted"
            }`}>
              {effectiveAction === "INCREASE" ? <TrendingUp className="w-2.5 h-2.5 shrink-0" /> : null}
              {effectiveAction === "DISCOUNT" ? <TrendingDown className="w-2.5 h-2.5 shrink-0" /> : null}
              {effectiveChangePct > 0 ? "+" : ""}{effectiveChangePct.toFixed(1)}%
            </div>
            <div className="mt-0.5 flex items-center gap-0.5 leading-tight">
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
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
  const { selectedItems } = useOverviewSignals();

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

  const WINDOW_DAYS = 15; // Align with Occupancy/Overview 15-day window
  const activeSignalBundle = useMemo(
    () => [selectedItems.EVENT, selectedItems.WEATHER, selectedItems.TRAVEL, selectedItems.MARKET],
    [selectedItems],
  );

  const mergedBundleFactors = useMemo(() => {
    const items = activeSignalBundle.filter(Boolean) as ContextFeedItem[];
    const agg = new Map<ContextFeedItem["factors"][number]["type"], { scoreSum: number; weightSum: number }>();
    for (const it of items) for (const f of it.factors) {
      const w = Math.max(0.01, Math.min(0.9, f.weight ?? 0.25));
      const s = clamp(f.score ?? 0, 0, 100);
      const prev = agg.get(f.type) ?? { scoreSum: 0, weightSum: 0 };
      prev.scoreSum += s * w;
      prev.weightSum += w;
      agg.set(f.type, prev);
    }
    return [...agg.entries()].map(([type, a]) => ({
      type,
      label: type,
      value: "bundle",
      score: Math.round(a.scoreSum / Math.max(0.0001, a.weightSum)),
      weight: Math.max(0.05, Math.min(0.9, a.weightSum / Math.max(1, items.length))),
    })) as ContextFeedItem["factors"];
  }, [activeSignalBundle]);

  const activeCompositeScore = useMemo(() => computeCompositeFromFactors(mergedBundleFactors), [mergedBundleFactors]);

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
  }, [refreshHeatmap]);

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

  // ── Run analysis ──────────────────────────────────────────────────────────

  const applyAnalysis = useCallback((data: PricingAnalyseResponse, heatmapSnapshot: HeatmapResponse | null) => {
    setPricing(data);
    setCustomRates({});
    setCommitted(null);
    const preSelected = new Set<string>();
    for (const row of data.calendar_rows) {
      for (const cell of row.cells) {
        if (cell.is_orphan) continue;
        if (heatmapSnapshot) {
          const hasEmpty = heatmapSnapshot.rows.some(
            r => String(r.category) === row.category && heatmapCellAt(r, cell.date)?.block_type === "EMPTY",
          );
          if (hasEmpty && cell.action !== "MAINTAIN") preSelected.add(`${row.category}::${cell.date}`);
        } else if (cell.action !== "MAINTAIN") {
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
      applyAnalysis(JSON.parse(raw) as PricingAnalyseResponse, heatmap);
      show("Loaded previous analysis", "success");
    } catch {
      show("Could not load cached analysis", "error");
    }
  }, [applyAnalysis, heatmap, show]);

  const runAnalysis = useCallback(async () => {
    setAnalysing(true);
    setPricing(null);
    setCommitted(null);
    setSelectedCells(new Set());
    setCustomRates({});
    try {
      if (!heatmap) {
        show("Heatmap not loaded yet — refresh and retry", "error");
        return;
      }

      const contextItems = [
        selectedItems.EVENT,
        selectedItems.WEATHER,
        selectedItems.TRAVEL,
        selectedItems.MARKET,
      ].filter(Boolean);

      const res = await analysePricingWithContext({
        context_items: contextItems,
        window_days: WINDOW_DAYS,
        empty_nights_only: true,
      });
      const aiData = res.data as PricingAnalyseResponse;
      const aiWindowed: PricingAnalyseResponse = {
        ...aiData,
        dates: (aiData.dates ?? []).slice(0, WINDOW_DAYS),
        calendar_rows: (aiData.calendar_rows ?? []).map(r => ({ ...r, cells: (r.cells ?? []).slice(0, WINDOW_DAYS) })),
      };

      const selectedBundle = [
        selectedItems.EVENT?.title,
        selectedItems.WEATHER?.title,
        selectedItems.TRAVEL?.title,
        selectedItems.MARKET?.title,
      ].filter(Boolean).join(" · ");

      // Keep AI rates/reasons, but:
      // - only allow actions on unsold nights (EMPTY exists in that category/date)
      // - emphasize sandwich nights
      // - overwrite tooltip factor strings with mocked contextFeed + mocked competitor pricing
      const nextCalendarRows = aiWindowed.calendar_rows.map(row => {
        const cells = row.cells.map(cell => {
          const stats = computeCategoryDayStats(heatmap.rows, cell.date, row.category);
          const isUnsold = stats.emptyRooms > 0;
          const isSandwich = stats.sandwichEmptyRooms > 0;

          const category = row.category as RoomCategory;
          const competitor = getCompetitorRatePoint({
            date: cell.date,
            category,
            baseRate: cell.current_rate || 0,
            marketHeat: activeCompositeScore,
          });

          const baseReason = cell.reason || "";
          const scopeReason = !isUnsold
            ? "On-books night — no clearance action."
            : isSandwich
              ? "Sandwich night gap detected. Clearance prioritized."
              : "Unsold inventory detected. Clearance eligible.";

          const mergedReason = `${scopeReason} ${baseReason}${selectedBundle ? ` Signals: ${selectedBundle}.` : ""}`.trim();

          if (!isUnsold) {
            return {
              ...cell,
              suggested_rate: cell.current_rate,
              change_pct: 0,
              action: "MAINTAIN" as const,
              reason: mergedReason,
              weather_factor: selectedItems.WEATHER?.detail ?? "",
              event_factor: selectedItems.EVENT?.detail ?? "",
              news_factor: `Competitor median $${competitor.competitorMedianRate} (P10 $${competitor.competitorP10Rate} · P90 $${competitor.competitorP90Rate}). ${competitor.sourceNote}`,
            };
          }

          // Unsold night: keep AI suggested_rate/confidence/reason, but replace factor strings.
          return {
            ...cell,
            reason: mergedReason,
            weather_factor: selectedItems.WEATHER?.detail ?? cell.weather_factor ?? "",
            event_factor: selectedItems.EVENT?.detail ?? cell.event_factor ?? "",
            news_factor: `Competitor median $${competitor.competitorMedianRate} (P10 $${competitor.competitorP10Rate} · P90 $${competitor.competitorP90Rate}). ${competitor.sourceNote}`,
          };
        });

        return { ...row, cells };
      });

      const nextRecommendations = nextCalendarRows.flatMap(r =>
        r.cells
          .filter(c => c.action !== "MAINTAIN")
          .map(c => ({
            category: r.category,
            date: c.date,
            current_rate: c.current_rate,
            suggested_rate: c.suggested_rate,
            change_pct: c.change_pct,
            action: c.action,
            confidence: c.confidence,
            reason: c.reason,
            occupancy_pct: c.occupancy_pct,
            otb: c.otb,
          })),
      );

      const data: PricingAnalyseResponse = {
        ...aiWindowed,
        summary: `${
          selectedBundle
            ? `Context (Overview): ${selectedBundle}.`
            : "Context (Overview): —"
        } AI generated the pricing recommendations in the calendar grid. ` +
        `Market research (competitor pricing) is demo data. ` +
        `(15-day window · filtered to unsold nights · context + competitor details in tooltip.)`,
        calendar_rows: nextCalendarRows,
        recommendations: nextRecommendations,
      };

      applyAnalysis(data, heatmap);
      try { localStorage.setItem(PRICING_CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
      setHasCached(true);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      show(detail ?? "Pricing analysis failed", "error");
    } finally {
      setAnalysing(false);
    }
  }, [applyAnalysis, show, heatmap, activeCompositeScore, selectedItems]);

  // ── Toggle cell selection ─────────────────────────────────────────────────

  const toggleCell = useCallback((category: string, date: string) => {
    const key = `${category}::${date}`;
    setSelectedCells(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!pricing || !heatmap) return;
    const all = new Set<string>();
    for (const row of pricing.calendar_rows) {
      for (const cell of row.cells) {
        if (cell.is_orphan) continue;
        const hasEmpty = heatmap.rows.some(
          r => String(r.category) === row.category && heatmapCellAt(r, cell.date)?.block_type === "EMPTY",
        );
        if (hasEmpty) all.add(`${row.category}::${cell.date}`);
      }
    }
    setSelectedCells(all);
  }, [pricing, heatmap]);

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
    <div className={overviewStackClass}>
      <Toasts />

      {/* Pillar 2: Marginal Revenue Capture */}
      <div className={`${overviewCardLgClass} p-6 sm:p-7`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className={overviewEyebrowClass}>Pillar 2</div>
            <div className={`${overviewSectionTitleClass} mt-1`}>Marginal Revenue Capture</div>
            <div className={overviewSubtitleClass}>
              Smart Clearance monetizes “sandwich nights” that cannot be physically moved, while protecting your price floor.
            </div>
          </div>
          <div className={overviewMutedBadgeClass}>
            Real-time elasticity · external shocks · A/B trade-offs (demo)
          </div>
        </div>
      </div>

      {/* Existing Pricing features (moved down) */}
      <div className={`${overviewCardLgClass} min-h-[600px] min-w-0 flex flex-col relative overflow-hidden p-0`}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-border/80 shrink-0 bg-surface-2/20 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <DollarSign className="w-4 h-4 text-accent" />
            <div>
              <div className="text-sm font-bold text-text flex items-center gap-2">
                RateIQ Pricing Optimization{" "}
                <AiTag title="AI synthesis runs only on dates with unsold rooms per category (faster). The grid lists rooms like Occupancy; only EMPTY nights show pricing cells — hover for current BAR, proposed rate, and why. Tooltip adds Overview context + demo competitor pricing." />
              </div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted font-bold">
                AI scoped to empty nights · 15-day window · room rows (empty slots only) · click to select for commit
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
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
        <div className="px-6 py-4 border-b border-border/80 grid grid-cols-2 lg:grid-cols-4 gap-3 bg-bg/40">
        {/* Card 1: Orphan Nights */}
        <div className={`${overviewCardClass} px-4 py-3.5`}>
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
        <div className={`${overviewCardClass} px-4 py-3.5`}>
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
        <div className={`${overviewCardClass} px-4 py-3.5`}>
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Active Discounts</div>
          <div className="text-3xl font-serif font-bold text-text mt-2">
            {cardStats ? cardStats.roomsDiscounted : <span className="text-text-muted">—</span>}
          </div>
          <div className="text-[10px] text-text-muted mt-1">Rooms below base rate · {WINDOW_DAYS}d window</div>
        </div>

        {/* Card 4: Revenue Rescue */}
        <div className={`${overviewCardClass} px-4 py-3.5 transition-colors ${
          pricing ? "!border-accent/35 bg-accent/[0.04]" : ""
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
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">

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
              generate a 15-day pricing calendar per room category (filtered to unsold nights).
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
              Analyzing unsold nights · building 15-day room grid
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
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">

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

            {/* Calendar grid: fills width — date columns flex equally; vertical scroll only */}
            <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto">
              <table
                className="w-full max-w-full border-collapse text-xs"
                style={{ tableLayout: "fixed" }}
              >
                <colgroup>
                  {(() => {
                    const roomPct = 11;
                    const datePct = (100 - roomPct) / pricing.dates.length;
                    return (
                      <>
                        <col style={{ width: `${roomPct}%` }} />
                        {pricing.dates.map(d => (
                          <col key={d} style={{ width: `${datePct}%` }} />
                        ))}
                      </>
                    );
                  })()}
                </colgroup>
                <thead className="sticky top-0 z-20 bg-surface">
                  <tr>
                    <th className="sticky left-0 z-30 bg-surface border-b border-r border-border px-2 py-1.5 text-left overflow-hidden">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                        Room
                      </span>
                    </th>
                    {pricing.dates.map(d => {
                      const { day, date: dateNum, isWeekend } = formatDateHeader(d);
                      return (
                        <th
                          key={d}
                          className={`border-b border-border/50 px-1 py-1.5 text-center overflow-hidden ${
                            isWeekend ? "bg-accent/5" : ""
                          }`}
                        >
                          <div className={`text-[9px] font-bold uppercase tracking-wider leading-tight ${
                            isWeekend ? "text-accent" : "text-text-muted"
                          }`}>{day}</div>
                          <div className="text-[11px] font-mono font-bold text-text leading-tight truncate">{dateNum}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {!heatmap ? (
                    pricing.calendar_rows.map(row => (
                      <tr key={row.category} className="border-b border-border/30">
                        <td className="sticky left-0 z-10 bg-surface border-r border-border px-2 py-0.5 whitespace-nowrap">
                          <span className="text-[9px] font-bold uppercase tracking-widest text-text">
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
                    ))
                  ) : pricing.calendar_rows.map(calRow => {
                    const cat = calRow.category;
                    const cellByDate = new Map(calRow.cells.map(c => [c.date, c]));
                    const roomRows = heatmap.rows.filter(
                      r => String(r.category) === cat && roomRowHasEmptyOnDates(r, pricing.dates),
                    );
                    return (
                      <Fragment key={cat}>
                        <tr className="bg-surface-2/60 border-b border-border">
                          <td
                            colSpan={pricing.dates.length + 1}
                            className="px-2 py-1 text-left"
                          >
                            <span className="text-[9px] font-black uppercase tracking-widest text-text">
                              {cat}
                            </span>
                          </td>
                        </tr>
                        {roomRows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={pricing.dates.length + 1}
                              className="px-2 py-2 text-[11px] text-text-muted border-b border-border/30"
                            >
                              No empty inventory in this category for the visible window.
                            </td>
                          </tr>
                        ) : (
                          roomRows.map(roomRow => (
                            <tr key={`${cat}-${roomRow.room_id}`} className="border-b border-border/25 hover:bg-surface-2/20">
                              <td className="sticky left-0 z-10 bg-surface border-r border-border px-2 py-0.5 overflow-hidden align-top">
                                <span className="text-[9px] font-mono font-bold text-text leading-none truncate block max-w-full" title={roomRow.room_id}>
                                  {roomRow.room_id}
                                </span>
                              </td>
                              {pricing.dates.map(d => {
                                const hc = heatmapCellAt(roomRow, d);
                                const catCell = cellByDate.get(d);
                                if (!hc || hc.block_type !== "EMPTY") {
                                  return (
                                    <td key={d} className="p-px bg-surface-2/20 align-top">
                                      <div className="w-full min-h-[29px] flex items-center justify-center rounded border border-border/30 text-[10px] text-text-muted/70 box-border">
                                        —
                                      </div>
                                    </td>
                                  );
                                }
                                if (!catCell) {
                                  return (
                                    <td key={d} className="p-px align-top">
                                      <div className="w-full min-h-[29px] flex items-center justify-center text-[10px] text-text-muted box-border">—</div>
                                    </td>
                                  );
                                }
                                const roomCell = mergeRoomPricingCell(catCell, hc.current_rate);
                                const selKey = `${cat}::${d}`;
                                return (
                                  <CalendarCellView
                                    key={d}
                                    cell={roomCell}
                                    selected={selectedCells.has(selKey)}
                                    onToggle={() => toggleCell(cat, d)}
                                    customRate={customRates[selKey]}
                                    onCustomRate={rate => {
                                      setCustomRates(prev => {
                                        const next = { ...prev };
                                        if (rate === null) delete next[selKey];
                                        else next[selKey] = rate;
                                        return next;
                                      });
                                    }}
                                  />
                                );
                              })}
                            </tr>
                          ))
                        )}
                      </Fragment>
                    );
                  })}
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
