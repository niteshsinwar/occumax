import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  getChannelPartners,
  getChannelPerformance,
  getChannelRecommendations,
} from "../../api/client";
import type {
  ChannelPerformanceResponse,
  ChannelPartnerInsight,
  ChannelRecommendResponse,
  ChannelRecommendation,
  PartnerStat,
} from "../../types";
import { useToast } from "../shared/Toast";
import {
  BarChart2,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  overviewCardClass,
  overviewCardLgClass,
  overviewEyebrowClass,
  overviewInsetClass,
  overviewSecondaryBtnClass,
  overviewSectionTitleClass,
  overviewStackClass,
} from "./overviewChrome";

const US_ACTIVE_OTA_PARTNERS = ["Expedia", "Hotels.com", "Booking.com", "Priceline", "Travelocity", "Orbitz"];
const CHANNEL_INTEL_CACHE_KEY = "yieldiq_last_channel_intelligence";
const ANALYSIS_STEPS = [
  "Scanning channel performance",
  "Reading OTA news and campaigns",
  "Checking OTA campaign signals",
  "Scoring OTA news impact",
  "Ranking preferred partners",
  "Optimizing slot selection",
];

type PartnerHealth = "GREEN" | "AMBER" | "RED";
type PartnerPreference = "PREFER" | "WATCH" | "HOLD" | "AVOID";
type PartnerIntel = {
  preference: PartnerPreference;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  score: number;
  reasoning: string;
  category?: string;
  checkIn?: string;
  checkOut?: string;
  roomCount?: number;
  expectedNet?: number;
};
type ChannelIntelResult = {
  hasRecommendations: boolean;
  summary: string;
  cacheHit?: boolean;
  contextHash?: string;
};

type ChannelIntelCacheEntry = {
  channelSignature: string;
  payload: ChannelRecommendResponse;
};

function buildDefaultHealthMap(partners: string[]): Record<string, PartnerHealth> {
  const map: Record<string, PartnerHealth> = {};
  for (const p of partners) map[p] = "GREEN";
  return map;
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

function baselineBadgeClass(): string {
  return "bg-surface-2 border-border text-text-muted";
}

function healthLabel(health: PartnerHealth): string {
  if (health === "GREEN") return "Healthy";
  if (health === "AMBER") return "Watch";
  return "Risk";
}

function preferenceBadgeClass(preference: PartnerPreference): string {
  if (preference === "PREFER") return "bg-occugreen/10 border-occugreen/30 text-occugreen";
  if (preference === "WATCH") return "bg-occuorange/10 border-occuorange/30 text-occuorange";
  if (preference === "AVOID") return "bg-red-500/10 border-red-500/30 text-red-600";
  return "bg-surface-2 border-border text-text-muted";
}

function confidenceScore(confidence: string | undefined): number {
  if (confidence === "HIGH") return 90;
  if (confidence === "MEDIUM") return 70;
  if (confidence === "LOW") return 50;
  return 35;
}

function preferenceFromRecommendation(rec: ChannelRecommendation): PartnerPreference {
  if (rec.confidence === "HIGH") return "PREFER";
  if (rec.confidence === "MEDIUM") return "WATCH";
  return "HOLD";
}

function insightToPartnerIntel(insight: ChannelPartnerInsight): PartnerIntel {
  return {
    preference: insight.preference,
    confidence: insight.confidence,
    score: insight.score,
    reasoning: insight.reasoning,
    category: insight.category ?? undefined,
    checkIn: insight.check_in ?? undefined,
    checkOut: insight.check_out ?? undefined,
    roomCount: insight.room_count ?? undefined,
    expectedNet: insight.expected_net ?? undefined,
  };
}

function channelSignature(data: ChannelPerformanceResponse | null): string {
  if (!data) return "";
  const raw = JSON.stringify({
    as_of: data.as_of,
    window_start: data.window_start,
    window_end: data.window_end,
    total_room_nights: data.total_room_nights,
    total_gross_revenue: data.total_gross_revenue,
    total_net_revenue: data.total_net_revenue,
    channels: data.channels.map(ch => ({
      channel: ch.channel,
      room_nights: ch.room_nights,
      gross_revenue: ch.gross_revenue,
      net_revenue: ch.net_revenue,
      partners: ch.partners.map(p => [p.partner, p.room_nights, p.gross_revenue, p.net_revenue]),
    })),
  });
  let hash = 0;
  for (const ch of raw) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return String(hash);
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
  const [otaExpanded, setOtaExpanded] = useState(false);

  const [partnerHealth, setPartnerHealth] = useState<Record<string, PartnerHealth>>(() =>
    buildDefaultHealthMap(US_ACTIVE_OTA_PARTNERS),
  );
  const partnerList = useMemo(() => Object.keys(partnerHealth), [partnerHealth]);

  const [channelIntelLoading, setChannelIntelLoading] = useState(false);
  const [channelIntelResult, setChannelIntelResult] = useState<ChannelIntelResult | null>(null);
  const [analysisStepIndex, setAnalysisStepIndex] = useState(0);
  const [partnerIntel, setPartnerIntel] = useState<Record<string, PartnerIntel>>({});
  const [hasCachedIntel, setHasCachedIntel] = useState(false);

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
    setHasCachedIntel(!!localStorage.getItem(CHANNEL_INTEL_CACHE_KEY));
  }, []);

  useEffect(() => {
    if (!channelIntelLoading) return;
    const timer = window.setInterval(() => {
      setAnalysisStepIndex(prev => {
        const next = Math.floor(Math.random() * ANALYSIS_STEPS.length);
        return next === prev ? (next + 1) % ANALYSIS_STEPS.length : next;
      });
    }, 700);
    return () => window.clearInterval(timer);
  }, [channelIntelLoading]);

  useEffect(() => {
    getChannelPartners()
      .then(res => {
        const d = res.data as { ota: { name: string }[] };
        const sources = d.ota.map(p => p.name);

        // Partner Pulse is OTA-only. Unallocated inventory remains Direct Hotel Front Desk.
        const pulsePartners = sources.filter(Boolean);
        if (pulsePartners.length > 0) {
          setPartnerHealth(buildDefaultHealthMap(pulsePartners));
        }
      })
      .catch(() => {
        const fallback = US_ACTIVE_OTA_PARTNERS;

        setPartnerHealth(buildDefaultHealthMap(fallback));
      });
  }, []);

  const handleClearPartnerRisk = () => {
    setPartnerHealth(prev => buildDefaultHealthMap(Object.keys(prev)));
    setChannelIntelResult(null);
    setPartnerIntel({});
    setAnalysisStepIndex(0);
    show("Cleared channel intelligence", "success");
  };

  const applyChannelPayload = useCallback((recPayload: ChannelRecommendResponse) => {
    const recommendations = recPayload.recommendations ?? [];
    const summary = recPayload.summary?.trim() || (
      recommendations.length > 0
        ? "YieldIQ found OTA opportunities based on current inventory gaps, channel history, and active OTA news."
        : "YieldIQ found no OTA slot push worth prioritizing in this run. Keep unsold inventory available for direct hotel selling unless channel conditions change."
    );
    const insightByPartner = new Map(
      (recPayload.partner_insights ?? [])
        .filter(insight => partnerList.includes(insight.partner))
        .map(insight => [insight.partner, insight]),
    );
    const bestByPartner: Record<string, ChannelRecommendation> = {};
    for (const rec of recommendations) {
      if (!partnerList.includes(rec.booking_source)) continue;
      const prev = bestByPartner[rec.booking_source];
      const prevScore = prev ? confidenceScore(prev.confidence) + (prev.expected_net ?? 0) / 10000 : -1;
      const nextScore = confidenceScore(rec.confidence) + (rec.expected_net ?? 0) / 10000;
      if (!prev || nextScore > prevScore) bestByPartner[rec.booking_source] = rec;
    }

    const nextIntel: Record<string, PartnerIntel> = {};
    const nextHealth = buildDefaultHealthMap(partnerList);
    for (const partner of partnerList) {
      const insight = insightByPartner.get(partner);
      if (insight) {
        nextHealth[partner] = insight.health;
        nextIntel[partner] = insightToPartnerIntel(insight);
        continue;
      }

      const rec = bestByPartner[partner];
      if (rec) {
        nextIntel[partner] = {
          preference: preferenceFromRecommendation(rec),
          confidence: rec.confidence,
          score: confidenceScore(rec.confidence) + (rec.expected_net ?? 0) / 10000,
          reasoning: rec.reasoning,
          category: rec.category,
          checkIn: rec.check_in,
          checkOut: rec.check_out,
          roomCount: rec.room_count,
          expectedNet: rec.expected_net,
        };
      } else {
        nextIntel[partner] = {
          preference: "HOLD",
          confidence: "LOW",
          score: 35,
          reasoning: "YieldIQ did not find a stronger date/category fit for this partner from current gaps, booking history, and OTA news.",
        };
      }
    }

    setChannelIntelResult({
      hasRecommendations: recommendations.length > 0,
      summary,
      cacheHit: Boolean(recPayload.cache_hit),
      contextHash: recPayload.context_hash,
    });
    setPartnerHealth(nextHealth);
    setPartnerIntel(nextIntel);
  }, [partnerList]);

  const handleLoadCachedIntel = useCallback(() => {
    const raw = localStorage.getItem(CHANNEL_INTEL_CACHE_KEY);
    if (!raw) return;
    try {
      const entry = JSON.parse(raw) as ChannelIntelCacheEntry;
      const currentSignature = channelSignature(channelData);
      if (entry.channelSignature && currentSignature && entry.channelSignature !== currentSignature) {
        localStorage.removeItem(CHANNEL_INTEL_CACHE_KEY);
        setHasCachedIntel(false);
        show("Previous channel intelligence is stale after channel data changed. Run fresh intelligence.", "error");
        return;
      }
      applyChannelPayload({ ...entry.payload, cache_hit: true });
      show("Loaded previous channel intelligence", "success");
    } catch {
      show("Could not load previous channel intelligence", "error");
    }
  }, [applyChannelPayload, channelData, show]);

  const handleRunChannelIntelligence = async () => {
    setChannelIntelLoading(true);
    setChannelIntelResult(null);
    setPartnerIntel({});
    setAnalysisStepIndex(0);
    try {
      const recRes = await getChannelRecommendations();
      const recPayload = recRes.data as ChannelRecommendResponse;
      applyChannelPayload(recPayload);
      try {
        localStorage.setItem(CHANNEL_INTEL_CACHE_KEY, JSON.stringify({
          channelSignature: channelSignature(channelData),
          payload: recPayload,
        } satisfies ChannelIntelCacheEntry));
        setHasCachedIntel(true);
      } catch { /* quota */ }
      show(recPayload.cache_hit ? "Loaded cached channel intelligence" : "Channel intelligence complete: recommendations updated", "success");
    } catch {
      show("Channel intelligence analysis failed", "error");
    } finally {
      setChannelIntelLoading(false);
    }
  };

  const channelComparison = useMemo(() => {
    if (!channelData) return [];
    const ota = channelData.channels.find(ch => ch.channel === "OTA");
    const direct = channelData.channels.find(ch => ch.channel === "DIRECT");
    const rows = [
      {
        key: "OTA",
        label: "OTA channel partners",
        roomNights: ota?.room_nights ?? 0,
        grossRevenue: ota?.gross_revenue ?? 0,
        netRevenue: ota?.net_revenue ?? 0,
        avgRate: ota?.avg_rate ?? 0,
        commissionPct: ota?.commission_pct ?? 0,
        partners: ota?.partners ?? [],
        expandable: true,
      },
      {
        key: "DIRECT",
        label: "Direct Hotel Front Desk",
        roomNights: direct?.room_nights ?? 0,
        grossRevenue: direct?.gross_revenue ?? 0,
        netRevenue: direct?.net_revenue ?? 0,
        avgRate: direct?.avg_rate ?? 0,
        commissionPct: 0,
        partners: [],
        expandable: false,
      },
    ];
    return rows.map(row => ({
      ...row,
      sharePct: channelData.total_room_nights > 0
        ? Math.round((row.roomNights / channelData.total_room_nights) * 1000) / 10
        : 0,
    }));
  }, [channelData]);

  const rankedPartnerList = useMemo(() => {
    const hasIntel = Object.keys(partnerIntel).length > 0;
    if (!hasIntel) return partnerList;
    return [...partnerList].sort((a, b) => {
      const aHealthPenalty = (partnerHealth[a] ?? "GREEN") === "RED" ? -100 : 0;
      const bHealthPenalty = (partnerHealth[b] ?? "GREEN") === "RED" ? -100 : 0;
      return ((partnerIntel[b]?.score ?? 0) + bHealthPenalty) - ((partnerIntel[a]?.score ?? 0) + aHealthPenalty);
    });
  }, [partnerHealth, partnerIntel, partnerList]);
  const hasPartnerIntel = Object.keys(partnerIntel).length > 0;

  return (
    <div className={overviewStackClass}>
      <Toasts />

      {/* Channel Intelligence */}
      <div className={`${overviewCardLgClass} p-6 sm:p-7`}>
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <div className={overviewEyebrowClass}>OTA Strategy</div>
            <h2 className={`${overviewSectionTitleClass} mt-1`}>Channel Intelligence</h2>
            <p className="text-[11px] text-text-muted mt-2 uppercase tracking-[0.12em] leading-relaxed max-w-2xl">
              Review US-active OTA partner performance, OTA news, and inventory gaps to decide where to push channel slots.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {hasCachedIntel && !channelIntelResult && (
              <button
                onClick={handleLoadCachedIntel}
                className={`${overviewSecondaryBtnClass} px-4 py-2.5`}
              >
                <Clock className="w-3 h-3" /> Previous Intelligence
              </button>
            )}
            <button
              onClick={handleRunChannelIntelligence}
              disabled={channelIntelLoading}
              className="bg-text text-surface text-[10px] font-bold uppercase tracking-[0.12em] px-4 py-2.5 rounded-[10px] hover:opacity-90 active:scale-[0.99] disabled:opacity-40 flex items-center gap-2 transition-all"
            >
              {channelIntelLoading ? (
                <>
                  <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" /> Running Intelligence…
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" /> Run Channel Intelligence
                </>
              )}
            </button>
            <button
              onClick={handleClearPartnerRisk}
              className={`${overviewSecondaryBtnClass} px-4 py-2.5`}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-6">
          {/* Partner Pulse */}
          <div className={`${overviewInsetClass} p-5 sm:p-6`}>
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Partner Recommendations</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                  {channelIntelLoading
                    ? "Analyzing booking history, OTA news, partner health, and open inventory."
                    : hasPartnerIntel
                      ? "Sorted by recommendation priority. Hover any partner for date, room count, value, and rationale."
                      : "Run intelligence to rank OTA partners by where unsold inventory should be pushed."}
                </div>
              </div>
              {hasPartnerIntel && (
                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 border border-accent/30 bg-accent/5 text-accent shrink-0">
                  Hover details
                </span>
              )}
            </div>
            <div className="space-y-2">
              {rankedPartnerList.map((p, idx) => {
                const health = partnerHealth[p] ?? "GREEN";
                const intel = partnerIntel[p];
                const preference = intel?.preference ?? "HOLD";
                return (
                  <div key={p} className={`group relative flex items-center justify-between ${overviewCardClass} px-4 py-3`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-full border-2 ${healthRingClass(health)} bg-surface flex items-center justify-center`}>
                        <span className="text-[10px] font-mono font-bold text-text-muted">{idx + 1}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-text truncate">{p}</div>
                        <div className="text-[10px] text-text-muted uppercase tracking-widest truncate">
                          {channelIntelLoading
                            ? "Analyzing signals"
                            : intel?.checkIn && intel?.checkOut
                              ? `${intel.category ?? "Rooms"} · ${intel.checkIn} → ${intel.checkOut}`
                              : intel
                                ? "No slot push recommended"
                                : health === "GREEN" ? "Awaiting recommendation" : health === "AMBER" ? "Watch" : "High risk"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {intel && (
                        <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 border ${preferenceBadgeClass(preference)}`}>
                          {preference}
                        </span>
                      )}
                      <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 border ${
                        hasPartnerIntel ? healthBadgeClass(health) : baselineBadgeClass()
                      }`}>
                        {hasPartnerIntel ? healthLabel(health) : "Baseline"}
                      </span>
                    </div>
                    {intel && (
                      <div className="pointer-events-none absolute left-4 right-4 top-[calc(100%+8px)] z-20 hidden group-hover:block border border-border bg-surface shadow-lg p-3">
                        <div className="text-[9px] font-bold uppercase tracking-widest text-accent mb-1">
                          Recommendation rationale · {preference} · {intel.confidence}
                        </div>
                        {intel.checkIn && intel.checkOut && (
                          <div className="text-[10px] font-mono text-text mb-2">
                            {intel.category ?? "Rooms"} · {intel.checkIn} → {intel.checkOut} · {intel.roomCount ?? 1} room{(intel.roomCount ?? 1) > 1 ? "s" : ""}
                          </div>
                        )}
                        <div className="text-xs leading-relaxed text-text-muted">{intel.reasoning}</div>
                        {typeof intel.expectedNet === "number" && (
                          <div className="mt-2 text-[10px] font-mono text-occugreen">
                            Expected net ${intel.expectedNet.toLocaleString("en-US")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Manager Brief */}
          <div className={`${overviewInsetClass} p-5 sm:p-6`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Manager Brief</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                  Use the ranked partners to decide which OTA should receive unsold inventory, by date and room category.
                </div>
              </div>
              {channelIntelResult && (
                <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 border ${
                  channelIntelResult.hasRecommendations
                    ? "bg-occugreen/10 border-occugreen/30 text-occugreen"
                    : "bg-surface border-border text-text-muted"
                }`}>
                  {channelIntelResult.hasRecommendations ? "Advisory ready" : "Monitor"}
                </span>
              )}
            </div>

            {channelIntelLoading ? (
              <div className={`mt-4 p-4 sm:p-5 ${overviewCardClass}`}>
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin shrink-0" />
                  <div>
                    <div className="text-[10px] uppercase tracking-widest font-bold text-accent">
                      Building channel recommendation
                    </div>
                    <div className="text-xs text-text-muted mt-1 tabular-nums">
                      {ANALYSIS_STEPS[analysisStepIndex]}<span className="animate-pulse">...</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : channelIntelResult ? (
              <div className={`mt-4 p-4 sm:p-5 ${overviewCardClass}`}>
                <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
                  YieldIQ summary · {channelIntelResult.hasRecommendations ? "slot guidance" : "monitor only"}
                </div>
                <div className="text-xs text-text-muted mt-2 leading-relaxed">{channelIntelResult.summary}</div>
                <div className="mt-2 text-[10px] uppercase tracking-widest text-text-muted">
                  {channelIntelResult.cacheHit ? "Cached intelligence" : "Fresh intelligence"}
                  {channelIntelResult.contextHash ? ` · trace ${channelIntelResult.contextHash}` : ""}
                </div>
              </div>
            ) : (
              <div className={`mt-4 border border-dashed border-border/70 ${overviewInsetClass} p-4 text-xs text-text-muted`}>
                {channelData?.recommendation
                  ? channelData.recommendation
                  : "Run Channel Intelligence to send current inventory, booking history, and date-aware OTA news into YieldIQ for partner-level recommendations."}
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2 text-[10px] text-text-muted">
              {["Booking history", "OTA news", "Partner health", "Inventory gaps"].map(item => (
                <div key={item} className="border border-border/60 bg-surface px-3 py-2 uppercase tracking-widest font-bold">
                  {item}
                </div>
              ))}
            </div>

            {hasPartnerIntel && (
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {rankedPartnerList.slice(0, 3).map((partner) => {
                  const intel = partnerIntel[partner];
                  return (
                    <div key={`focus-${partner}`} className={`${overviewCardClass} p-4`}>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Recommended push</div>
                      <div className="mt-1 text-sm font-bold text-text truncate">{partner}</div>
                      <div className="mt-1 text-[10px] text-text-muted uppercase tracking-widest truncate">
                        {intel?.checkIn && intel?.checkOut
                          ? `${intel.category ?? "Rooms"} · ${intel.checkIn} → ${intel.checkOut}`
                          : "No slot push recommended"}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 border ${preferenceBadgeClass(intel?.preference ?? "HOLD")}`}>
                          {intel?.preference ?? "HOLD"}
                        </span>
                        {typeof intel?.expectedNet === "number" && (
                          <span className="text-[10px] font-mono font-bold text-occugreen">
                            ${intel.expectedNet.toLocaleString("en-US")}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
          <div className="bg-surface border border-border">
            <div className="px-6 py-3 border-b border-border bg-surface-2/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-bold uppercase tracking-widest text-text">Channel Performance</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex rounded-[10px] border border-border/80 overflow-hidden shadow-subtle">
                  {([7, 30, 60] as const).map(w => (
                    <button
                      key={w}
                      onClick={() => setChannelWindow(w)}
                      className={`text-[10px] font-bold uppercase tracking-widest px-3 py-2 transition-colors ${
                        channelWindow === w ? "bg-text text-surface" : "bg-surface text-text-muted hover:bg-surface-2"
                      }`}
                    >
                      {w}d
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => loadChannelData(channelWindow)}
                  className={`${overviewSecondaryBtnClass} px-3 py-2`}
                >
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-text-muted font-bold border-b border-border/50">
                    <th className="px-6 py-3 text-left">Route</th>
                    <th className="px-4 py-3 text-right">Nights</th>
                    <th className="px-4 py-3 text-right">Share</th>
                    <th className="px-4 py-3 text-right">ADR</th>
                    <th className="px-4 py-3 text-right">Commission</th>
                    <th className="px-4 py-3 text-right">Gross</th>
                    <th className="px-6 py-3 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {channelComparison.map(row => {
                    const showPartners = row.key === "OTA" && otaExpanded && row.partners.length > 0;
                    return (
                      <Fragment key={row.key}>
                        <tr key={row.key} className="border-b border-border/30 bg-surface hover:bg-surface-2/30 transition-colors">
                          <td className="px-6 py-3 font-bold text-text">
                            {row.expandable ? (
                              <button
                                type="button"
                                onClick={() => setOtaExpanded(v => !v)}
                                className="flex items-center gap-2 text-left font-bold text-text hover:text-accent transition-colors"
                                aria-expanded={otaExpanded}
                              >
                                {otaExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                {row.label}
                              </button>
                            ) : (
                              <span className="pl-[22px]">{row.label}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-bold text-text">{row.roomNights}</td>
                          <td className="px-4 py-3 text-right text-xs font-bold text-text">{row.sharePct}%</td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-text">${row.avgRate.toLocaleString("en-US")}</td>
                          <td className="px-4 py-3 text-right text-xs text-text-muted">{row.commissionPct}%</td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-text-muted">${row.grossRevenue.toLocaleString("en-US")}</td>
                          <td className="px-6 py-3 text-right font-mono text-xs font-bold text-text">${row.netRevenue.toLocaleString("en-US")}</td>
                        </tr>
                        {showPartners && row.partners.map((pt: PartnerStat) => (
                          <tr key={`ota-${pt.partner}`} className="border-b border-border/10 bg-surface-2/20">
                            <td className="px-6 py-2 pl-12">
                              <span className="text-[10px] text-text-muted font-medium">{pt.partner}</span>
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-[10px] text-text-muted">{pt.room_nights}</td>
                            <td className="px-4 py-2 text-right text-[10px] text-text-muted">{pt.share_of_channel_pct}% of OTA</td>
                            <td className="px-4 py-2 text-right font-mono text-[10px] text-text-muted">${pt.avg_rate.toLocaleString("en-US")}</td>
                            <td className="px-4 py-2 text-right text-[10px] text-text-muted">{row.commissionPct}%</td>
                            <td className="px-4 py-2 text-right font-mono text-[10px] text-text-muted">${pt.gross_revenue.toLocaleString("en-US")}</td>
                            <td className="px-6 py-2 text-right font-mono text-[10px] text-text-muted">${pt.net_revenue.toLocaleString("en-US")}</td>
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
