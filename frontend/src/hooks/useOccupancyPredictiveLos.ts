import { useCallback, useState } from "react";
import { addDays, formatISO, parseISO } from "date-fns";
import { dashboardOptimiseKNightPreview, dashboardPredictOptimalLos } from "../api/client";
import type { HeatmapResponse, PredictOptimalLosResponse, RoomCategory, SwapStep } from "../types";

/** Visible columns on the Occupancy heatmap (pillar 1 UX). */
export const OCCUPANCY_HEATMAP_VISIBLE_DAYS = 15;

type ToastVariant = "success" | "error" | "info";

/**
 * Poly AI optimal LOS fetch + k-night shuffle preview scoped to the occupancy window.
 * Keeps the Occupancy tab aligned with AI-recommended target nights for Preview Recovery Shuffle.
 */
export function useOccupancyPredictiveLos(params: {
  heatmap: HeatmapResponse | null;
  selectedCategories: RoomCategory[];
  kNightNights: number;
  setKNightNights: (n: number) => void;
  setKNightSwapPlan: (p: SwapStep[] | null) => void;
  setSwapPlan: (p: SwapStep[] | null) => void;
  refreshScorecard: (plan: SwapStep[] | null) => Promise<void>;
  show: (msg: string, variant: ToastVariant) => void;
  setKNightLoading: (v: boolean) => void;
}) {
  const {
    heatmap,
    selectedCategories,
    kNightNights,
    setKNightNights,
    setKNightSwapPlan,
    setSwapPlan,
    refreshScorecard,
    show,
    setKNightLoading,
  } = params;

  const [predictiveLos, setPredictiveLos] = useState<PredictOptimalLosResponse | null>(null);
  const [predictiveLosLoading, setPredictiveLosLoading] = useState(false);
  const [predictiveLosError, setPredictiveLosError] = useState<string | null>(null);
  /** First Poly AI fetch finished for this tab session (success or error). */
  const [predictiveLosReady, setPredictiveLosReady] = useState(false);

  const reloadPredictiveLos = useCallback(async () => {
    if (!heatmap || selectedCategories.length === 0) return;
    setPredictiveLosLoading(true);
    setPredictiveLosReady(false);
    setPredictiveLosError(null);
    try {
      const start = parseISO(String(heatmap.dates[0]));
      const days = Math.min(OCCUPANCY_HEATMAP_VISIBLE_DAYS, heatmap.dates.length);
      const end = addDays(start, days);
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const res = await dashboardPredictOptimalLos({
        start: startStr,
        end: endStr,
        categories: selectedCategories,
      });
      const body = res.data as PredictOptimalLosResponse;
      setPredictiveLos(body);
      const rec = Math.max(1, Math.min(14, Math.floor(body.recommended_los_nights || 3)));
      setKNightNights(rec);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setPredictiveLos(null);
      setPredictiveLosError(typeof detail === "string" ? detail : "Could not load predictive LOS recommendation.");
      show("Predictive LOS unavailable — shuffle will fall back to manual k-night value.", "error");
    } finally {
      setPredictiveLosLoading(false);
      setPredictiveLosReady(true);
    }
  }, [heatmap, selectedCategories, setKNightNights, show]);

  const clearOccupancyShufflePreview = useCallback(() => {
    setKNightSwapPlan(null);
    setSwapPlan(null);
    void refreshScorecard(null);
  }, [refreshScorecard, setKNightSwapPlan, setSwapPlan]);

  const runOccupancyShufflePreview = useCallback(async () => {
    if (!heatmap || selectedCategories.length === 0) return;
    setKNightLoading(true);
    setSwapPlan(null);
    setKNightSwapPlan(null);
    try {
      const start = parseISO(String(heatmap.dates[0]));
      const days = Math.min(OCCUPANCY_HEATMAP_VISIBLE_DAYS, heatmap.dates.length);
      const end = addDays(start, days);
      const startStr = formatISO(start, { representation: "date" });
      const endStr = formatISO(end, { representation: "date" });
      const targetNights = Math.max(
        1,
        Math.min(14, predictiveLos?.recommended_los_nights ?? kNightNights),
      );
      setKNightNights(targetNights);
      const res = await dashboardOptimiseKNightPreview({
        start: startStr,
        end: endStr,
        categories: selectedCategories,
        target_nights: targetNights,
      });
      const body = res.data as { shuffle_count: number; swap_plan: SwapStep[]; target_nights: number };
      setKNightSwapPlan(body.swap_plan ?? []);
      void refreshScorecard(body.swap_plan ?? null);
      if ((body.swap_plan?.length ?? 0) === 0) {
        show(`No recovery shuffle improvements for k=${body.target_nights} in this ${days}-night window.`, "info");
      } else {
        show(`Preview ready (AI LOS k=${body.target_nights}): ${body.shuffle_count} shuffle steps`, "success");
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { detail?: string; error?: string } } };
      const detail = e?.response?.data?.detail ?? e?.response?.data?.error;
      const status = e?.response?.status;
      const msg =
        typeof detail === "string"
          ? `Recovery shuffle preview failed (${status ?? "?"}): ${detail}`
          : `Recovery shuffle preview failed (${status ?? "?"})`;
      show(msg, "error");
      setKNightSwapPlan(null);
      void refreshScorecard(null);
    } finally {
      setKNightLoading(false);
    }
  }, [
    heatmap,
    selectedCategories,
    predictiveLos?.recommended_los_nights,
    kNightNights,
    setKNightLoading,
    setKNightNights,
    setKNightSwapPlan,
    setSwapPlan,
    refreshScorecard,
    show,
  ]);

  return {
    predictiveLos,
    predictiveLosLoading,
    predictiveLosError,
    predictiveLosReady,
    reloadPredictiveLos,
    clearOccupancyShufflePreview,
    runOccupancyShufflePreview,
  };
}
