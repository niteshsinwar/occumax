import { useState, useEffect, useRef } from "react";
import { analysePricing, commitPricing } from "../api/client";
import type { PricingRecommendation, PricingAnalyseResponse } from "../types";
import { useToast } from "./shared/Toast";
import {
  TrendingUp, TrendingDown, DollarSign, Sparkles,
  CheckCircle2, XCircle, Edit2, Loader2,
} from "lucide-react";

const ANALYSIS_STEPS = [
  "Reviewing booking pace for the next 30 days...",
  "Checking pickup trends vs. last year...",
  "Scanning for local events and seasonal demand...",
  "Analysing competitor rate patterns...",
  "Evaluating orphan gaps and fill-rate pressure...",
  "Calculating optimal rate adjustments...",
  "Finalising recommendations...",
];

// ── helpers ────────────────────────────────────────────────────────────────

type Decision = "accepted" | "rejected" | "override" | null;

interface RowState {
  decision: Decision;
  overrideValue: string;
}

function confidenceClass(c: string) {
  if (c === "HIGH")   return "text-occugreen border-occugreen/40 bg-occugreen/5";
  if (c === "MEDIUM") return "text-occuorange border-occuorange/40 bg-occuorange/5";
  return "text-text-muted border-border bg-surface-2";
}

// Group recommendations by category, sort categories, sort dates within each
function groupByCategory(recs: PricingRecommendation[]) {
  const map = new Map<string, PricingRecommendation[]>();
  for (const r of recs) {
    if (!map.has(r.category)) map.set(r.category, []);
    map.get(r.category)!.push(r);
  }
  // Sort dates within each category
  for (const [, rows] of map) rows.sort((a, b) => a.date.localeCompare(b.date));
  // Sort categories alphabetically
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ── PricingPanel ──────────────────────────────────────────────────────────

export function PricingPanel() {
  const [result,     setResult]     = useState<PricingAnalyseResponse | null>(null);
  const [rows,       setRows]       = useState<Record<string, RowState>>({});
  const [analysing,  setAnalysing]  = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed,  setCommitted]  = useState<{ updated: number; skipped: number } | null>(null);
  const [stepIdx,    setStepIdx]    = useState(0);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { show, Toasts } = useToast();

  useEffect(() => {
    if (analysing) {
      setStepIdx(0);
      setCompletedSteps([]);
      let current = 0;
      stepTimerRef.current = setInterval(() => {
        setCompletedSteps(prev => [...prev, current]);
        current += 1;
        setStepIdx(current);
        if (current >= ANALYSIS_STEPS.length - 1) {
          clearInterval(stepTimerRef.current!);
        }
      }, 600);
    } else {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    }
    return () => { if (stepTimerRef.current) clearInterval(stepTimerRef.current); };
  }, [analysing]);

  const runAnalysis = async () => {
    setAnalysing(true);
    setResult(null);
    setCommitted(null);
    try {
      const res  = await analysePricing();
      const data = res.data as PricingAnalyseResponse;
      setResult(data);
      setRows(Object.fromEntries(
        data.recommendations.map(r => [
          `${r.category}-${r.date}`,
          { decision: null, overrideValue: String(r.suggested_rate) },
        ])
      ));
    } catch {
      show("Pricing analysis failed", "error");
    } finally {
      setAnalysing(false);
    }
  };

  const setDecision = (key: string, d: Decision) =>
    setRows(prev => ({ ...prev, [key]: { ...prev[key], decision: d } }));

  const setOverride = (key: string, val: string) =>
    setRows(prev => ({ ...prev, [key]: { ...prev[key], overrideValue: val, decision: "override" } }));

  const acceptAll = () =>
    setRows(prev => Object.fromEntries(
      Object.entries(prev).map(([k, r]) => [k, r.decision === "rejected" ? r : { ...r, decision: "accepted" }])
    ));

  const handleCommit = async () => {
    if (!result) return;
    const items: { category: string; date: string; new_rate: number }[] = [];
    result.recommendations.forEach(rec => {
      const row = rows[`${rec.category}-${rec.date}`];
      if (!row || row.decision === "rejected" || row.decision === null) return;
      const rate = row.decision === "override"
        ? Math.round(parseFloat(row.overrideValue) / 100) * 100
        : rec.suggested_rate;
      if (!isNaN(rate) && rate > 0)
        items.push({ category: rec.category, date: rec.date, new_rate: rate });
    });
    if (!items.length) { show("No accepted recommendations to commit", "error"); return; }
    setCommitting(true);
    try {
      const res = await commitPricing(items);
      setCommitted(res.data);
      show(`${res.data.updated} rate updates applied`, "success");
    } catch {
      show("Commit failed", "error");
    } finally {
      setCommitting(false);
    }
  };

  const accepted = Object.values(rows).filter(r => r.decision === "accepted" || r.decision === "override").length;
  const rejected = Object.values(rows).filter(r => r.decision === "rejected").length;
  const pending  = Object.values(rows).filter(r => r.decision === null).length;

  const grouped = result ? groupByCategory(result.recommendations) : [];

  // Demand signals derived from recommendations
  const signals = result ? (() => {
    const recs = result.recommendations;
    const highDemand  = recs.filter(r => r.occupancy_pct > 80);
    const lowDemand   = recs.filter(r => r.occupancy_pct < 30);
    const increasing  = recs.filter(r => r.change_pct > 0);
    const decreasing  = recs.filter(r => r.change_pct < 0);
    const highCats    = [...new Set(highDemand.map(r => r.category))];
    const lowCats     = [...new Set(lowDemand.map(r => r.category))];
    return { highDemand, lowDemand, increasing, decreasing, highCats, lowCats };
  })() : null;


  return (
    <div className="h-full flex flex-col">
      <Toasts />

      {/* ── toolbar ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-accent" />
          <div>
            <div className="text-sm font-bold text-text">Dynamic Pricing AI</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted font-bold">
              Gemini analyses occupancy + pickup to recommend per-category daily rates
            </div>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          {result && !committed && (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mr-2 hidden sm:block">
                <span className="text-text">{pending}</span> pending ·{" "}
                <span className="text-occugreen">{accepted}</span> accepted ·{" "}
                <span className="text-occured">{rejected}</span> rejected
              </div>
              <button
                className="text-[11px] uppercase tracking-widest font-bold text-text-muted hover:text-text border border-border px-3 py-2 hover:bg-surface-2 transition-colors"
                onClick={acceptAll}
              >
                Accept All
              </button>
              <button
                className="bg-occugreen text-white text-[11px] uppercase tracking-widest font-bold px-5 py-2 hover:brightness-110 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40"
                onClick={handleCommit}
                disabled={committing || accepted === 0}
              >
                {committing
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Committing</>
                  : <><CheckCircle2 className="w-3 h-3" /> Confirm ({accepted})</>}
              </button>
            </>
          )}
          {(!result || committed) && (
            <button
              className="bg-text text-surface text-[11px] uppercase tracking-widest font-bold px-5 py-2 hover:bg-text/90 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40"
              onClick={runAnalysis}
              disabled={analysing}
            >
              {analysing
                ? <><Loader2 className="w-3 h-3 animate-spin" /> Analysing</>
                : <><DollarSign className="w-3 h-3" /> Run Analysis</>}
            </button>
          )}
        </div>
      </div>

      {/* ── idle ───────────────────────────────────────────────────────── */}
      {!result && !analysing && !committed && (
        <div className="flex-1 flex flex-col items-center justify-center py-24 text-center px-6">
          <DollarSign className="w-8 h-8 text-accent/30 mb-5" />
          <h3 className="font-serif font-bold text-xl text-text mb-2">Revenue Rate Intelligence</h3>
          <p className="text-xs text-text-muted max-w-sm leading-relaxed">
            AI evaluates occupancy, lead time, and pickup pace across all categories
            and produces a before/after rate comparison for manager review.
          </p>
        </div>
      )}

      {/* ── loading: step-by-step analysis sequence ─────────────────── */}
      {analysing && (
        <div className="flex-1 flex flex-col items-center justify-center py-16 px-8">
          <div className="w-full max-w-sm">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-8 h-8 border-2 border-border border-t-accent rounded-full animate-spin shrink-0" />
              <div>
                <div className="text-sm font-bold text-text font-serif">AI Pricing Analysis</div>
                <div className="text-[10px] text-text-muted uppercase tracking-widest font-bold">Powered by Gemini</div>
              </div>
            </div>
            <div className="space-y-3">
              {ANALYSIS_STEPS.map((step, i) => {
                const done    = completedSteps.includes(i);
                const active  = i === stepIdx;
                const hidden  = i > stepIdx;
                return (
                  <div
                    key={step}
                    className={`flex items-center gap-3 transition-all duration-500 ${hidden ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"}`}
                  >
                    <div className={`w-4 h-4 rounded-full shrink-0 flex items-center justify-center border transition-all duration-300 ${
                      done   ? "bg-occugreen border-occugreen"  :
                      active ? "border-accent bg-accent/10 animate-pulse" :
                               "border-border bg-surface-2"
                    }`}>
                      {done && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <span className={`text-xs transition-colors duration-300 ${
                      done   ? "text-text-muted line-through decoration-text-muted/40" :
                      active ? "text-text font-medium"  :
                               "text-text-muted/40"
                    }`}>
                      {step}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── committed success ─────────────────────────────────────────── */}
      {committed && (
        <div className="flex-1 flex items-center justify-between px-10 py-12 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-occugreen" />
          <div>
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-[0.15em]">Rates Updated</div>
            <div className="text-4xl font-serif font-bold text-occugreen mt-1">
              {committed.updated} slot{committed.updated !== 1 ? "s" : ""} updated
            </div>
            {committed.skipped > 0 && (
              <div className="text-xs text-text-muted mt-1">
                {committed.skipped} item{committed.skipped !== 1 ? "s" : ""} skipped (below floor rate)
              </div>
            )}
            <button
              className="mt-6 text-xs uppercase tracking-widest font-bold border border-border px-5 py-2 hover:bg-surface-2 transition-colors text-text"
              onClick={runAnalysis}
            >
              Run New Analysis
            </button>
          </div>
          <TrendingUp className="w-14 h-14 text-occugreen opacity-70" />
        </div>
      )}

      {/* ── comparison table ──────────────────────────────────────────── */}
      {result && !committed && (
        <div className="flex-1 overflow-y-auto">

          {/* Demand signals strip */}
          {signals && (signals.highDemand.length > 0 || signals.lowDemand.length > 0) && (
            <div className="px-6 py-3 border-b border-border bg-surface-2/40 flex flex-wrap gap-3 items-center">
              <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted shrink-0">Demand Signals</span>
              {signals.highCats.length > 0 && (
                <span className="flex items-center gap-1.5 text-[10px] font-bold text-occugreen bg-occugreen/8 border border-occugreen/20 px-2.5 py-1">
                  <TrendingUp className="w-3 h-3" />
                  {signals.highCats.join(", ")} — high demand · {signals.increasing.length} date{signals.increasing.length !== 1 ? "s" : ""} to increase
                </span>
              )}
              {signals.lowCats.length > 0 && (
                <span className="flex items-center gap-1.5 text-[10px] font-bold text-occuorange bg-occuorange/8 border border-occuorange/20 px-2.5 py-1">
                  <TrendingDown className="w-3 h-3" />
                  {signals.lowCats.join(", ")} — low fill · {signals.decreasing.length} date{signals.decreasing.length !== 1 ? "s" : ""} need discounting
                </span>
              )}
              <span className="ml-auto text-[9px] text-text-muted font-medium shrink-0">
                Pune market · {new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
              </span>
            </div>
          )}

          {/* AI summary banner */}
          <div className="px-6 py-4 bg-accent/5 border-b border-accent/20 text-sm text-text leading-relaxed">
            <span className="text-[10px] font-bold uppercase tracking-widest text-accent mr-2">AI Summary</span>
            {result.summary}
          </div>

          {result.recommendations.length === 0 && (
            <div className="py-20 text-center text-sm text-text-muted">
              All categories are within optimal range — no pricing actions needed.
            </div>
          )}

          {grouped.map(([category, recs]) => (
            <div key={category} className="border-b border-border last:border-0">
              {/* Category header */}
              <div className="px-6 py-3 bg-surface-2/60 border-b border-border/50 flex items-center gap-3 sticky top-0 z-10">
                <span className="text-[10px] font-bold uppercase tracking-widest border border-border px-2.5 py-1 bg-surface text-text">
                  {category}
                </span>
                <span className="text-xs text-text-muted">{recs.length} date{recs.length !== 1 ? "s" : ""} flagged</span>
              </div>

              {/* Comparison table */}
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-text-muted font-bold border-b border-border/40">
                    <th className="px-6 py-2.5 text-left">Date</th>
                    <th className="px-4 py-2.5 text-right">Occupancy</th>
                    <th className="px-4 py-2.5 text-right">Before</th>
                    <th className="px-4 py-2.5 text-center w-8"></th>
                    <th className="px-4 py-2.5 text-right">After</th>
                    <th className="px-4 py-2.5 text-right">Change</th>
                    <th className="px-4 py-2.5 text-left">Confidence</th>
                    <th className="px-6 py-2.5 text-left">Reasoning</th>
                    <th className="px-6 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {recs.map((rec) => {
                    const key = `${rec.category}-${rec.date}`;
                    const row = rows[key];
                    if (!row) return null;
                    const isAccepted = row.decision === "accepted";
                    const isRejected = row.decision === "rejected";
                    const isOverride = row.decision === "override";
                    const isIncrease = rec.change_pct > 0;

                    return (
                      <tr
                        key={`${category}-${rec.date}`}
                        className={`border-b border-border/30 transition-colors ${
                          isRejected ? "opacity-35 line-through-[unset]" :
                          isAccepted || isOverride ? "bg-occugreen/[0.03]" :
                          "hover:bg-surface-2/40"
                        }`}
                      >
                        {/* Date */}
                        <td className="px-6 py-3 font-mono text-xs text-text whitespace-nowrap">
                          {rec.date}
                        </td>

                        {/* Occupancy */}
                        <td className="px-4 py-3 text-right">
                          <span className={`text-xs font-bold ${
                            rec.occupancy_pct > 80 ? "text-occugreen" :
                            rec.occupancy_pct < 40 ? "text-occured" : "text-text-muted"
                          }`}>
                            {rec.occupancy_pct}%
                          </span>
                          <div className="text-[9px] text-text-muted">{rec.otb} OTB</div>
                        </td>

                        {/* Before */}
                        <td className="px-4 py-3 text-right font-mono text-xs text-text-muted line-through decoration-text-muted/40">
                          ${rec.current_rate.toLocaleString("en-US")}
                        </td>

                        {/* Arrow */}
                        <td className="px-1 py-3 text-center">
                          {isIncrease
                            ? <TrendingUp  className="w-3.5 h-3.5 text-occugreen mx-auto" />
                            : <TrendingDown className="w-3.5 h-3.5 text-occured mx-auto" />}
                        </td>

                        {/* After / override input */}
                        <td className="px-4 py-3 text-right">
                          {isOverride ? (
                            <div className="flex items-center justify-end gap-1">
                              <span className="text-[10px] text-text-muted">$</span>
                              <input
                                type="number"
                                step="100"
                                value={row.overrideValue}
                                onChange={e => setOverride(key, e.target.value)}
                                className="w-20 bg-surface border border-accent text-text text-xs font-mono text-right px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent"
                              />
                            </div>
                          ) : (
                            <span className={`font-mono text-xs font-bold ${
                              isIncrease ? "text-occugreen" : "text-occured"
                            }`}>
                              ${rec.suggested_rate.toLocaleString("en-US")}
                            </span>
                          )}
                        </td>

                        {/* Change % */}
                        <td className="px-4 py-3 text-right">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 ${
                            isIncrease ? "bg-occugreen/10 text-occugreen" : "bg-occured/10 text-occured"
                          }`}>
                            {rec.change_pct > 0 ? "+" : ""}{rec.change_pct}%
                          </span>
                        </td>

                        {/* Confidence */}
                        <td className="px-4 py-3">
                          <span className={`text-[9px] font-bold uppercase tracking-wider border px-2 py-0.5 ${confidenceClass(rec.confidence)}`}>
                            {rec.confidence}
                          </span>
                        </td>

                        {/* Reasoning */}
                        <td className="px-6 py-3 text-xs text-text-muted max-w-xs leading-relaxed">
                          {rec.reason}
                        </td>

                        {/* Action buttons */}
                        <td className="px-6 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {!isAccepted && !isOverride && (
                              <button
                                title="Accept suggested rate"
                                className="p-1.5 hover:bg-occugreen/10 text-occugreen/50 hover:text-occugreen transition-colors rounded-sm"
                                onClick={() => setDecision(key, "accepted")}
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            )}
                            {(isAccepted || isOverride) && (
                              <span className={`text-[9px] font-bold uppercase tracking-wider ${isOverride ? "text-accent" : "text-occugreen"}`}>
                                {isOverride ? "Override" : "✓"}
                              </span>
                            )}
                            <button
                              title={isOverride ? "Cancel override" : "Override rate"}
                              className={`p-1.5 rounded-sm transition-colors ${
                                isOverride ? "text-accent bg-accent/10" : "text-text-muted hover:text-accent hover:bg-accent/10"
                              }`}
                              onClick={() => setDecision(key, isOverride ? null : "override")}
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              title={isRejected ? "Undo reject" : "Reject"}
                              className={`p-1.5 rounded-sm transition-colors ${
                                isRejected ? "text-occured bg-occured/10" : "text-text-muted hover:text-occured hover:bg-occured/10"
                              }`}
                              onClick={() => setDecision(key, isRejected ? null : "rejected")}
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
