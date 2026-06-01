import type { RoomCategory } from "../types";

/**
 * Demo-only competitor pricing "market research".
 * Deterministic (by category + date) so repeated runs feel stable.
 */
export type CompetitorRatePoint = {
  date: string;
  category: RoomCategory;
  competitorMedianRate: number;
  competitorP10Rate: number;
  competitorP90Rate: number;
  sourceNote: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function roundTo5(n: number): number {
  return Math.round(n / 5) * 5;
}

function hashSeed(s: string): number {
  // Simple stable hash → 0..2^32-1
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand01(seed: number): number {
  // LCG pseudo-random 0..1
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return next / 0xffffffff;
}

const categoryBias: Record<RoomCategory, number> = {
  ECONOMY: 0.92,
  STANDARD: 0.98,

  DELUXE: 1.06,

  SUITE: 1.14,
};

export function getCompetitorRatePoint(args: {
  date: string;
  category: RoomCategory;
  baseRate: number;
  marketHeat?: number; // 0..100 optional
}): CompetitorRatePoint {
  const { date, category, baseRate, marketHeat } = args;

  const seed = hashSeed(`${category}|${date}`);
  const noise = (rand01(seed) - 0.5) * 0.10; // ±5%
  const heat = clamp((marketHeat ?? 50) / 100, 0, 1);
  const heatLift = (heat - 0.5) * 0.14; // ±7%

  const median = roundTo5(Math.max(45, baseRate * categoryBias[category] * (1 + noise + heatLift)));
  const p10 = roundTo5(median * 0.90);
  const p90 = roundTo5(median * 1.12);

  return {
    date,
    category,
    competitorMedianRate: median,
    competitorP10Rate: p10,
    competitorP90Rate: p90,
    sourceNote: "Comp set (demo): median of 6 OTAs + 2 direct comps",
  };
}

