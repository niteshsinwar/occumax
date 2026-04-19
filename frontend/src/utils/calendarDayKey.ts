/**
 * Normalizes API date values (`YYYY-MM-DD` or ISO datetime strings) to a `YYYY-MM-DD`
 * calendar key so client comparisons match heatmap and analytics payloads.
 */
export function calendarDayKey(raw: string): string {
  return String(raw).slice(0, 10);
}
