import type { HeatmapRow, RoomCategory } from "../types";

/** Stay-length buckets for k-night bookable windows in the Bird's Eye inventory panel (4+ aggregates windows of length ≥5). */
export type AvailabilityBucket = "1" | "2" | "3" | "4" | "4+";

const BUCKET_ORDER: AvailabilityBucket[] = ["1", "2", "3", "4", "4+"];

/** Buckets shown in Bird's Eye "Availability at a glance" (1–4 nights only; `4+` is still computed but not listed). */
export const BIRDSEYE_DISPLAY_BUCKET_ORDER: AvailabilityBucket[] = ["1", "2", "3", "4"];

export interface EmptyRunInventorySnapshot {
  /** Count of k-night bookable windows per room category (buckets 1–4 are exact k; "4+" sums windows of length ≥5). */
  byBucket: Record<AvailabilityBucket, Partial<Record<RoomCategory, number>>>;
  /** Total k-night bookable windows per bucket (sum across categories). */
  totalsByBucket: Record<AvailabilityBucket, number>;
}

/**
 * For one maximal contiguous EMPTY run of length L, adds all overlapping k-night bookable windows:
 * buckets "1".."4" get max(0, L−k+1); "4+" gets every window of length ≥5, i.e. Σ_{k=5..L}(L−k+1) = (L−4)(L−3)/2 for L≥5.
 */
function addBookableWindowsForRun(
  length: number,
  cat: RoomCategory,
  byBucket: EmptyRunInventorySnapshot["byBucket"],
  totalsByBucket: EmptyRunInventorySnapshot["totalsByBucket"],
): void {
  if (length < 1) return;

  const exactBuckets: Array<{ bucket: "1" | "2" | "3" | "4"; k: number }> = [
    { bucket: "1", k: 1 },
    { bucket: "2", k: 2 },
    { bucket: "3", k: 3 },
    { bucket: "4", k: 4 },
  ];
  for (const { bucket, k } of exactBuckets) {
    const n = length - k + 1;
    if (n <= 0) continue;
    byBucket[bucket][cat] = (byBucket[bucket][cat] ?? 0) + n;
    totalsByBucket[bucket] += n;
  }

  if (length >= 5) {
    const nPlus = ((length - 4) * (length - 3)) / 2;
    byBucket["4+"][cat] = (byBucket["4+"][cat] ?? 0) + nPlus;
    totalsByBucket["4+"] += nPlus;
  }
}

/**
 * Scans heatmap rows; for each maximal consecutive EMPTY run, counts overlapping k-night bookable windows
 * (sliding placements within that run), grouped by stay length bucket and room category.
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
      addBookableWindowsForRun(length, row.category, byBucket, totalsByBucket);
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
