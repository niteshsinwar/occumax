import type { OccupancyForecastResponse, RoomCategory } from "../types";

function pct(n: number) {
  return `${n.toFixed(0)}%`;
}

function sum(nums: number[]) {
  return nums.reduce((a, b) => a + b, 0);
}

function computeWindowSummary(points: OccupancyForecastResponse["series"][number]["points"]) {
  if (points.length === 0) return { expectedAvg: 0, onBooksAvg: 0, delta: 0 };

  const totalRooms = sum(points.map(p => p.total_rooms));
  const expectedRooms = sum(points.map(p => (p.expected_occ_pct / 100) * p.total_rooms));
  const onBooksRooms = sum(points.map(p => p.occupied_rooms_on_books ?? 0));

  const expectedAvg = (expectedRooms / Math.max(1, totalRooms)) * 100;
  const onBooksAvg = (onBooksRooms / Math.max(1, totalRooms)) * 100;
  const delta = onBooksAvg - expectedAvg;
  return { expectedAvg, onBooksAvg, delta };
}

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

  const cards: { label: string; expectedAvg: number; onBooksAvg: number; delta: number }[] = [];
  cards.push({ label: "ALL", ...rollupSummary });
  if (selectedSeries.length > 0) {
    cards.push({ label: "SELECTED_TYPES", ...selectedSummary });
  }

  return (
    <div className="bg-surface border border-border shadow-subtle">
      <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-serif font-bold text-sm text-text">Forecast & pace</h3>
          <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold">
            as of {forecast.as_of}
          </div>
        </div>
        <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">
          On-the-books vs expected for selected horizon (beta)
        </p>
      </div>

      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map(c => {
          const ahead = c.delta >= 0;
          return (
            <div key={c.label} className="border border-border/70 rounded-sm overflow-hidden bg-surface">
              <div className="flex items-center justify-between px-3 py-2 bg-surface-2/50 border-b border-border/50">
                <span className="text-[10px] font-bold text-text uppercase tracking-wider">
                  {c.label === "SELECTED_TYPES" ? "Selected types" : "All rooms"}
                </span>
                <span className={`text-[10px] font-black tabular-nums ${ahead ? "text-occugreen" : "text-occuorange"}`}>
                  {ahead ? "AHEAD" : "BEHIND"} {pct(Math.abs(c.delta))}
                </span>
              </div>

              <div className="px-3 py-2 flex items-center justify-between gap-3 text-[11px]">
                <div className="text-text-muted font-semibold uppercase tracking-wider text-[9px]">
                  Expected <span className="text-text font-bold normal-case tracking-normal text-[11px] ml-1">{pct(c.expectedAvg)}</span>
                </div>
                <div className="text-text-muted font-semibold uppercase tracking-wider text-[9px]">
                  On books <span className="text-text font-bold normal-case tracking-normal text-[11px] ml-1">{pct(c.onBooksAvg)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

