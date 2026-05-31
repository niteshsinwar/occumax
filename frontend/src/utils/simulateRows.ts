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

  const sourceIds = new Set<string>();
  for (const step of swapPlan) {
    for (const dateStr of step.dates) {
      sourceIds.add(`${step.from_room}_${dateStr}`);
    }
  }

  const moves: Array<{
    sourceId: string;
    targetId: string;
    bookingId: string;
    channel: (typeof cloned)[number]["cells"][number]["channel"];
    currentRate: number;
  }> = [];

  for (const step of swapPlan) {
    for (const dateStr of step.dates) {
      const sourceId = `${step.from_room}_${dateStr}`;
      const targetId = `${step.to_room}_${dateStr}`;
      const from = cellMap[sourceId];
      const to = cellMap[targetId];
      if (!from || !to) continue;
      if (from.block_type !== "SOFT" || from.booking_id !== step.booking_id) continue;
      if (to.block_type !== "EMPTY" && !sourceIds.has(targetId)) continue;
      moves.push({
        sourceId,
        targetId,
        bookingId: step.booking_id,
        channel: from.channel,
        currentRate: from.current_rate,
      });
    }
  }

  for (const move of moves) {
    const from = cellMap[move.sourceId];
    if (!from) continue;
    from.block_type = "EMPTY";
    from.booking_id = null;
    from.channel = null;
  }

  for (const move of moves) {
    const to = cellMap[move.targetId];
    if (!to) continue;
    to.block_type = "SOFT";
    to.booking_id = move.bookingId;
    to.channel = move.channel;
    to.current_rate = move.currentRate;
  }

  return cloned;
}
