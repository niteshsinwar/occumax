import type { HeatmapRow, SwapStep } from "../types";

/**
 * Apply a swap plan to heatmap rows (client-side simulation — no DB write).
 * Mirrors the Managers page preview behavior, used to compute "after" availability deltas.
 */
export function simulateRows(rows: HeatmapRow[], swapPlan: SwapStep[]): HeatmapRow[] {
  if (swapPlan.length === 0) return rows;
  const cloned = rows.map(row => ({ ...row, cells: row.cells.map(c => ({ ...c })) }));
  const cellMap: Record<string, (typeof cloned)[number]["cells"][number]> = {};
  cloned.forEach(row => row.cells.forEach(cell => { cellMap[cell.slot_id] = cell; }));

  for (const step of swapPlan) {
    for (const dateStr of step.dates) {
      const from = cellMap[`${step.from_room}_${dateStr}`];
      const to = cellMap[`${step.to_room}_${dateStr}`];
      if (from?.block_type === "SOFT" && to?.block_type === "EMPTY") {
        from.block_type = "EMPTY";
        to.block_type = "SOFT";
      }
    }
  }
  return cloned;
}

