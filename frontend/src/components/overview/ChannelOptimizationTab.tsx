import { useCallback, useEffect, useMemo, useState } from "react";
import {
  channelAllocate,
  getChannelPartners,
  getChannelPerformance,
  getChannelRecommendations,
} from "../../api/client";
import type {
  ChannelPerformanceResponse,
  ChannelRecommendResponse,
  ChannelRecommendation,
  ChannelStat,
} from "../../types";
import { useToast } from "../shared/Toast";
import {
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  TrendingUp,
  XCircle,
} from "lucide-react";

const ALLOC_CATS = ["STANDARD", "STUDIO", "DELUXE", "SUITE", "PREMIUM", "ECONOMY"];

/**
 * Channel Insights and Optimization tab.
 * Pulled from the legacy Manager page Channels tab to be reused inside Overview.
 */
export function ChannelOptimizationTab() {
  const { show, Toasts } = useToast();

  const [channelData, setChannelData] = useState<ChannelPerformanceResponse | null>(null);
  const [channelLoading, setChannelLoading] = useState(false);
  const [channelWindow, setChannelWindow] = useState<7 | 30 | 60>(30);

  // Channel allocation form state — partner list fetched from backend
  const [allocSources, setAllocSources] = useState<string[]>([]);
  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);
  const defaultOut = useMemo(() => new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0], []);
  const [allocSource, setAllocSource] = useState("");
  const [allocCat, setAllocCat] = useState("DELUXE");
  const [allocIn, setAllocIn] = useState(todayStr);
  const [allocOut, setAllocOut] = useState(defaultOut);
  const [allocCount, setAllocCount] = useState(1);
  const [allocLoading, setAllocLoading] = useState(false);
  const [allocResult, setAllocResult] = useState<{ message: string; rooms: string[]; booking_ids: string[] } | null>(null);

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
        setAllocSources(sources);
        setAllocSource(prev => prev || sources[2] || sources[0]);
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
        setAllocSources(fallback);
        setAllocSource(prev => prev || "MakeMyTrip");
      });
  }, []);

  const handleAllocate = async () => {
    if (!allocIn || !allocOut || allocCount < 1) return;
    setAllocLoading(true);
    setAllocResult(null);
    try {
      const res = await channelAllocate({
        booking_source: allocSource,
        category: allocCat,
        check_in: allocIn,
        check_out: allocOut,
        room_count: allocCount,
      });
      setAllocResult(res.data);
      show(res.data.message, "success");
      loadChannelData(channelWindow);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Allocation failed";
      show(msg, "error");
    } finally {
      setAllocLoading(false);
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
    } catch {
      show("AI channel analysis failed", "error");
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

  return (
    <div className="space-y-6">
      <Toasts />

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
          {/* AI Allocation Recommendation */}
          <div className="bg-accent/5 border border-accent/20 p-6">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-accent" />
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">Revenue Intelligence · Channel Optimisation</div>
                <p className="text-sm text-text leading-relaxed mb-4">{channelData.recommendation}</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
                  {channelData.channels.slice(0, 3).map((ch: ChannelStat) => {
                    const netPct = channelData.total_gross_revenue > 0 ? Math.round((ch.net_revenue / channelData.total_gross_revenue) * 100) : 0;
                    const advice =
                      ch.commission_pct === 0
                        ? "Maximise allocation — zero commission, full revenue retained"
                        : ch.share_pct > 50
                          ? "High dependency — reduce allocation, push direct equivalent"
                          : ch.share_pct < 10
                            ? "Low volume — consider increasing if direct inventory is full"
                            : "Balanced — maintain current allocation";
                    return (
                      <div key={ch.channel} className="bg-surface border border-border p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-text">{ch.channel}</span>
                          <span className="text-[10px] font-bold text-text-muted">{netPct}% of net</span>
                        </div>
                        <div className="text-[10px] text-text-muted leading-relaxed">{advice}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* AI Channel Recommendation Panel */}
          <div className="border border-accent/20 bg-accent/5 p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-accent">Gemini AI · Channel Allocation</div>
                  <div className="text-[10px] text-text-muted mt-0.5">Analyses 14-day gaps + partner history to recommend where to push inventory</div>
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
                <p className="text-xs text-text-muted">Gemini is analysing your inventory gaps and channel history…</p>
              </div>
            )}

            {aiRecs && !aiRecsLoading && (
              <div className="space-y-3">
                {aiRecs.summary && (
                  <div className="bg-surface border border-border p-4 text-sm text-text leading-relaxed">
                    {aiRecs.summary}
                  </div>
                )}
                {aiRecs.recommendations.length === 0 && (
                  <div className="py-8 text-center text-xs text-text-muted">No recommendations — your channel mix looks healthy.</div>
                )}
                {aiRecs.recommendations.map((rec: ChannelRecommendation, idx: number) => {
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
                              Gross <span className="text-text font-bold">₹{rec.expected_gross.toLocaleString()}</span>
                            </span>
                            {rec.commission_cost > 0 && <span className="text-occuorange">Commission −₹{rec.commission_cost.toLocaleString()}</span>}
                            <span className="text-occugreen font-bold">Net ₹{rec.expected_net.toLocaleString()}</span>
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
                                className="bg-text text-surface text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 hover:opacity-90 active:scale-95 flex items-center gap-1 transition-all"
                              >
                                <CheckCircle2 className="w-3 h-3" /> Commit
                              </button>
                              <button
                                onClick={() => setSkippedRecs(prev => new Set(prev).add(idx))}
                                className="bg-surface border border-border text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 hover:bg-surface-2 active:scale-95 flex items-center gap-1 transition-all text-text-muted"
                              >
                                <XCircle className="w-3 h-3" /> Skip
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

            {!aiRecs && !aiRecsLoading && (
              <div className="py-8 text-center text-xs text-text-muted border border-dashed border-accent/20">
                Press "Run AI Analysis" — Gemini will check your gaps and recommend channel allocations.
              </div>
            )}
          </div>

          {/* Channel Allocation Commit Panel */}
          <div className="border border-border bg-surface p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-8 h-8 bg-text/5 border border-border flex items-center justify-center shrink-0">
                <TrendingUp className="w-4 h-4 text-text" />
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-text">Commit Channel Allocation</div>
                <div className="text-[10px] text-text-muted mt-0.5">Pre-block inventory for a booking source based on AI recommendation</div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Booking Source</label>
                <select
                  value={allocSource}
                  onChange={e => setAllocSource(e.target.value)}
                  className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                >
                  {allocSources.map(s => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Category</label>
                <select
                  value={allocCat}
                  onChange={e => setAllocCat(e.target.value)}
                  className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                >
                  {ALLOC_CATS.map(c => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Check-in</label>
                <input
                  type="date"
                  value={allocIn}
                  min={todayStr}
                  onChange={e => setAllocIn(e.target.value)}
                  className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Check-out</label>
                <input
                  type="date"
                  value={allocOut}
                  min={allocIn}
                  onChange={e => setAllocOut(e.target.value)}
                  className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Rooms</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={allocCount}
                  onChange={e => setAllocCount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full bg-surface-2 border border-border text-xs px-2 py-2 text-text focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={handleAllocate}
                  disabled={allocLoading}
                  className="w-full bg-text text-surface font-bold uppercase tracking-widest text-[10px] px-3 py-2 hover:opacity-90 active:scale-95 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
                >
                  {allocLoading ? (
                    <>
                      <AlertTriangle className="w-3 h-3 animate-pulse" />
                      Working…
                    </>
                  ) : (
                    <>Allocate</>
                  )}
                </button>
              </div>
            </div>

            {allocResult && (
              <div className="bg-occugreen/5 border border-occugreen/30 p-3 text-xs">
                <div className="font-bold text-occugreen uppercase tracking-widest text-[10px] mb-1">Allocation committed</div>
                <div className="text-text">{allocResult.message}</div>
                {allocResult.rooms.length > 0 && (
                  <div className="text-text-muted mt-1">
                    Rooms: {allocResult.rooms.join(", ")} · Booking IDs: {allocResult.booking_ids.join(", ")}
                  </div>
                )}
              </div>
            )}
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

