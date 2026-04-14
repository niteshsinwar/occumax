import type { OccupancyForecastResponse, RoomCategory } from "../types";

function pct(n: number) {
  return `${n.toFixed(0)}%`;
}

function avg(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function computeWindowSummary(series: OccupancyForecastResponse["series"][number]) {
  const expectedAvg = avg(series.points.map(p => p.expected_occ_pct));
  const onBooksAvg = avg(series.points.map(p => (p.occupied_rooms_on_books ?? 0) / Math.max(1, p.total_rooms) * 100));
  const delta = onBooksAvg - expectedAvg;
  return { expectedAvg, onBooksAvg, delta };
}

export function BirdseyeForecastInsights(props: {
  forecast: OccupancyForecastResponse;
  selectedCategories: RoomCategory[];
}) {
  const { forecast, selectedCategories } = props;
  const set = new Set(selectedCategories);

  const rows = forecast.series
    .filter(s => s.category === null || set.has(s.category))
    .map(s => {
      const summary = computeWindowSummary(s);
      return { series: s, ...summary };
    })
    .sort((a, b) => (a.series.category === null ? 1 : 0) - (b.series.category === null ? 1 : 0));

  return (
    <div className="bg-surface border border-border p-4 sm:p-6">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="font-serif font-bold text-lg text-text tracking-tight">Forecast & pace (beta)</h2>
        <div className="text-[10px] uppercase tracking-widest text-text-muted font-semibold">
          as of {forecast.as_of}
        </div>
      </div>

      <div className="space-y-3">
        {rows.map(r => {
          const label = r.series.category ?? "ALL";
          const ahead = r.delta >= 0;
          return (
            <div key={label} className="border border-border/60 bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-bold tracking-widest uppercase text-text">
                  {label}
                </div>
                <div className={`text-xs font-bold ${ahead ? "text-occugreen" : "text-occuorange"}`}>
                  {ahead ? "AHEAD" : "BEHIND"} {pct(Math.abs(r.delta))}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="bg-surface border border-border/60 p-2">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-semibold">Expected</div>
                  <div className="font-semibold text-text">{pct(r.expectedAvg)}</div>
                </div>
                <div className="bg-surface border border-border/60 p-2">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted font-semibold">On the books</div>
                  <div className="font-semibold text-text">{pct(r.onBooksAvg)}</div>
                </div>
              </div>
            </div>
          );
        })}

        {rows.length === 0 && (
          <div className="text-xs text-text-muted">No forecast data for the selected room types.</div>
        )}
      </div>
    </div>
  );
}

