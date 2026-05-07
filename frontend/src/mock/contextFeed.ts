export type ContextFeedItem = {
  id: string;
  kind: "WEATHER" | "TRAVEL" | "EVENT" | "MARKET";
  title: string;
  detail: string;
  location?: string;
  severity: "INFO" | "ALERT";
};

/**
 * Shared mock “context triggers” used across demo surfaces (Pricing / Occupancy / Optimizer).
 * Keep this as the single source of truth so the story stays consistent in pitch flows.
 */
export const contextFeed: ContextFeedItem[] = [
  {
    id: "ohare-weather-cancellations",
    kind: "TRAVEL",
    severity: "ALERT",
    title: "O'Hare Airport: 50+ Flight Cancellations Due to Weather",
    detail:
      "External shock detected → last-minute demand spike likely (disrupted arrivals re-book locally). Trigger clearance simulation.",
    location: "Chicago, IL",
  },
  {
    id: "lakefront-thunderstorms",
    kind: "WEATHER",
    severity: "INFO",
    title: "Weather: Severe thunderstorms forecast (48h)",
    detail:
      "Storm risk increases same-day booking volatility; last-minute travelers shift to flexible rates and shorter LOS.",
    location: "Metro area",
  },
  {
    id: "conference-week",
    kind: "EVENT",
    severity: "INFO",
    title: "Convention calendar: Citywide conference week",
    detail:
      "Compression nights expected. Maintain price floor; discount only stranded sandwich gaps with targeted channels.",
    location: "Downtown",
  },
];

export function getPrimaryShockTrigger(): ContextFeedItem {
  return contextFeed.find(i => i.severity === "ALERT") ?? contextFeed[0]!;
}

