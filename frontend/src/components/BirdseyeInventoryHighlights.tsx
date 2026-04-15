import type { ReactNode } from "react";
import type { RoomCategory } from "../types";
import {
  BIRDSEYE_DISPLAY_BUCKET_ORDER,
  CATEGORY_ORDER,
  type AvailabilityBucket,
  type EmptyRunInventorySnapshot,
} from "../utils/inventoryAvailability";

const BUCKET_LABELS: Record<AvailabilityBucket, string> = {
  "1": "1 night",
  "2": "2 nights",
  "3": "3 nights",
  "4": "4 nights",
  "4+": "4+ nights",
};

/** Fill colors for donut segments (theme-aligned; matches prior bar emphasis). */
const CATEGORY_DONUT_FILL: Partial<Record<RoomCategory, string>> = {
  STANDARD: "rgba(44, 27, 24, 0.35)",
  STUDIO: "rgba(197, 160, 89, 0.55)",
  DELUXE: "rgba(21, 71, 52, 0.55)",
  SUITE: "rgba(166, 106, 56, 0.6)",
  PREMIUM: "#c5a059",
  ECONOMY: "rgba(120, 113, 108, 0.55)",
};

const DONUT_CX = 50;
const DONUT_CY = 50;
const DONUT_R_OUTER = 38;
const DONUT_R_INNER = 22;

/**
 * Converts polar coordinates to SVG Cartesian (0° = top).
 */
function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/**
 * Builds an SVG path for one donut slice between two angles (degrees, clockwise from top).
 */
function donutSlicePath(
  startAngle: number,
  endAngle: number,
  outerR: number,
  innerR: number,
  cx: number,
  cy: number,
) {
  const outerStart = polarToCartesian(cx, cy, outerR, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return [
    "M",
    outerStart.x,
    outerStart.y,
    "A",
    outerR,
    outerR,
    0,
    largeArc,
    0,
    outerEnd.x,
    outerEnd.y,
    "L",
    innerEnd.x,
    innerEnd.y,
    "A",
    innerR,
    innerR,
    0,
    largeArc,
    1,
    innerStart.x,
    innerStart.y,
    "Z",
  ].join(" ");
}

/**
 * Renders SVG path elements for a category breakdown donut (handles a single full ring).
 */
function buildDonutSliceElements(
  categoriesPresent: RoomCategory[],
  breakdown: Partial<Record<RoomCategory, number>>,
  total: number,
): ReactNode[] {
  const paths: ReactNode[] = [];
  let startAngle = 0;
  for (const cat of categoriesPresent) {
    const n = breakdown[cat] ?? 0;
    if (n <= 0) continue;
    const sweep = (n / total) * 360;
    const fill = CATEGORY_DONUT_FILL[cat] ?? "rgba(44, 27, 24, 0.3)";
    if (sweep >= 359.5) {
      paths.push(
        <path
          key={`${cat}-h1`}
          d={donutSlicePath(0, 180, DONUT_R_OUTER, DONUT_R_INNER, DONUT_CX, DONUT_CY)}
          fill={fill}
          stroke="#ffffff"
          strokeWidth={0.35}
        />,
        <path
          key={`${cat}-h2`}
          d={donutSlicePath(180, 360, DONUT_R_OUTER, DONUT_R_INNER, DONUT_CX, DONUT_CY)}
          fill={fill}
          stroke="#ffffff"
          strokeWidth={0.35}
        />,
      );
      return paths;
    }
    paths.push(
      <path
        key={cat}
        d={donutSlicePath(startAngle, startAngle + sweep, DONUT_R_OUTER, DONUT_R_INNER, DONUT_CX, DONUT_CY)}
        fill={fill}
        stroke="#ffffff"
        strokeWidth={0.35}
      />,
    );
    startAngle += sweep;
  }
  return paths;
}

function ButterflyChart({
  bucketLabel,
  categories,
  beforeBreakdown,
  afterBreakdown,
}: {
  bucketLabel: string;
  categories: RoomCategory[];
  beforeBreakdown: Partial<Record<RoomCategory, number>>;
  afterBreakdown: Partial<Record<RoomCategory, number>>;
}) {
  const rows = categories.map(cat => {
    const before = beforeBreakdown[cat] ?? 0;
    const after = afterBreakdown[cat] ?? 0;
    const delta = after - before;
    return { cat, before, after, delta };
  });
  const maxVal = Math.max(1, ...rows.map(r => Math.max(r.before, r.after)));

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Before</div>
        <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">{bucketLabel}</div>
        <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">After</div>
      </div>

      <div className="relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-border/70" aria-hidden />
        <div className="space-y-1.5">
          {rows.map(r => {
            const fill = CATEGORY_DONUT_FILL[r.cat] ?? "rgba(44, 27, 24, 0.3)";
            const leftPct = (r.before / maxVal) * 100;
            const rightPct = (r.after / maxVal) * 100;
            return (
              <div key={r.cat} className="grid grid-cols-[64px_1fr_44px] items-center gap-2">
                <div className="text-[9px] font-bold text-text-muted uppercase tracking-wide truncate">
                  {r.cat}
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <div className="h-3 bg-surface-2 border border-border/60 relative overflow-hidden">
                    <div
                      className="absolute right-0 top-0 bottom-0"
                      style={{ width: `${leftPct}%`, backgroundColor: fill }}
                      aria-label={`${r.cat} before: ${r.before}`}
                      role="img"
                    />
                  </div>
                  <div className="h-3 bg-surface-2 border border-border/60 relative overflow-hidden">
                    <div
                      className="absolute left-0 top-0 bottom-0"
                      style={{ width: `${rightPct}%`, backgroundColor: fill }}
                      aria-label={`${r.cat} after: ${r.after}`}
                      role="img"
                    />
                  </div>
                </div>

                <div className={`text-[10px] font-bold tabular-nums text-right ${r.delta >= 0 ? "text-occugreen" : "text-occuorange"}`}>
                  {r.delta >= 0 ? `+${r.delta}` : `${r.delta}`}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-2 text-[9px] text-text-muted font-bold uppercase tracking-widest">
        Scale: max {maxVal} windows · bars show per-room-type mix shift
      </div>
    </div>
  );
}

interface BirdseyeInventoryHighlightsProps {
  snapshot: EmptyRunInventorySnapshot;
  projectedSnapshot?: EmptyRunInventorySnapshot | null;
  maxDays: number;
}

/**
 * Right-column "Availability at a glance" for Bird's Eye View: k-night bookable windows (overlapping placements in EMPTY strips), by bucket and room category.
 * Each bucket shows a donut chart of the category mix plus a legend with counts (1–4 nights; 4+ is omitted from this panel).
 */
export function BirdseyeInventoryHighlights({ snapshot, projectedSnapshot, maxDays }: BirdseyeInventoryHighlightsProps) {
  const base = snapshot;
  const after = projectedSnapshot ?? null;
  const baseGrandTotal = BIRDSEYE_DISPLAY_BUCKET_ORDER.reduce((s, b) => s + base.totalsByBucket[b], 0);
  const afterGrandTotal = after ? BIRDSEYE_DISPLAY_BUCKET_ORDER.reduce((s, b) => s + after.totalsByBucket[b], 0) : null;

  return (
    <div className="bg-surface border border-border shadow-subtle flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40 shrink-0">
        <h3 className="font-bold text-xs text-text uppercase tracking-widest">Availability at a glance</h3>
        <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">
          k-night placements in EMPTY strips (overlapping) · {maxDays}-day scan ·{" "}
          {afterGrandTotal != null ? (
            <>
              <span className="text-text-muted">before</span> {baseGrandTotal} ·{" "}
              <span className="text-text-muted">after</span> {afterGrandTotal} ·{" "}
              <span className={(afterGrandTotal - baseGrandTotal) >= 0 ? "text-occugreen" : "text-occuorange"}>
                Δ {afterGrandTotal - baseGrandTotal}
              </span>
            </>
          ) : (
            <>{baseGrandTotal} total across lengths</>
          )}
        </p>
      </div>

      <div className="p-3 space-y-4 overflow-y-auto flex-1 max-h-[calc(100vh-220px)] lg:max-h-none">
        {BIRDSEYE_DISPLAY_BUCKET_ORDER.map(bucket => {
          const baseTotal = base.totalsByBucket[bucket];
          const total = after ? after.totalsByBucket[bucket] : baseTotal;
          const breakdown = after ? after.byBucket[bucket] : base.byBucket[bucket];
          const categoriesPresent = CATEGORY_ORDER.filter(c => (breakdown[c] ?? 0) > 0);
          const delta = after ? (after.totalsByBucket[bucket] - baseTotal) : null;

          return (
            <section key={bucket} className="border border-border/70 rounded-sm overflow-hidden bg-surface">
              <div className="flex items-center justify-between px-2.5 py-2 bg-surface-2/50 border-b border-border/50">
                <span className="text-[10px] font-bold text-text uppercase tracking-widest">
                  {BUCKET_LABELS[bucket]}
                </span>
                {after ? (
                  <span className="text-[10px] font-black tabular-nums flex items-baseline gap-2">
                    <span className="text-text-muted">B {baseTotal}</span>
                    <span className="text-accent">A {total}</span>
                    <span className={(delta ?? 0) >= 0 ? "text-occugreen" : "text-occuorange"}>Δ {delta}</span>
                  </span>
                ) : (
                  <span className="text-[10px] font-black text-accent tabular-nums">{total}</span>
                )}
              </div>

              {total === 0 ? (
                <div className="px-2.5 py-3 text-[10px] text-text-muted font-medium">No windows in this bucket</div>
              ) : (
                <div className="px-2.5 py-3 flex flex-col sm:flex-row sm:items-center gap-4">
                  {after ? (
                    <div className="w-full">
                      <ButterflyChart
                        bucketLabel={BUCKET_LABELS[bucket]}
                        categories={CATEGORY_ORDER.filter(c => ((base.byBucket[bucket][c] ?? 0) > 0) || ((after.byBucket[bucket][c] ?? 0) > 0))}
                        beforeBreakdown={base.byBucket[bucket]}
                        afterBreakdown={after.byBucket[bucket]}
                      />
                    </div>
                  ) : (
                    <div className="shrink-0 flex justify-center sm:justify-start">
                      <svg
                        viewBox="0 0 100 100"
                        className="w-28 h-28 sm:w-32 sm:h-32"
                        role="img"
                        aria-label={`Category mix for ${BUCKET_LABELS[bucket]}: ${total} windows`}
                      >
                        {buildDonutSliceElements(categoriesPresent, breakdown, total)}
                      </svg>
                    </div>
                  )}
                  <ul className="flex-1 min-w-0 space-y-2">
                    {categoriesPresent.map(cat => {
                      const n = breakdown[cat] ?? 0;
                      const baseN = base.byBucket[bucket][cat] ?? 0;
                      const deltaN = after ? (n - baseN) : null;
                      const fill = CATEGORY_DONUT_FILL[cat] ?? "rgba(44, 27, 24, 0.3)";
                      return (
                        <li key={cat} className="flex justify-between items-center gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: fill }} aria-hidden />
                            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wide truncate">
                              {cat}
                            </span>
                          </span>
                          {after ? (
                            <span className="text-[10px] font-bold tabular-nums shrink-0 flex items-baseline gap-2">
                              <span className="text-text-muted">B {baseN}</span>
                              <span className="text-text">A {n}</span>
                              <span className={(deltaN ?? 0) >= 0 ? "text-occugreen" : "text-occuorange"}>Δ {deltaN}</span>
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold text-text tabular-nums shrink-0">{n}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
