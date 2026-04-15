import type { MouseEvent as ReactMouseEvent } from "react";
import { useMemo, useRef, useState } from "react";
import type { HeatmapRow } from "../types";

type TightDate = {
  date: string;
  remainingEmptyRooms: number;
  totalRooms: number;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function int(n: number) {
  return Math.round(n).toString();
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

  const { byDate, tightCount } = useMemo(() => {
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
    const tightCount = byDate.filter(d => d.remainingEmptyRooms <= tightThresholdRooms).length;
    return { byDate, tightCount };
  }, [dates, rows, maxDays, tightThresholdRooms]);

  const headline = tightCount
    ? `${tightCount} tight date${tightCount === 1 ? "" : "s"}`
    : "No tight dates";

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const w = 600;
  const h = 190;
  const padL = 36;
  const padR = 12;
  const padT = 10;
  const padB = 52;

  const xFor = (i: number) => {
    if (byDate.length <= 1) return padL;
    return padL + (i / (byDate.length - 1)) * (w - padL - padR);
  };

  const yMax = useMemo(() => {
    const vals: number[] = [];
    for (const p of byDate) vals.push(p.totalRooms);
    const m = vals.length ? Math.max(...vals) : 0;
    return Math.max(1, m);
  }, [byDate]);

  const yForRooms = (rooms: number) => {
    const y0 = padT;
    const y1 = h - padB;
    return y1 - (clamp(rooms, 0, yMax) / yMax) * (y1 - y0);
  };

  const hover = hoverIdx !== null ? byDate[hoverIdx] : null;

  const onMove = (e: ReactMouseEvent) => {
    const el = wrapRef.current;
    if (!el || byDate.length === 0) return;
    const rect = el.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const t = rect.width > 0 ? x / rect.width : 0;
    const idx = Math.round(t * (byDate.length - 1));
    setHoverIdx(clamp(idx, 0, byDate.length - 1));
  };

  const onLeave = () => setHoverIdx(null);

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
          <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={onLeave}>
            <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[190px] block">
              {/* y-grid */}
              {[0, 0.5, 1].map(t => {
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

              {/* threshold line */}
              <line
                x1={padL}
                y1={yForRooms(tightThresholdRooms)}
                x2={w - padR}
                y2={yForRooms(tightThresholdRooms)}
                stroke="rgba(249,115,22,0.65)"
                strokeDasharray="4 4"
                strokeWidth="1"
              />

              {/* bars: remaining empty rooms */}
              {byDate.map((d, i) => {
                const x = xFor(i);
                const barW = byDate.length > 1 ? Math.max(2, (w - padL - padR) / byDate.length - 2) : 10;
                const x0 = clamp(x - barW / 2, padL, w - padR - barW);
                const y = yForRooms(d.remainingEmptyRooms);
                const yBase = h - padB;
                const isTight = d.remainingEmptyRooms <= tightThresholdRooms;
                return (
                  <rect
                    key={d.date}
                    x={x0}
                    y={y}
                    width={barW}
                    height={Math.max(1, yBase - y)}
                    fill={isTight ? "rgba(249,115,22,0.55)" : "rgba(100,116,139,0.45)"}
                    stroke="none"
                  />
                );
              })}

              {/* hover marker */}
              {hoverIdx !== null && byDate.length > 0 && (
                <g>
                  <line
                    x1={xFor(hoverIdx)}
                    y1={padT}
                    x2={xFor(hoverIdx)}
                    y2={h - padB}
                    stroke="rgba(226,232,240,0.55)"
                    strokeWidth="1"
                  />
                </g>
              )}

              {/* x labels (all dates) */}
              {byDate.length > 0 && (
                <g>
                  {byDate.map((p, i) => (
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
                <span className="inline-block w-3 h-2" style={{ background: "rgba(100,116,139,0.45)" }} />
                Remaining empty
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-2" style={{ background: "rgba(249,115,22,0.55)" }} />
                Tight
              </div>
            </div>

            {/* tooltip */}
            {hover && hoverIdx !== null && (
              <div className="absolute right-2 top-2 bg-surface border border-border/70 shadow-subtle px-3 py-2 text-[11px]">
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{hover.date}</div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="text-text-muted font-semibold">Empty left</span>
                  <span className="text-text font-bold tabular-nums">{int(hover.remainingEmptyRooms)}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-3">
                  <span className="text-text-muted font-semibold">Total rooms</span>
                  <span className="text-text font-bold tabular-nums">{int(hover.totalRooms)}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

