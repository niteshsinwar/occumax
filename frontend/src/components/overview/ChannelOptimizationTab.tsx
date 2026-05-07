import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  channelAllocate,
  getChannelPartners,
  getChannelPerformance,
  getChannelRecommendations,
} from "../../api/client";
import { contextFeed, computeCompositeScore } from "../../mock/contextFeed";
import { scoreContextWithAi } from "../../mock/aiContextScoring";
import type {
  ChannelPerformanceResponse,
  ChannelRecommendResponse,
  ChannelRecommendation,
  ChannelStat,
  PartnerStat,
} from "../../types";
import { useToast } from "../shared/Toast";
import { AiTag } from "../shared/AiTag";
import {
  ArrowRight,
  BarChart2,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";

const MARKET_RADAR_ITEM_ID = "bookingcom-24h-downtime";
const CHANNEL_AI_WINDOW_DAYS = 15;

type PartnerHealth = "GREEN" | "AMBER" | "RED";
type InventoryAllocation = Record<string, number>;

function buildDefaultHealthMap(partners: string[]): Record<string, PartnerHealth> {
  const map: Record<string, PartnerHealth> = {};
  for (const p of partners) map[p] = "GREEN";
  return map;
}

function buildDefaultFlexibleInventory(partners: string[], totalFlexibleRooms: number): InventoryAllocation {
  const uniquePartners = partners.filter(Boolean);
  const next: InventoryAllocation = {};
  for (const p of uniquePartners) next[p] = 0;
  if (uniquePartners.length === 0 || totalFlexibleRooms <= 0) return next;

  // Bias toward Booking.com + Expedia for the demo narrative, then distribute remainder.
  const preferred = ["Booking.com", "Expedia"].filter(p => uniquePartners.includes(p));
  const remaining = uniquePartners.filter(p => !preferred.includes(p));

  let remainingRooms = totalFlexibleRooms;
  if (preferred.includes("Booking.com")) {
    const v = Math.min(3, remainingRooms);
    next["Booking.com"] += v;
    remainingRooms -= v;
  }
  if (preferred.includes("Expedia")) {
    const v = Math.min(3, remainingRooms);
    next["Expedia"] += v;
    remainingRooms -= v;
  }

  const distributeTo = [...preferred, ...remaining].filter(p => p !== "Booking.com"); // keep some concentration to show pivot away from Booking.com
  if (distributeTo.length === 0) return next;

  const share = Math.floor(remainingRooms / distributeTo.length);
  let remainder = remainingRooms - share * distributeTo.length;
  for (const p of distributeTo) {
    next[p] += share + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
  }

  return next;
}

function healthRingClass(health: PartnerHealth): string {
  if (health === "GREEN") return "border-occugreen/60 shadow-[0_0_0_3px_rgba(34,197,94,0.12)]";
  if (health === "AMBER") return "border-occuorange/70 shadow-[0_0_0_3px_rgba(249,115,22,0.12)]";
  return "border-red-500/70 shadow-[0_0_0_3px_rgba(239,68,68,0.12)]";
}

function healthBadgeClass(health: PartnerHealth): string {
  if (health === "GREEN") return "bg-occugreen/10 border-occugreen/30 text-occugreen";
  if (health === "AMBER") return "bg-occuorange/10 border-occuorange/30 text-occuorange";
  return "bg-red-500/10 border-red-500/30 text-red-600";
}

function rebalanceFlexibleInventory(args: {
  partners: string[];
  fromPartner: string;
  toPartners: string[];
  current: InventoryAllocation;
}): InventoryAllocation {
  const { partners, fromPartner, toPartners, current } = args;
  const next: InventoryAllocation = {};
  for (const p of partners) next[p] = Math.max(0, Math.round(current[p] ?? 0));

  const moved = next[fromPartner] ?? 0;
  next[fromPartner] = 0;
  if (moved <= 0 || toPartners.length === 0) return next;

  const share = Math.floor(moved / toPartners.length);
  let remainder = moved - share * toPartners.length;
  for (const p of toPartners) {
    next[p] = (next[p] ?? 0) + share + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
  }

  return next;
}

/**
 * Channel Insights and Optimization tab.
 * Pulled from the legacy Manager page Channels tab to be reused inside Overview.
 */
export function ChannelOptimizationTab() {
  const { show, Toasts } = useToast();

  const [channelData, setChannelData] = useState<ChannelPerformanceResponse | null>(null);
  const [channelLoading, setChannelLoading] = useState(false);
  const [channelWindow, setChannelWindow] = useState<7 | 30 | 60>(30);

  const marketRadarItem = useMemo(() => contextFeed.find(i => i.id === MARKET_RADAR_ITEM_ID) ?? null, []);
  const [partnerHealth, setPartnerHealth] = useState<Record<string, PartnerHealth>>(() =>
    buildDefaultHealthMap(["Booking.com", "Expedia", "Agoda", "MakeMyTrip", "Goibibo", "Direct"]),
  );
  const partnerList = useMemo(() => Object.keys(partnerHealth), [partnerHealth]);

  const [inventoryBefore, setInventoryBefore] = useState<InventoryAllocation>(() =>
    buildDefaultFlexibleInventory(["Booking.com", "Expedia", "Agoda", "MakeMyTrip", "Goibibo", "Direct"], 10),
  );
  const [inventoryAfter, setInventoryAfter] = useState<InventoryAllocation | null>(null);
  const [marketRadarLoading, setMarketRadarLoading] = useState(false);
  const [marketRadarResult, setMarketRadarResult] = useState<{
    compositeScore: number;
    impact: "LOW" | "MEDIUM" | "HIGH";
    needsAdjustment: boolean;
    rationale: string;
  } | null>(null);

  // AI channel recommendations
  const [aiRecs, setAiRecs] = useState<ChannelRecommendResponse | null>(null);
  const [aiRecsLoading, setAiRecsLoading] = useState(false);
  const [committedRecs, setCommittedRecs] = useState<Set<number>>(new Set());
  const [skippedRecs, setSkippedRecs] = useState<Set<number>>(new Set());

  const loadChannelData = useCallback(async (window_days: number) => {
    setChannelLoading(true);
    try {
      const res = await getChannelPerformance({ window_days });
      setChannelData(res.data as ChannelPerformanceResponse);
    } catch {
      show("Failed to load channel data", "error");
    } finally {
      setChannelLoading(false);
    }
  }, [show]);

  useEffect(() => {
    loadChannelData(channelWindow);
  }, [channelWindow, loadChannelData]);

  useEffect(() => {
    getChannelPartners()
      .then(res => {
        const d = res.data as { ota: { name: string }[]; gds: { name: string }[]; direct: { name: string }[] };
        const sources = [...d.direct.map(p => p.name), ...d.ota.map(p => p.name), ...d.gds.map(p => p.name)];

        // Partner Pulse should reflect the backend partner set. Use Direct + OTA + (optionally) GDS.
        const pulsePartners = sources.filter(Boolean);
        if (pulsePartners.length > 0) {
          setPartnerHealth(buildDefaultHealthMap(pulsePartners));
          setInventoryBefore(buildDefaultFlexibleInventory(pulsePartners, 10));
        }
      })
      .catch(() => {
        const fallback = [
          "Direct",
          "Walk-in",
          "MakeMyTrip",
          "Goibibo",
          "Agoda",
          "Booking.com",
          "Expedia",
          "Amadeus",
          "Sabre",
          "Travelport",
        ];

        setPartnerHealth(buildDefaultHealthMap(fallback));
        setInventoryBefore(buildDefaultFlexibleInventory(fallback, 10));
      });
  }, []);

  const handleTriggerBookingDowntime = () => {
    setPartnerHealth(prev => ({ ...prev, "Booking.com": "RED" }));
    show("Mock event triggered: Booking.com experiencing 1-day API downtime", "success");
  };

  const handleClearPartnerRisk = () => {
    setPartnerHealth(prev => buildDefaultHealthMap(Object.keys(prev)));
    setInventoryAfter(null);
    setMarketRadarResult(null);
    show("Cleared mock partner risk scenario", "success");
  };

  const handleRunMarketRadar = async () => {
    if (!marketRadarItem) {
      show("Market Radar signal not found", "error");
      return;
    }

    setMarketRadarLoading(true);
    setMarketRadarResult(null);
    setInventoryAfter(null);
    try {
      const compositeScore = computeCompositeScore(marketRadarItem);
      const ai = await scoreContextWithAi({ item: marketRadarItem });
      const maxFactor = Math.max(0, ...ai.factors.map(f => f.score ?? 0));

      const impact: "LOW" | "MEDIUM" | "HIGH" = maxFactor >= 85 ? "HIGH" : maxFactor >= 70 ? "MEDIUM" : "LOW";
      const needsAdjustment = impact !== "LOW";

      setMarketRadarResult({
        compositeScore,
        impact,
        needsAdjustment,
        rationale: ai.rationale,
      });

      if (needsAdjustment) {
        const nextHealth: Record<string, PartnerHealth> = { ...partnerHealth, "Booking.com": "RED" };
        setPartnerHealth(nextHealth);
        const greenPartners = partnerList.filter(p => p !== "Booking.com" && (nextHealth[p] ?? "GREEN") === "GREEN");
        const rebalanced = rebalanceFlexibleInventory({
          partners: partnerList,
          fromPartner: "Booking.com",
          toPartners: greenPartners.length > 0 ? greenPartners : partnerList.filter(p => p !== "Booking.com"),
          current: inventoryBefore,
        });
        setInventoryAfter(rebalanced);
        show("Market Radar: flexible inventory pivot applied", "success");
      } else {
        show("Market Radar: no flexible inventory adjustment needed", "success");
      }
    } catch {
      show("Market Radar analysis failed", "error");
    } finally {
      setMarketRadarLoading(false);
    }
  };

  const handleRunAiAnalysis = async () => {
    setAiRecsLoading(true);
    setAiRecs(null);
    setCommittedRecs(new Set());
    setSkippedRecs(new Set());
    try {
      const res = await getChannelRecommendations();
      setAiRecs(res.data as ChannelRecommendResponse);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      show(detail ?? "AI channel analysis failed", "error");
    } finally {
      setAiRecsLoading(false);
    }
  };

  const handleCommitRec = async (rec: ChannelRecommendation, idx: number) => {
    try {
      await channelAllocate({
        booking_source: rec.booking_source,
        category: rec.category,
        check_in: rec.check_in,
        check_out: rec.check_out,
        room_count: rec.room_count,
      });
      setCommittedRecs(prev => new Set(prev).add(idx));
      show(`Allocated ${rec.room_count} ${rec.category} room(s) to ${rec.booking_source}`, "success");
      loadChannelData(channelWindow);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Allocation failed";
      show(msg, "error");
    }
  };

  const filteredAiRecs = useMemo(() => {
    if (!aiRecs) return null;
    const start = new Date();
    const end = new Date(Date.now() + (CHANNEL_AI_WINDOW_DAYS - 1) * 86400000);
    const withinWindow = (d: string) => {
      const dt = new Date(d);
      return !Number.isNaN(dt.getTime()) && dt >= start && dt <= end;
    };
    const recommendations = aiRecs.recommendations.filter(r => withinWindow(r.check_in));
    return { ...aiRecs, recommendations };
  }, [aiRecs]);

  return (
    <div className="space-y-6">
      <Toasts />

      {/* Strategic Channel Resilience */}
      <div className="border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif font-bold text-xl text-text">Strategic Channel Resilience</h2>
            <p className="text-xs text-text-muted mt-1 uppercase tracking-widest">
              Market Radar monitors partner health and shifts flexible inventory away from high-risk channels to protect net margin.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRunMarketRadar}
              disabled={marketRadarLoading}
              className="bg-text text-surface text-[10px] font-bold uppercase tracking-widest px-4 py-2 hover:opacity-90 active:scale-95 disabled:opacity-40 flex items-center gap-2 transition-all"
            >
              {marketRadarLoading ? (
                <>
                  <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" /> Running Radar…
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" /> Run Market Radar
                </>
              )}
            </button>
            <button
              onClick={handleTriggerBookingDowntime}
              className="bg-red-600 text-white text-[10px] font-bold uppercase tracking-widest px-4 py-2 hover:brightness-110 active:scale-95 transition-all"
            >
              Trigger Downtime
            </button>
            <button
              onClick={handleClearPartnerRisk}
              className="bg-surface border border-border text-[10px] font-bold uppercase tracking-widest px-4 py-2 hover:bg-surface-2 active:scale-95 transition-all text-text-muted"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-6">
          {/* Partner Pulse */}
          <div className="border border-border bg-surface-2/40 p-5">
            <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-3">Partner Pulse</div>
            <div className="space-y-2">
              {partnerList.map(p => {
                const health = partnerHealth[p] ?? "GREEN";
                return (
                  <div key={p} className="flex items-center justify-between border border-border bg-surface px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-full border-2 ${healthRingClass(health)} bg-surface flex items-center justify-center`}>
                        <div className="w-2 h-2 rounded-full bg-text/50" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-text truncate">{p}</div>
                        <div className="text-[10px] text-text-muted uppercase tracking-widest truncate">
                          {health === "GREEN" ? "Healthy" : health === "AMBER" ? "Watch" : "High risk"}
                        </div>
                      </div>
                    </div>
                    <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 border ${healthBadgeClass(health)}`}>
                      {health}
                    </span>
                  </div>
                );
              })}
            </div>
            {marketRadarItem && (
              <div className="mt-4 text-[11px] text-text-muted leading-relaxed">
                Signal source (Market context): <span className="text-text font-bold">{marketRadarItem.title}</span>
              </div>
            )}
          </div>

          {/* Strategic Pivot */}
          <div className="border border-border bg-surface-2/40 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Strategic Pivot</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                  Flexible inventory (not contract-locked) shifts priority to green partners when a partner-risk scenario is detected.
                </div>
              </div>
              {marketRadarResult && (
                <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 border ${
                  marketRadarResult.impact === "HIGH"
                    ? "bg-red-500/10 border-red-500/30 text-red-600"
                    : marketRadarResult.impact === "MEDIUM"
                      ? "bg-occuorange/10 border-occuorange/30 text-occuorange"
                      : "bg-surface border-border text-text-muted"
                }`}>
                  Impact {marketRadarResult.impact}
                </span>
              )}
            </div>

            {marketRadarResult ? (
              <div className="mt-4 border border-border bg-surface p-4">
                <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
                  AI assessment · composite {marketRadarResult.compositeScore}/100 · {marketRadarResult.needsAdjustment ? "adjustment recommended" : "no adjustment"}
                </div>
                <div className="text-xs text-text-muted mt-2 leading-relaxed">{marketRadarResult.rationale}</div>
              </div>
            ) : (
              <div className="mt-4 border border-dashed border-border bg-surface p-4 text-xs text-text-muted">
                Run Market Radar to evaluate impact and determine if a flexible inventory adjustment is needed.
              </div>
            )}

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-border bg-surface p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-2">Flexible inventory (before)</div>
                <div className="space-y-1 text-[11px] text-text-muted">
                  {partnerList.map(p => (
                    <div key={`b-${p}`} className="flex items-center justify-between">
                      <span className="truncate">{p}</span>
                      <span className="font-mono font-bold text-text">{inventoryBefore[p] ?? 0}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border border-border bg-surface p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-2">Flexible inventory (after)</div>
                {inventoryAfter ? (
                  <div className="space-y-1 text-[11px] text-text-muted">
                    {partnerList.map(p => (
                      <div key={`a-${p}`} className="flex items-center justify-between">
                        <span className="truncate">{p}</span>
                        <span className="font-mono font-bold text-text">{inventoryAfter[p] ?? 0}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-text-muted">—</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Header + window selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif font-bold text-xl text-text">Channel Performance</h2>
          <p className="text-xs text-text-muted mt-1 uppercase tracking-widest">Revenue by booking source · commission-adjusted net yield</p>
        </div>
        <div className="flex items-center gap-2">
          {([7, 30, 60] as const).map(w => (
            <button
              key={w}
              onClick={() => setChannelWindow(w)}
              className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 border transition-colors ${
                channelWindow === w ? "bg-text text-surface border-text" : "bg-surface text-text-muted border-border hover:bg-surface-2"
              }`}
            >
              {w}d
            </button>
          ))}
          <button
            onClick={() => loadChannelData(channelWindow)}
            className="ml-2 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 border border-border bg-surface hover:bg-surface-2 flex items-center gap-1.5 text-text-muted"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {channelLoading && (
        <div className="py-20 text-center">
          <div className="w-6 h-6 border-2 border-border border-t-accent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-xs text-text-muted uppercase tracking-widest">Loading channel data…</p>
        </div>
      )}

      {!channelLoading && channelData && (
        <>
          {/* AI Channel Recommendation Panel */}
          <div className="border border-accent/20 bg-accent/5 p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-accent flex items-center gap-2">
                    YieldIQ · Channel Allocation <AiTag title="YieldIQ recommends where to push inventory across partners to improve net yield." />
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">Analyses the next {CHANNEL_AI_WINDOW_DAYS} days of gaps + partner history to recommend where to push inventory</div>
                </div>
              </div>
              <button
                onClick={handleRunAiAnalysis}
                disabled={aiRecsLoading}
                className="bg-accent text-white text-[10px] font-bold uppercase tracking-widest px-5 py-2.5 hover:brightness-110 active:scale-95 disabled:opacity-50 flex items-center gap-2 transition-all"
              >
                {aiRecsLoading ? (
                  <>
                    <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" /> Analysing…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3 h-3" /> Run AI Analysis
                  </>
                )}
              </button>
            </div>

            {aiRecsLoading && (
              <div className="py-10 text-center">
                <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-xs text-text-muted">YieldIQ is analysing your inventory gaps and channel history…</p>
              </div>
            )}

            {filteredAiRecs && !aiRecsLoading && (
              <div className="space-y-3">
                {filteredAiRecs.summary && (
                  <div className="bg-surface border border-border p-4 text-sm text-text leading-relaxed">
                    {filteredAiRecs.summary}
                  </div>
                )}
                {filteredAiRecs.recommendations.length === 0 && (
                  <div className="py-8 text-center text-xs text-text-muted">No recommendations — your channel mix looks healthy.</div>
                )}
                {filteredAiRecs.recommendations.map((rec: ChannelRecommendation, idx: number) => {
                  const isCommitted = committedRecs.has(idx);
                  const isSkipped = skippedRecs.has(idx);
                  const confColor =
                    rec.confidence === "HIGH"
                      ? "text-occugreen border-occugreen/40 bg-occugreen/5"
                      : rec.confidence === "MEDIUM"
                        ? "text-occuorange border-occuorange/40 bg-occuorange/5"
                        : "text-text-muted border-border bg-surface-2";
                  const typeColor =
                    rec.channel_type === "OTA"
                      ? "bg-amber-50 text-amber-700 border-amber-200"
                      : rec.channel_type === "GDS"
                        ? "bg-violet-50 text-violet-700 border-violet-200"
                        : "bg-teal-50 text-teal-700 border-teal-200";
                  return (
                    <div
                      key={idx}
                      className={`bg-surface border p-4 transition-all ${
                        isCommitted ? "border-occugreen/40 opacity-70" : isSkipped ? "border-border opacity-40" : "border-border"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-2">
                            <span className="text-[9px] font-bold uppercase tracking-widest text-accent border border-accent/30 bg-accent/5 px-1.5 py-0.5 flex items-center gap-0.5">
                              <Sparkles className="w-2 h-2" /> AI Suggestion
                            </span>
                            <span className="font-bold text-sm text-text">{rec.booking_source}</span>
                            <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 border ${typeColor}`}>{rec.channel_type}</span>
                            <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 border ${confColor}`}>{rec.confidence}</span>
                            <span className="text-[10px] text-text-muted font-medium">{rec.category}</span>
                            <span className="text-[10px] text-text-muted">{rec.check_in} → {rec.check_out}</span>
                            <span className="text-[10px] text-text-muted">{rec.room_count} room{rec.room_count > 1 ? "s" : ""}</span>
                          </div>
                          <p className="text-xs text-text-muted leading-relaxed mb-3">{rec.reasoning}</p>
                          <div className="flex items-center gap-4 text-[10px] font-mono">
                            <span className="text-text-muted">
                              Gross <span className="text-text font-bold">${rec.expected_gross.toLocaleString("en-US")}</span>
                            </span>
                            {rec.commission_cost > 0 && <span className="text-occuorange">Commission −${rec.commission_cost.toLocaleString("en-US")}</span>}
                            <span className="text-occugreen font-bold">Net ${rec.expected_net.toLocaleString("en-US")}</span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 shrink-0">
                          {isCommitted ? (
                            <span className="text-[10px] font-bold text-occugreen flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Committed
                            </span>
                          ) : isSkipped ? (
                            <span className="text-[10px] font-bold text-text-muted flex items-center gap-1">
                              <XCircle className="w-3 h-3" /> Skipped
                            </span>
                          ) : (
                            <>
                              <button
                                onClick={() => handleCommitRec(rec, idx)}
                                className="bg-accent text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 hover:brightness-110 active:scale-95 flex items-center gap-1 transition-all"
                              >
                                <ArrowRight className="w-3 h-3" /> Take Action
                              </button>
                              <button
                                onClick={() => setSkippedRecs(prev => new Set(prev).add(idx))}
                                className="bg-surface border border-border text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 hover:bg-surface-2 active:scale-95 flex items-center gap-1 transition-all text-text-muted"
                              >
                                Dismiss
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!filteredAiRecs && !aiRecsLoading && (
              <div className="py-8 text-center text-xs text-text-muted border border-dashed border-accent/20">
                Press "Run AI Analysis" — YieldIQ will check your gaps and recommend channel allocations.
              </div>
            )}
          </div>

          {/* Channel Breakdown (moved from Dashboard overview) */}
          <div className="bg-surface border border-border">
            <div className="px-6 py-3 border-b border-border bg-surface-2/60 flex items-center gap-2">
              <BarChart2 className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-bold uppercase tracking-widest text-text">Channel Breakdown</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-text-muted font-bold border-b border-border/50">
                    <th className="px-6 py-3 text-left">Channel</th>
                    <th className="px-4 py-3 text-right">Nights</th>
                    <th className="px-4 py-3 text-right">Share</th>
                    <th className="px-4 py-3 text-right">Gross ADR</th>
                    <th className="px-4 py-3 text-right">Commission</th>
                    <th className="px-4 py-3 text-right">Gross Revenue</th>
                    <th className="px-4 py-3 text-right">Net Revenue</th>
                    <th className="px-6 py-3 text-left">Net Bar</th>
                  </tr>
                </thead>
                <tbody>
                  {channelData.channels.map((ch: ChannelStat) => {
                    const maxNet = Math.max(...channelData.channels.map(c => c.net_revenue));
                    const barWidth = maxNet > 0 ? Math.round((ch.net_revenue / maxNet) * 100) : 0;
                    const isOta = ch.channel === "OTA" || ch.channel === "GDS";
                    const channelBadge = `text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 border ${
                      ch.channel === "OTA"
                        ? "bg-amber-50 text-amber-700 border-amber-200"
                        : ch.channel === "GDS"
                          ? "bg-violet-50 text-violet-700 border-violet-200"
                          : ch.channel === "DIRECT"
                            ? "bg-teal-50 text-teal-700 border-teal-200"
                            : ch.channel === "WALKIN"
                              ? "bg-orange-50 text-orange-700 border-orange-200"
                              : "bg-surface-2 text-text-muted border-border"
                    }`;
                    return (
                      <Fragment key={ch.channel}>
                        <tr className="border-b border-border/30 bg-surface hover:bg-surface-2/30 transition-colors">
                          <td className="px-6 py-3">
                            <span className={channelBadge}>{ch.channel}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text">{ch.room_nights}</td>
                          <td className="px-4 py-3 text-right">
                            <span className="text-xs font-bold text-text">{ch.share_pct}%</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-text">${ch.avg_rate.toLocaleString("en-US")}</td>
                          <td className="px-4 py-3 text-right">
                            {ch.commission_pct > 0 ? (
                              <span className="text-[10px] font-bold text-occuorange bg-occuorange/8 border border-occuorange/20 px-1.5 py-0.5">
                                {ch.commission_pct}%
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold text-occugreen bg-occugreen/8 border border-occugreen/20 px-1.5 py-0.5">
                                0%
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-text-muted">${ch.gross_revenue.toLocaleString("en-US")}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text">${ch.net_revenue.toLocaleString("en-US")}</td>
                          <td className="px-6 py-3">
                            <div className="w-32 bg-surface-2 border border-border/30 h-3 relative">
                              <div className={`h-full ${isOta ? "bg-occuorange/60" : "bg-occugreen/60"}`} style={{ width: `${barWidth}%` }} />
                            </div>
                          </td>
                        </tr>
                        {ch.partners.map((pt: PartnerStat) => (
                          <tr key={pt.partner} className="border-b border-border/10 bg-surface-2/20">
                            <td className="px-6 py-1.5 pl-10">
                              <span className="text-[10px] text-text-muted font-medium">↳ {pt.partner}</span>
                            </td>
                            <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">{pt.room_nights}</td>
                            <td className="px-4 py-1.5 text-right text-[10px] text-text-muted">{pt.share_of_channel_pct}% of {ch.channel}</td>
                            <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">${pt.avg_rate.toLocaleString("en-US")}</td>
                            <td className="px-4 py-1.5" />
                            <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">${pt.gross_revenue.toLocaleString("en-US")}</td>
                            <td className="px-4 py-1.5 text-right font-mono text-[10px] text-text-muted">${pt.net_revenue.toLocaleString("en-US")}</td>
                            <td className="px-6 py-1.5" />
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!channelLoading && !channelData && (
        <div className="py-20 text-center border border-border bg-surface">
          <BarChart2 className="w-8 h-8 text-accent/30 mx-auto mb-4" />
          <p className="text-sm text-text-muted">No channel data available for this period.</p>
        </div>
      )}
    </div>
  );
}

