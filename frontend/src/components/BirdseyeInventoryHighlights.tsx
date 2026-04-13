import type { RoomCategory } from "../types";
import {
  BUCKET_ORDER,
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

const CATEGORY_BAR: Partial<Record<RoomCategory, string>> = {
  STANDARD: "bg-text/30",
  STUDIO: "bg-accent/40",
  DELUXE: "bg-occugreen/45",
  SUITE: "bg-occuorange/50",
  PREMIUM: "bg-accent",
  ECONOMY: "bg-stone-400/50",
};

interface BirdseyeInventoryHighlightsProps {
  snapshot: EmptyRunInventorySnapshot;
  maxDays: number;
}

/**
 * Right-column summary for Bird's Eye View: consecutive EMPTY runs by length bucket, broken down by room category.
 */
export function BirdseyeInventoryHighlights({ snapshot, maxDays }: BirdseyeInventoryHighlightsProps) {
  const grandTotal = BUCKET_ORDER.reduce((s, b) => s + snapshot.totalsByBucket[b], 0);

  return (
    <div className="bg-surface border border-border shadow-subtle flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40 shrink-0">
        <h3 className="font-serif font-bold text-sm text-text">Availability runs</h3>
        <p className="text-[9px] text-text-muted uppercase tracking-widest font-bold mt-0.5 leading-relaxed">
          Consecutive empty nights · {maxDays}-day window · {grandTotal} run{grandTotal !== 1 ? "s" : ""} total
        </p>
      </div>

      <div className="p-3 space-y-4 overflow-y-auto flex-1 max-h-[calc(100vh-220px)] lg:max-h-none">
        {BUCKET_ORDER.map(bucket => {
          const total = snapshot.totalsByBucket[bucket];
          const breakdown = snapshot.byBucket[bucket];
          const categoriesPresent = CATEGORY_ORDER.filter(c => (breakdown[c] ?? 0) > 0);

          return (
            <section key={bucket} className="border border-border/70 rounded-sm overflow-hidden bg-surface">
              <div className="flex items-center justify-between px-2.5 py-2 bg-surface-2/50 border-b border-border/50">
                <span className="text-[10px] font-bold text-text uppercase tracking-wider">
                  {BUCKET_LABELS[bucket]}
                </span>
                <span className="text-[10px] font-black text-accent tabular-nums">{total}</span>
              </div>

              {total === 0 ? (
                <div className="px-2.5 py-3 text-[10px] text-text-muted font-medium">No runs in this bucket</div>
              ) : (
                <ul className="divide-y divide-border/40">
                  {categoriesPresent.map(cat => {
                    const n = breakdown[cat] ?? 0;
                    const pct = total > 0 ? Math.max((n / total) * 100, n > 0 ? 8 : 0) : 0;
                    const barClass = CATEGORY_BAR[cat] ?? "bg-text/25";
                    return (
                      <li key={cat} className="px-2.5 py-2">
                        <div className="flex justify-between items-baseline gap-2 mb-1">
                          <span className="text-[9px] font-bold text-text-muted uppercase tracking-wide">{cat}</span>
                          <span className="text-[10px] font-bold text-text tabular-nums">{n}</span>
                        </div>
                        <div className="h-1.5 bg-surface-2 border border-border/40 rounded-sm overflow-hidden">
                          <div className={`h-full ${barClass} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
