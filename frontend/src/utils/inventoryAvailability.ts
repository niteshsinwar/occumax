import type { HeatmapRow, RoomCategory } from "../types";

/** Consecutive-empty-night run length buckets used in the Bird's Eye inventory panel. */
export type AvailabilityBucket = "1" | "2" | "3" | "4" | "4+";

const BUCKET_ORDER: AvailabilityBucket[] = ["1", "2", "3", "4", "4+"];

/**
 * Maps a consecutive EMPTY run length to a display bucket (4+ groups five or more nights).
 * Callers only pass lengths from non-empty EMPTY runs (always >= 1).
 */
function lengthToBucket(length: number): AvailabilityBucket {
  if (length >= 5) return "4+";
  return String(length) as "1" | "2" | "3" | "4";
}

export interface EmptyRunInventorySnapshot {
  /** Count of EMPTY runs per room category within each length bucket. */
  byBucket: Record<AvailabilityBucket, Partial<Record<RoomCategory, number>>>;
  /** Total EMPTY runs per bucket (sum across categories). */
  totalsByBucket: Record<AvailabilityBucket, number>;
}

/**
 * Scans heatmap rows and counts consecutive EMPTY cell runs, grouped by run length bucket and room category.
 * Each run increments exactly one bucket for that row's category (same semantics as gap "runs" in yield KPIs).
 */
export function computeEmptyRunInventory(
  rows: HeatmapRow[],
  maxDays: number
): EmptyRunInventorySnapshot {
  const byBucket: EmptyRunInventorySnapshot["byBucket"] = {
    "1": {},
    "2": {},
    "3": {},
    "4": {},
    "4+": {},
  };
  const totalsByBucket: EmptyRunInventorySnapshot["totalsByBucket"] = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "4+": 0,
  };

  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    let i = 0;
    while (i < cells.length) {
      if (cells[i].block_type !== "EMPTY") {
        i++;
        continue;
      }
      const start = i;
      while (i < cells.length && cells[i].block_type === "EMPTY") i++;
      const length = i - start;
      const bucket = lengthToBucket(length);
      const cat = row.category;
      byBucket[bucket][cat] = (byBucket[bucket][cat] ?? 0) + 1;
      totalsByBucket[bucket]++;
    }
  }

  return { byBucket, totalsByBucket };
}

/** Stable category ordering aligned with the heatmap grid. */
export const CATEGORY_ORDER: RoomCategory[] = [
  "STANDARD",
  "STUDIO",
  "DELUXE",
  "SUITE",
  "PREMIUM",
  "ECONOMY",
];

export { BUCKET_ORDER };
