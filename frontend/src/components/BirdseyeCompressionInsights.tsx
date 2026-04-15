import { useMemo } from "react";
import type { HeatmapRow } from "../types";

type TightDate = {
  date: string;
  remainingEmptyRooms: number;
  totalRooms: number;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Compression / sellout risk: based on remaining EMPTY rooms per date for the visible window.
 * This is intentionally "operational" (not predictive) and derived from the same heatmap data
 * the user is already acting on.
 */
export function BirdseyeCompressionInsights(props: {
  dates: string[];
  rows: HeatmapRow[];
  maxDays: number;
  tightThresholdRooms?: number;
}) {
  const { dates, rows, maxDays, tightThresholdRooms = 2 } = props;

  const tight = useMemo(() => {
    const span = Math.min(maxDays, dates.length);
    const totalRooms = rows.length;
    const byDate: TightDate[] = [];
    for (let i = 0; i < span; i++) {
      const date = dates[i];
      let remaining = 0;
      for (const r of rows) {
        const cell = r.cells[i];
        if (cell?.block_type === "EMPTY") remaining += 1;
      }
      byDate.push({ date, remainingEmptyRooms: remaining, totalRooms });
    }
    const tightDates = byDate.filter(d => d.remainingEmptyRooms <= tightThresholdRooms);
    const tightest = [...byDate].sort((a, b) => a.remainingEmptyRooms - b.remainingEmptyRooms);
    return { byDate, tightDates, tightest };
  }, [dates, rows, maxDays, tightThresholdRooms]);

  const headline = tight.tightDates.length
    ? `${tight.tightDates.length} tight date${tight.tightDates.length === 1 ? "" : "s"}`
    : "No tight dates";

  return (
    <div className="bg-surface border border-border shadow-subtle h-full">
      <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-bold text-xs text-text uppercase tracking-widest">Compression risk</h3>
          <div className="text-[9px] uppercase tracking-widest text-text-muted font-bold">
            ≤ {tightThresholdRooms} rooms left
          </div>
        </div>
        <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">{headline}</p>
      </div>

      <div className="p-3">
        {rows.length === 0 || maxDays === 0 ? (
          <div className="text-xs text-text-muted font-medium">No rooms/dates to analyze.</div>
        ) : (
          <div className="space-y-2">
            {tight.tightest.slice(0, 8).map(d => {
              const pctFull = d.totalRooms > 0 ? (1 - d.remainingEmptyRooms / d.totalRooms) * 100 : 0;
              const severity =
                d.remainingEmptyRooms <= tightThresholdRooms ? "bg-occuorange/15 border-occuorange/25" : "bg-surface-2/40 border-border/60";
              return (
                <div key={d.date} className={`border ${severity} px-3 py-2`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{d.date}</div>
                    <div className="text-[11px] font-black tabular-nums text-text">
                      {d.remainingEmptyRooms} left <span className="text-text-muted font-semibold">/ {d.totalRooms}</span>
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 bg-border/50">
                    <div
                      className="h-1.5 bg-text"
                      style={{ width: `${clamp(pctFull, 0, 100).toFixed(0)}%` }}
                      title={`${pctFull.toFixed(0)}% filled`}
                    />
                  </div>
                </div>
              );
            })}

            <div className="pt-1 text-[10px] text-text-muted font-semibold">
              Showing the tightest dates in the visible window (by remaining EMPTY rooms).
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

