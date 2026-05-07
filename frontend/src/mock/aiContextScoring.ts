import type { ContextFeedItem } from "./contextFeed";

export type AiScoredFactor = ContextFeedItem["factors"][number];

export type AiContextScoreResult = {
  factors: AiScoredFactor[];
  rationale: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
};

/**
 * Mock async “AI scoring” for context feed items.
 * - Returns normalized factor scores/weights that can be used deterministically for pricing decisions.
 * - Kept async so we can later swap to a real backend call without changing UI flow.
 */
export async function scoreContextWithAi(args: {
  item: ContextFeedItem;
}): Promise<AiContextScoreResult> {
  const { item } = args;

  // Simulate latency; keep deterministic based on item.id.
  const baseDelayMs = 450 + (item.id.length % 5) * 120;
  await new Promise<void>(resolve => setTimeout(resolve, baseDelayMs));

  // Deterministic adjustments by kind: for demo, AI “leans” into certain signals.
  const kindBoost: Record<ContextFeedItem["kind"], Partial<Record<AiScoredFactor["type"], number>>> = {
    TRAVEL: { FLIGHT: 8, WEATHER: 3, MARKET: 2, EVENT: 0 },
    WEATHER: { WEATHER: 8, FLIGHT: 2, MARKET: 1, EVENT: 0 },
    EVENT: { EVENT: 10, MARKET: 2, WEATHER: 0, FLIGHT: 0 },
    MARKET: { MARKET: 10, EVENT: 2, WEATHER: 2, FLIGHT: 2 },
  };

  const boosts = kindBoost[item.kind] ?? {};
  const factors = item.factors.map(f => {
    const boost = boosts[f.type] ?? 0;
    const score = Math.max(0, Math.min(100, Math.round((f.score ?? 0) + boost)));
    const weight = Math.max(0.05, Math.min(0.9, Number(f.weight ?? 0.25)));
    return { ...f, score, weight };
  });

  const rationale =
    item.severity === "ALERT"
      ? "AI detected an external shock pattern; prioritize selling stranded inventory with controlled, floor-protected clearance."
      : "AI detected a moderate context shift; recommend conservative clearance and stronger floor protection.";

  const confidence: AiContextScoreResult["confidence"] =
    item.severity === "ALERT" ? "HIGH" : item.kind === "EVENT" ? "MEDIUM" : "LOW";

  return { factors, rationale, confidence };
}

