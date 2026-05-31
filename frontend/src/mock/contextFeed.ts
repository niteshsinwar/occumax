export type ContextFeedItem = {
  id: string;
  kind: "WEATHER" | "TRAVEL" | "EVENT" | "MARKET";
  title: string;
  detail: string;
  location?: string;
  impact_start_offset_days?: number;
  impact_end_offset_days?: number;
  demand_segment?: string;
  severity: "INFO" | "ALERT";
  factors: Array<{
    type: "WEATHER" | "EVENT" | "FLIGHT" | "MARKET";
    label: string;
    value: string;
    /** 0-100 intensity score for this factor (demo/AI-derived). */
    score: number;
    /** 0-1 importance weight for the composite score. */
    weight: number;
  }>;
};

/**
 * Shared mock “context triggers” used across demo surfaces (Pricing / Occupancy / Channels).
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
    impact_start_offset_days: 0,
    impact_end_offset_days: 2,
    demand_segment: "Last-minute transient",
    factors: [
      { type: "FLIGHT", label: "Flight disruption", value: "50+ cancellations (hub) · rebooking pressure ↑", score: 92, weight: 0.45 },
      { type: "WEATHER", label: "Weather pattern", value: "Severe storm band · ground stops likely", score: 78, weight: 0.25 },
      { type: "MARKET", label: "Elasticity", value: "Same-day demand volatility ↑ · short-LOS preference ↑", score: 70, weight: 0.30 },
    ],
  },
  {
    id: "lakefront-thunderstorms",
    kind: "WEATHER",
    severity: "INFO",
    title: "Weather: Severe thunderstorms forecast (48h)",
    detail:
      "Storm risk increases same-day booking volatility; last-minute travelers shift to flexible rates and shorter LOS.",
    location: "Metro area",
    impact_start_offset_days: 0,
    impact_end_offset_days: 2,
    demand_segment: "Weather-sensitive short LOS",
    factors: [
      { type: "WEATHER", label: "Forecast", value: "Thunderstorms (48h) · rain probability 70–90%", score: 76, weight: 0.55 },
      { type: "MARKET", label: "Demand behavior", value: "Late pickup ↑ · cancellation risk ↑", score: 58, weight: 0.45 },
    ],
  },
  {
    id: "conference-week",
    kind: "EVENT",
    severity: "INFO",
    title: "Convention calendar: Citywide conference week",
    detail:
      "Compression nights expected. Maintain price floor; discount only stranded sandwich gaps with targeted channels.",
    location: "Downtown",
    impact_start_offset_days: 1,
    impact_end_offset_days: 5,
    demand_segment: "Corporate group compression",
    factors: [
      { type: "EVENT", label: "Event", value: "Citywide conference · compression nights likely", score: 88, weight: 0.65 },
      { type: "MARKET", label: "Price floor", value: "Protect ADR · targeted clearance only", score: 72, weight: 0.35 },
    ],
  },
  {
    id: "expedia-24h-downtime",
    kind: "MARKET",
    severity: "ALERT",
    title: "Market: Expedia experiencing 1-day API downtime (partner risk)",
    detail:
      "Social/news chatter indicates sustained outage. Treat as partner-health risk → shift flexible inventory away from high-risk channels to protect net margin.",
    impact_start_offset_days: 0,
    impact_end_offset_days: 1,
    demand_segment: "Channel mix risk",
    factors: [
      { type: "MARKET", label: "Social sentiment / news", value: "Outage trending · negative sentiment ↑ · customer friction ↑", score: 86, weight: 0.65 },
      { type: "MARKET", label: "Partner reliability", value: "API downtime (24h) · booking conversion ↓ · support load ↑", score: 94, weight: 0.35 },
    ],
  },
];

export function computeCompositeScore(item: ContextFeedItem): number {
  const ws = item.factors.reduce((s, f) => s + (f.weight ?? 0), 0);
  if (ws <= 0) return 0;
  const weighted = item.factors.reduce((s, f) => s + (Math.max(0, Math.min(100, f.score ?? 0)) * (f.weight ?? 0)), 0);
  return Math.round(weighted / ws);
}

export function getPrimaryShockTrigger(): ContextFeedItem {
  return contextFeed.find(i => i.severity === "ALERT") ?? contextFeed[0]!;
}
