import type { OccupancyForecastResponse, RoomCategory } from "../types";

function pct(n: number) {
  return `${n.toFixed(0)}%`;
}

/** Signed difference for display (e.g. +2% or −3%). */
function signedPct(diff: number) {
  if (diff > 0) return `+${diff.toFixed(0)}%`;
  if (diff < 0) return `−${Math.abs(diff).toFixed(0)}%`;
  return "0%";
}

function sum(nums: number[]) {
  return nums.reduce((a, b) => a + b, 0);
}

/**
 * Capacity-weighted averages for the visible window; predicted low/high use per-day min/max
 * of API band fields so window totals never invert after aggregation.
 */
function computeWindowSummary(points: OccupancyForecastResponse["series"][number]["points"]) {
  if (points.length === 0) {
    return { onBooksAvg: 0, predictedFinalAvg: 0, predictedLowAvg: 0, predictedHighAvg: 0, likelihood: null as number | null };
  }

  const totalRooms = sum(points.map(p => p.total_rooms));
  const onBooksRooms = sum(points.map(p => p.occupied_rooms_on_books ?? 0));

  const onBooksAvg = (onBooksRooms / Math.max(1, totalRooms)) * 100;

  const predMeanRooms = sum(points.map(p => ((p.predicted_final_occ_pct ?? 0) / 100) * p.total_rooms));
  // Per day, API may label low/high before normalization; always take min/max of the band in % space.
  const predLowRooms = sum(
    points.map(p => {
      const lo = p.predicted_final_occ_low_pct ?? 0;
      const hi = p.predicted_final_occ_high_pct ?? 0;
      return (Math.min(lo, hi) / 100) * p.total_rooms;
    }),
  );
  const predHighRooms = sum(
    points.map(p => {
      const lo = p.predicted_final_occ_low_pct ?? 0;
      const hi = p.predicted_final_occ_high_pct ?? 0;
      return (Math.max(lo, hi) / 100) * p.total_rooms;
    }),
  );

  const predictedFinalAvg = (predMeanRooms / Math.max(1, totalRooms)) * 100;
  const predictedLowAvg = Math.min(100, Math.max(0, (predLowRooms / Math.max(1, totalRooms)) * 100));
  const predictedHighAvg = Math.min(100, Math.max(0, (predHighRooms / Math.max(1, totalRooms)) * 100));

  const likes = points.map(p => p.predicted_final_likelihood_pct).filter((n): n is number => typeof n === "number");
  const likelihood = likes.length ? sum(likes) / likes.length : null;

  return { onBooksAvg, predictedFinalAvg, predictedLowAvg, predictedHighAvg, likelihood };
}

/**
 * Occupancy forecast cards: on books vs predicted final, signed vs-pred gap, pred band, heuristic score.
 */
export function BirdseyeForecastInsights(props: {
  forecast: OccupancyForecastResponse;
  selectedCategories: RoomCategory[];
}) {
  const { forecast, selectedCategories } = props;
  const set = new Set(selectedCategories);

  const rollup = forecast.series.find(s => s.category === null) ?? null;
  const selectedSeries = forecast.series.filter(s => s.category !== null && set.has(s.category));

  const rollupSummary = computeWindowSummary(rollup?.points ?? []);
  const selectedSummary = computeWindowSummary(selectedSeries.flatMap(s => s.points));

  const cards: {
    label: string;
    onBooksAvg: number;
    predictedFinalAvg: number;
    predictedLowAvg: number;
    predictedHighAvg: number;
    likelihood: number | null;
  }[] = [];
  cards.push({ label: "ALL", ...rollupSummary });
  if (selectedSeries.length > 0) {
    cards.push({ label: "SELECTED_TYPES", ...selectedSummary });
  }

  return (
    <div className="bg-surface border border-border shadow-subtle">
      <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-bold text-xs text-text uppercase tracking-widest">AI forecast</h3>
          <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold">
            as of {forecast.as_of}
          </div>
        </div>
        <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">
          Pred final compares today’s calendar (slots) to same calendar dates ~1y and ~2y ago at the same lead time.
        </p>
        <p className="text-[9px] text-text-muted normal-case tracking-normal font-medium mt-1 leading-relaxed">
          “Score” is how closely those two prior years agree (55/70/85), not a statistical probability.
        </p>
      </div>

      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map(c => {
          // Positive = on books above predicted final (ahead of / beating the simple model).
          const vsForecastPp = c.onBooksAvg - c.predictedFinalAvg;
          const likelihoodLabel =
            typeof c.likelihood === "number" ? `score ${Math.round(c.likelihood)}` : "score n/a";
          return (
            <div key={c.label} className="border border-border/70 rounded-sm overflow-hidden bg-surface">
              <div className="flex items-center justify-between px-3 py-2 bg-surface-2/50 border-b border-border/50 gap-2">
                <span className="text-[10px] font-bold text-text uppercase tracking-widest">
                  {c.label === "SELECTED_TYPES" ? "Selected types" : "All rooms"}
                </span>
                <span
                  className="text-[10px] font-black tabular-nums text-text text-right shrink-0"
                  title="On books minus pred final; + means ahead of the model."
                >
                  vs pred {signedPct(vsForecastPp)}
                </span>
              </div>

              <div className="px-3 py-2 flex items-center justify-between gap-3 text-[11px]">
                <div className="text-text-muted font-semibold uppercase tracking-wider text-[9px]">
                  On books <span className="text-text font-bold normal-case tracking-normal text-[11px] ml-1">{pct(c.onBooksAvg)}</span>
                </div>
                <div className="text-text-muted font-semibold uppercase tracking-wider text-[9px]">
                  Pred final{" "}
                  <span className="text-text font-bold normal-case tracking-normal text-[11px] ml-1">
                    {pct(c.predictedFinalAvg)}
                  </span>
                </div>
              </div>

              <div className="px-3 pb-2 text-[10px] text-text-muted font-semibold">
                Pred band {pct(c.predictedLowAvg)}–{pct(c.predictedHighAvg)} · {likelihoodLabel}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

