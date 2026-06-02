/**
 * Global date utility to enforce the hotel's timezone (New Jersey / EDT).
 * Resolves date-boundary bugs where the user's browser is in a different
 * timezone from the hotel (e.g. India vs US).
 */
export function getHotelTodayStr(): string {
  const tzOptions = {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  } as const;

  const parts = new Intl.DateTimeFormat("en-US", tzOptions).formatToParts(new Date());
  
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  
  return `${year}-${month}-${day}`;
}
