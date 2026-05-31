import type { HeatmapRow } from "../types";

const CATEGORY_PREFIX: Record<string, string> = {
  ECONOMY: "E",
  STANDARD: "S",
  DELUXE: "D",
  SUITE: "U",
  STUDIO: "T",
  PREMIUM: "P",
};

function isOperationalTestId(roomId: string): boolean {
  return /^TST\d+$/i.test(roomId);
}

export function displayRoomLabel(roomId: string, category: string, rows?: HeatmapRow[]): string {
  if (!isOperationalTestId(roomId)) return roomId;

  const prefix = CATEGORY_PREFIX[String(category).toUpperCase()] ?? "R";
  const categoryRows = (rows ?? [])
    .filter(row => String(row.category) === String(category))
    .map(row => row.room_id)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const idx = categoryRows.indexOf(roomId);
  if (idx < 0) return `${prefix}--`;
  return `${prefix}${String(idx + 1).padStart(2, "0")}`;
}
