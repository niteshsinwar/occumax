import type { OccupancyForecastResponse, RoomCategory } from "../types";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { calendarDayKey } from "../utils/calendarDayKey";

function int(n: number) {
  return Math.round(n).toString();
}

/** Signed difference for display (e.g. +12 or −7). */
// (removed: signedInt) — we no longer show vs-pred summary text in the card header.

type DailyDatum = {
  date: string;
  totalRooms: number;
  onBooksRooms: number | null;
  predictedRooms: number | null;
  predictedLowRooms: number | null;
  predictedHighRooms: number | null;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function buildDailySeriesFromPoints(points: OccupancyForecastResponse["series"][number]["points"]): DailyDatum[] {
  return points.map(p => {
    const onBooksRooms = typeof p.occupied_rooms_on_books === "number" ? p.occupied_rooms_on_books : null;
    const predictedRooms = typeof p.predicted_final_occ_pct === "number" ? (p.predicted_final_occ_pct / 100) * p.total_rooms : null;
    const lo = p.predicted_final_occ_low_pct;
    const hi = p.predicted_final_occ_high_pct;
    const predictedLowRooms =
      typeof lo === "number" && typeof hi === "number"
        ? (Math.min(lo, hi) / 100) * p.total_rooms
        : typeof lo === "number"
          ? (lo / 100) * p.total_rooms
          : null;
    const predictedHighRooms =
      typeof lo === "number" && typeof hi === "number"
        ? (Math.max(lo, hi) / 100) * p.total_rooms
        : typeof hi === "number"
          ? (hi / 100) * p.total_rooms
          : null;
    return {
      date: p.date,
      totalRooms: p.total_rooms,
      onBooksRooms,
      predictedRooms,
      predictedLowRooms,
      predictedHighRooms,
    };
  });
}

function buildDailySeriesFromSelectedSeries(series: OccupancyForecastResponse["series"], selected: RoomCategory[]): DailyDatum[] {
  const set = new Set(selected);
  const selectedSeries = series.filter(s => s.category !== null && set.has(s.category));
  const byDate = new Map<
    string,
    { totalRooms: number; onBooksRooms: number; predictedRooms: number; lowRooms: number; highRooms: number; hasPred: boolean; hasBand: boolean }
  >();

  for (const s of selectedSeries) {
    for (const p of s.points) {
      const row =
        byDate.get(p.date) ??
        { totalRooms: 0, onBooksRooms: 0, predictedRooms: 0, lowRooms: 0, highRooms: 0, hasPred: false, hasBand: false };

      row.totalRooms += p.total_rooms;
      row.onBooksRooms += p.occupied_rooms_on_books ?? 0;

      if (typeof p.predicted_final_occ_pct === "number") {
        row.predictedRooms += (p.predicted_final_occ_pct / 100) * p.total_rooms;
        row.hasPred = true;
      }

      const lo = p.predicted_final_occ_low_pct;
      const hi = p.predicted_final_occ_high_pct;
      if (typeof lo === "number" && typeof hi === "number") {
        row.lowRooms += (Math.min(lo, hi) / 100) * p.total_rooms;
        row.highRooms += (Math.max(lo, hi) / 100) * p.total_rooms;
        row.hasBand = true;
      }

      byDate.set(p.date, row);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, row]) => ({
      date,
      totalRooms: row.totalRooms,
      onBooksRooms: row.onBooksRooms,
      predictedRooms: row.hasPred ? row.predictedRooms : null,
      predictedLowRooms: row.hasBand ? row.lowRooms : null,
      predictedHighRooms: row.hasBand ? row.highRooms : null,
    }));
}

/**
 * Restricts forecast daily points to the same calendar nights as the visible heatmap columns.
 */
function filterDailyToVisibleKeys(daily: DailyDatum[], visibleKeys: string[]): DailyDatum[] {
  if (!visibleKeys.length) return daily;
  const allowed = new Set(visibleKeys);
  const next = daily.filter(d => allowed.has(calendarDayKey(d.date)));
  return next.length ? next : daily;
}

/**
 * Capacity-weighted averages for the visible window; predicted low/high use per-day min/max
 * of API band fields so window totals never invert after aggregation.
 */
// (unused on dashboard now) computeWindowSummary removed.

function ForecastLinesChart(props: { data: DailyDatum[] }) {
  const { data } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const w = 600;
  const h = 190;
  const padL = 36;
  const padR = 12;
  const padT = 10;
  const padB = 52;

  const xFor = (i: number) => {
    if (data.length <= 1) return padL;
    return padL + (i / (data.length - 1)) * (w - padL - padR);
  };

  const yMax = useMemo(() => {
    const vals: number[] = [];
    for (const p of data) {
      vals.push(p.totalRooms);
      if (typeof p.onBooksRooms === "number") vals.push(p.onBooksRooms);
      if (typeof p.predictedRooms === "number") vals.push(p.predictedRooms);
      if (typeof p.predictedHighRooms === "number") vals.push(p.predictedHighRooms);
    }
    const m = vals.length ? Math.max(...vals) : 0;
    return Math.max(1, Math.ceil(m / 5) * 5);
  }, [data]);

  const yForRooms = (rooms: number) => {
    const y0 = padT;
    const y1 = h - padB;
    return y1 - (clamp(rooms, 0, yMax) / yMax) * (y1 - y0);
  };

  const paths = useMemo(() => {
    const linePath = (key: keyof Pick<DailyDatum, "onBooksRooms" | "predictedRooms">) => {
      let d = "";
      let started = false;
      for (let i = 0; i < data.length; i++) {
        const v = data[i][key];
        if (typeof v !== "number") {
          started = false;
          continue;
        }
        const x = xFor(i);
        const y = yForRooms(v);
        if (!started) {
          d += `M ${x.toFixed(2)} ${y.toFixed(2)} `;
          started = true;
        } else {
          d += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
        }
      }
      return d.trim();
    };

    // Band area path (high forward, low backward) for contiguous defined points.
    let band = "";
    const defined = data
      .map((p, i) => ({ i, lo: p.predictedLowRooms, hi: p.predictedHighRooms }))
      .filter(p => typeof p.lo === "number" && typeof p.hi === "number");
    if (defined.length) {
      const top = defined.map(p => `L ${xFor(p.i).toFixed(2)} ${yForRooms(p.hi as number).toFixed(2)}`).join(" ");
      const bot = [...defined]
        .reverse()
        .map(p => `L ${xFor(p.i).toFixed(2)} ${yForRooms(p.lo as number).toFixed(2)}`)
        .join(" ");
      const first = defined[0];
      band = `M ${xFor(first.i).toFixed(2)} ${yForRooms(first.hi as number).toFixed(2)} ${top} ${bot} Z`;
      band = band.replace(/^M [^ ]+ [^ ]+ L /, "M "); // avoid a redundant first L
    }

    return {
      band,
      onBooks: linePath("onBooksRooms"),
      predicted: linePath("predictedRooms"),
    };
  }, [data, yMax]);

  const hover = hoverIdx !== null ? data[hoverIdx] : null;

  const onMove = (e: ReactMouseEvent) => {
    const el = wrapRef.current;
    if (!el || data.length === 0) return;
    const rect = el.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const t = rect.width > 0 ? x / rect.width : 0;
    const idx = Math.round(t * (data.length - 1));
    setHoverIdx(clamp(idx, 0, data.length - 1));
  };

  const onLeave = () => setHoverIdx(null);

  return (
    <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={onLeave}>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[190px] block">
        {/* y-grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
          const v = Math.round(yMax * t);
          return (
            <g key={v}>
              <line x1={padL} y1={yForRooms(v)} x2={w - padR} y2={yForRooms(v)} stroke="rgba(148,163,184,0.25)" strokeWidth="1" />
              <text x={padL - 8} y={yForRooms(v) + 4} textAnchor="end" fontSize="10" fill="rgba(148,163,184,0.9)" fontWeight="700">
                {v}
              </text>
            </g>
          );
        })}

        {/* band */}
        {paths.band && <path d={paths.band} fill="rgba(59,130,246,0.12)" stroke="none" />}

        {/* lines */}
        {paths.predicted && <path d={paths.predicted} fill="none" stroke="rgba(59,130,246,0.95)" strokeWidth="2.25" />}
        {paths.onBooks && <path d={paths.onBooks} fill="none" stroke="rgba(16,185,129,0.95)" strokeWidth="2.25" />}

        {/* hover marker */}
        {hoverIdx !== null && data.length > 0 && (
          <g>
            <line
              x1={xFor(hoverIdx)}
              y1={padT}
              x2={xFor(hoverIdx)}
              y2={h - padB}
              stroke="rgba(226,232,240,0.55)"
              strokeWidth="1"
            />
            {typeof data[hoverIdx].predictedRooms === "number" && (
              <circle cx={xFor(hoverIdx)} cy={yForRooms(data[hoverIdx].predictedRooms as number)} r="3.5" fill="rgba(59,130,246,0.95)" />
            )}
            {typeof data[hoverIdx].onBooksRooms === "number" && (
              <circle cx={xFor(hoverIdx)} cy={yForRooms(data[hoverIdx].onBooksRooms as number)} r="3.5" fill="rgba(16,185,129,0.95)" />
            )}
          </g>
        )}

        {/* x labels (all dates) */}
        {data.length > 0 && (
          <g>
            {data.map((p, i) => (
              <text
                key={i}
                x={xFor(i)}
                y={h - 8}
                textAnchor="end"
                fontSize="9"
                fill="rgba(148,163,184,0.9)"
                fontWeight="700"
                transform={`rotate(-45 ${xFor(i)} ${h - 8})`}
              >
                {p.date}
              </text>
            ))}
          </g>
        )}
      </svg>

      {/* legend */}
      <div className="mt-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-text-muted">
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-0.5" style={{ background: "rgba(16,185,129,0.95)" }} />
          On books
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-0.5" style={{ background: "rgba(59,130,246,0.95)" }} />
          Pred final
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-2" style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)" }} />
          Pred band
        </div>
      </div>

      {/* tooltip */}
      {hover && hoverIdx !== null && (
        <div className="absolute right-2 top-2 bg-surface border border-border/70 shadow-subtle px-3 py-2 text-[11px]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{hover.date}</div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="text-text-muted font-semibold">On books</span>
            <span className="text-text font-bold tabular-nums">{typeof hover.onBooksRooms === "number" ? int(hover.onBooksRooms) : "n/a"}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-3">
            <span className="text-text-muted font-semibold">Pred final</span>
            <span className="text-text font-bold tabular-nums">{typeof hover.predictedRooms === "number" ? int(hover.predictedRooms) : "n/a"}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-3">
            <span className="text-text-muted font-semibold">Total rooms</span>
            <span className="text-text font-bold tabular-nums">{int(hover.totalRooms)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Occupancy forecast cards: on books vs predicted final with a per-day chart and band.
 */
export function BirdseyeForecastInsights(props: {
  forecast: OccupancyForecastResponse;
  selectedCategories: RoomCategory[];
  /** YYYY-MM-DD keys for heatmap columns in view (week span); chart and summary follow this window. */
  visibleForecastDateKeys: string[];
}) {
  const { forecast, selectedCategories, visibleForecastDateKeys } = props;

  const selectedDaily = useMemo(() => buildDailySeriesFromSelectedSeries(forecast.series, selectedCategories), [forecast.series, selectedCategories]);
  const fallbackDaily = useMemo(() => buildDailySeriesFromPoints(forecast.series.find(s => s.category === null)?.points ?? []), [forecast.series]);

  const daily = useMemo(() => {
    const merged = selectedDaily.length ? selectedDaily : fallbackDaily;
    return filterDailyToVisibleKeys(merged, visibleForecastDateKeys);
  }, [selectedDaily, fallbackDaily, visibleForecastDateKeys]);

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
      </div>

      <div className="p-3">
        <div className="border border-border/70 rounded-sm overflow-hidden bg-surface">
          <div className="flex items-center justify-between px-3 py-2 bg-surface-2/50 border-b border-border/50 gap-2">
            <span className="text-[10px] font-bold text-text uppercase tracking-widest">Selected types</span>
            <span
              className="text-[10px] font-black tabular-nums text-text text-right shrink-0"
              title="Room categories in the filter and number of nights in the selected week span."
            >
              {selectedCategories.length} type{selectedCategories.length === 1 ? "" : "s"}
              {visibleForecastDateKeys.length > 0 ? ` · ${visibleForecastDateKeys.length} night${visibleForecastDateKeys.length === 1 ? "" : "s"}` : ""}
            </span>
          </div>

          <div className="px-3 py-2">
            <ForecastLinesChart data={daily} />
          </div>
        </div>
      </div>
    </div>
  );
}

