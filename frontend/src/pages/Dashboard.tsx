import { useState, useCallback, useEffect, useMemo } from "react";
import { getHeatmap, getOccupancyForecast, api } from "../api/client";
import type { HeatmapResponse, OccupancyForecastResponse, RoomCategory } from "../types";
import { HeatmapGrid } from "../components/Heatmap/HeatmapGrid";
import { BirdseyeInventoryHighlights } from "../components/BirdseyeInventoryHighlights";
import { BirdseyeFilters, type BirdseyeWeekSpan } from "../components/BirdseyeFilters";
import { BirdseyeForecastInsights } from "../components/BirdseyeForecastInsights";
import { useToast } from "../components/shared/Toast";
import { computeEmptyRunInventory } from "../utils/inventoryAvailability";
import { Grid3x3, RefreshCw, Lock, Unlock } from "lucide-react";
import { addDays, formatISO, parseISO } from "date-fns";

const DEFAULT_BIRDSEYE_CATEGORIES: RoomCategory[] = ["STANDARD", "DELUXE", "SUITE"];

/**
 * Dashboard (Bird's Eye View): occupancy matrix and k-night bookable-window counts (overlapping, per EMPTY strip) by length and room category.
 * Uses `GET /dashboard/heatmap`; slot edits use the same admin slot patch as the manager heatmap.
 * Date span (defaults to three weeks) and room-type filters apply only on this page (client-side slice of the shared heatmap payload).
 */
export function Dashboard() {
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [forecast, setForecast] = useState<OccupancyForecastResponse | null>(null);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState<boolean>(false);
  const [isForecastLoading, setIsForecastLoading] = useState<boolean>(false);
  const [heatmapLoadError, setHeatmapLoadError] = useState<string | null>(null);
  const [weekSpan, setWeekSpan] = useState<BirdseyeWeekSpan>(3);
  const [selectedCategories, setSelectedCategories] = useState<RoomCategory[]>([...DEFAULT_BIRDSEYE_CATEGORIES]);
  const [slotModal, setSlotModal] = useState<{ id: string; room: string; date: string; block: string } | null>(null);
  const { show, Toasts } = useToast();

  const loadHeatmap = useCallback(async () => {
    setIsHeatmapLoading(true);
    setHeatmapLoadError(null);
    try {
      const h = await getHeatmap();
      setHeatmap(h.data);
    } catch {
      setHeatmap(null);
      setHeatmapLoadError("The occupancy matrix could not be loaded. Check the API connection, then try again.");
    }
    setIsHeatmapLoading(false);
  }, [show]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  const loadForecast = useCallback(async () => {
    if (!heatmap) return;
    setIsForecastLoading(true);
    try {
      const start = parseISO(heatmap.dates[0]);
      const end = addDays(start, Math.min(weekSpan * 7, heatmap.dates.length));
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const asOfStr = startStr;

      const res = await getOccupancyForecast({ start: startStr, end: endStr, as_of: asOfStr });
      setForecast(res.data);
    } catch {
      // Keep the dashboard functional even if analytics is unavailable.
      setForecast(null);
    }
    setIsForecastLoading(false);
  }, [heatmap, weekSpan]);

  useEffect(() => {
    loadForecast();
  }, [loadForecast]);

  /** Rows limited to categories selected in the filter bar (Standard / Deluxe / Suite). */
  const filteredRows = useMemo(() => {
    if (!heatmap) return [];
    const set = new Set(selectedCategories);
    return heatmap.rows.filter(row => set.has(row.category));
  }, [heatmap, selectedCategories]);

  /** Number of day columns shown; capped by what the API returned. */
  const spanDays = useMemo(() => {
    if (!heatmap) return 0;
    return Math.min(weekSpan * 7, heatmap.dates.length);
  }, [heatmap, weekSpan]);

  const snapshot = useMemo(() => {
    if (!heatmap) return null;
    return computeEmptyRunInventory(filteredRows, spanDays);
  }, [heatmap, filteredRows, spanDays]);

  /**
   * Toggles a room type chip; at least one type stays selected so the grid never has an ambiguous empty state.
   */
  const handleToggleCategory = useCallback((category: RoomCategory) => {
    setSelectedCategories(prev => {
      const on = prev.includes(category);
      if (on && prev.length === 1) return prev;
      if (on) return prev.filter(c => c !== category);
      const order: RoomCategory[] = ["STANDARD", "DELUXE", "SUITE"];
      return [...prev, category].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    });
  }, []);

  const handleSlotPatch = async (block_type: "EMPTY" | "HARD") => {
    if (!slotModal) return;
    try {
      await api.patch(`/admin/slots/${slotModal.id}`, {
        block_type,
        reason: "Manual edit from Bird's Eye View dashboard",
      });
      setSlotModal(null);
      await loadHeatmap();
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      show(typeof detail === "string" ? detail : "Cannot edit this slot", "error");
    }
  };

  return (
    <div>
      <Toasts />

      {slotModal && (
        <div className="fixed inset-0 bg-text/60 backdrop-blur-sm flex items-center justify-center z-[999]">
          <div className="bg-surface border border-border shadow-2xl p-6 w-full max-w-sm">
            <h2 className="font-serif font-bold text-xl text-text mb-2">Configure Slot</h2>
            <div className="text-sm text-text-muted mb-6 flex items-center gap-2">
              Room {slotModal.room} · {slotModal.date}
              <span
                className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 border ${
                  slotModal.block === "EMPTY"
                    ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                    : slotModal.block === "SOFT"
                      ? "bg-sky-100 text-sky-800 border-sky-300"
                      : "bg-stone-100 text-stone-700 border-stone-300"
                }`}
              >
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
                    type="button"
                    className="flex-1 bg-occugreen text-white text-sm font-semibold hover:bg-occugreen/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                    onClick={() => handleSlotPatch("EMPTY")}
                  >
                    <Unlock className="w-3.5 h-3.5" /> Free
                  </button>
                )}
                {slotModal.block !== "HARD" && (
                  <button
                    type="button"
                    className="flex-1 bg-text text-surface text-sm font-semibold hover:bg-text/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                    onClick={() => handleSlotPatch("HARD")}
                  >
                    <Lock className="w-3.5 h-3.5" /> Block
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="w-full bg-surface-2 text-text text-sm font-semibold hover:bg-border active:scale-95 py-2.5 transition-all border border-border"
              onClick={() => setSlotModal(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 border-b border-border/50 pb-6">
        <div>
          <h1 className="font-serif font-bold text-2xl text-text tracking-tight">Bird's Eye View</h1>
          <p className="text-xs tracking-wider text-text-muted mt-2 uppercase">
            Occupancy matrix and k-night bookable windows by length and room type
          </p>
        </div>
        <button
          type="button"
          className="self-start sm:self-auto bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-border shrink-0"
          onClick={() => loadHeatmap()}
        >
          <RefreshCw className="w-3.5 h-3.5 text-accent" /> Refresh data
        </button>
      </div>

      {heatmap && (
        <BirdseyeFilters
          weekSpan={weekSpan}
          onWeekSpanChange={setWeekSpan}
          selectedCategories={selectedCategories}
          onToggleCategory={handleToggleCategory}
        />
      )}

      {heatmap && (forecast || isForecastLoading) && (
        <div className="mt-6">
          {forecast ? (
            <BirdseyeForecastInsights forecast={forecast} selectedCategories={selectedCategories} />
          ) : (
            <div className="bg-surface border border-border shadow-subtle">
              <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-bold text-xs text-text uppercase tracking-widest">AI forecast</h3>
                  <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold">Loading</div>
                </div>
                <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">
                  Generating predictions from past pickup trends…
                </p>
              </div>
              <div className="p-3">
                <div className="h-10 bg-surface-2 border border-border/60 animate-pulse" />
              </div>
            </div>
          )}
        </div>
      )}

      {heatmap && snapshot && (
        <>
          {filteredRows.length === 0 ? (
            <div className="bg-surface border border-border py-12 px-6 text-center text-sm text-text-muted">
              No rooms match the selected types for this hotel.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-stretch mt-8">
              <div className="min-h-[320px] min-w-0">
                <div className="bg-surface border border-border p-4 sm:p-6 h-full overflow-x-auto">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={filteredRows}
                    title="Current Occupancy"
                    compact
                    maxDays={spanDays}
                    hideLegend
                    onCellClick={setSlotModal}
                  />
                </div>
              </div>
              <aside className="flex flex-col min-h-0">
                <BirdseyeInventoryHighlights snapshot={snapshot} maxDays={spanDays} />
              </aside>
            </div>
          )}
        </>
      )}

      {!heatmap && (
        <div className="bg-surface border border-border py-16 px-6 text-center">
          <Grid3x3 className="w-8 h-8 text-accent/50 mx-auto mb-4" />
          {isHeatmapLoading ? (
            <>
              <h2 className="text-xl font-serif font-bold text-text mb-2">Fetching calendar data</h2>
              <p className="text-xs text-text-muted font-medium mb-6 max-w-sm mx-auto leading-relaxed">
                Loading rooms and slots, then generating insights…
              </p>
              <div className="max-w-sm mx-auto">
                <div className="h-10 bg-surface-2 border border-border/60 animate-pulse" />
              </div>
            </>
          ) : (
            <>
              <h2 className="text-xl font-serif font-bold text-text mb-2">No calendar data</h2>
              <p className="text-xs text-text-muted font-medium mb-6 max-w-sm mx-auto leading-relaxed">
                {heatmapLoadError ?? "The occupancy matrix could not be loaded. Check the API connection, then try again."}
              </p>
              <button
                type="button"
                className="bg-text text-surface font-semibold hover:bg-text/90 text-xs uppercase tracking-widest px-8 py-3"
                onClick={() => loadHeatmap()}
              >
                Retry load
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
