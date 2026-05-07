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

/**
 * Option B: score a bundle of 4 signals (Event + Weather + Travel + Market).
 * Returns a merged factor set that downstream logic can consume deterministically.
 */
export async function scoreContextBundleWithAi(args: {
  items: Array<ContextFeedItem | null>;
}): Promise<AiContextScoreResult> {
  const items = args.items.filter(Boolean) as ContextFeedItem[];
  if (items.length === 0) {
    return { factors: [], rationale: "No context signals provided.", confidence: "LOW" };
  }

  // Simulate latency deterministically from all ids.
  const key = items.map(i => i.id).sort().join("|");
  const baseDelayMs = 520 + (key.length % 7) * 90;
  await new Promise<void>(resolve => setTimeout(resolve, baseDelayMs));

  // Score each item and merge factors by type.
  const scored = await Promise.all(items.map(item => scoreContextWithAi({ item })));
  const factorAgg = new Map<AiScoredFactor["type"], { scoreSum: number; weightSum: number; label: string; value: string }>();

  for (const r of scored) {
    for (const f of r.factors) {
      const w = Math.max(0.01, Math.min(0.9, f.weight ?? 0.25));
      const s = Math.max(0, Math.min(100, f.score ?? 0));
      const prev = factorAgg.get(f.type);
      if (!prev) {
        factorAgg.set(f.type, { scoreSum: s * w, weightSum: w, label: f.label, value: f.value });
      } else {
        prev.scoreSum += s * w;
        prev.weightSum += w;
      }
    }
  }

  const factors: AiScoredFactor[] = [...factorAgg.entries()].map(([type, a]) => ({
    type,
    label: a.label,
    value: a.value,
    score: Math.round(a.scoreSum / Math.max(0.0001, a.weightSum)),
    weight: Math.max(0.05, Math.min(0.9, a.weightSum / items.length)),
  })) as AiScoredFactor[];

  const confidence: AiContextScoreResult["confidence"] = items.length >= 3 ? "HIGH" : "MEDIUM";
  const rationale =
    "AI scored a bundle of exogenous signals (Event, Weather, Travel, Market) and merged weighted factor intensities for Smart Clearance decisioning.";

  return { factors, rationale, confidence };
}

