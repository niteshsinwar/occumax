import { useCallback, useEffect, useMemo, useState } from "react";
import { commitPlan, fireOptimise, getHeatmap, patchSlot } from "../../api/client";
import type { GapInfo, HeatmapResponse, HeatmapRow, OptimiseResult, SwapStep } from "../../types";
import { HeatmapGrid } from "../Heatmap/HeatmapGrid";
import { useToast } from "../shared/Toast";
import { simulateRows } from "../../utils/simulateRows";
import {
  Zap,
  CheckCircle2,
  XCircle,
  Lock,
  Unlock,
  TrendingUp,
} from "lucide-react";

type Stage = "idle" | "processing" | "preview" | "applied" | "converged";

// ── Run-metric helpers ────────────────────────────────────────────────────────

type RunMetrics = {
  orphanGaps: number;
  orphanNights: number;
  dist: { n1: number; n2_3: number; n4_7: number; n8p: number };
};

/**
 * Scan heatmap rows and classify consecutive EMPTY runs by length.
 * Orphan = EMPTY run ≤5 nights bounded by SOFT/HARD on both sides.
 */
function computeRunMetrics(rows: HeatmapRow[], maxDays = 20): RunMetrics {
  const runs: Array<{ length: number; isOrphan: boolean }> = [];
  for (const row of rows) {
    const cells = row.cells.slice(0, maxDays);
    let i = 0;
    while (i < cells.length) {
      if (cells[i].block_type !== "EMPTY") {
        i++;
        continue;
      }
      const start = i;
      while (i < cells.length && cells[i].block_type === "EMPTY") i++;
      const length = i - start;
      const before = start > 0 ? cells[start - 1].block_type : null;
      const after = i < cells.length ? cells[i].block_type : null;
      const isOrphan =
        length <= 5 &&
        (before === "SOFT" || before === "HARD") &&
        (after === "SOFT" || after === "HARD");
      runs.push({ length, isOrphan });
    }
  }
  const orphans = runs.filter(r => r.isOrphan);
  return {
    orphanGaps: orphans.length,
    orphanNights: orphans.reduce((s, r) => s + r.length, 0),
    dist: {
      n1: runs.filter(r => r.length === 1).length,
      n2_3: runs.filter(r => r.length >= 2 && r.length <= 3).length,
      n4_7: runs.filter(r => r.length >= 4 && r.length <= 7).length,
      n8p: runs.filter(r => r.length >= 8).length,
    },
  };
}

const BUCKETS: Array<{
  label: string;
  key: keyof RunMetrics["dist"];
  desc: string;
  positiveIsMore: boolean;
}> = [
  { label: "1 night", key: "n1", desc: "Almost impossible to fill", positiveIsMore: false },
  { label: "2–3 nights", key: "n2_3", desc: "Short gaps — hard to sell", positiveIsMore: false },
  { label: "4–7 nights", key: "n4_7", desc: "Standard stays — easy to book", positiveIsMore: true },
  { label: "8+ nights", key: "n8p", desc: "Long stretches — high value guests", positiveIsMore: true },
];

function RunDistributionWidget({
  current,
  projected,
  stage,
}: {
  current: RunMetrics;
  projected: RunMetrics | null;
  stage: Stage;
}) {
  const showProjected = projected !== null && (stage === "preview" || stage === "applied");
  const maxVal = Math.max(
    ...BUCKETS.flatMap(b => [current.dist[b.key], projected ? projected.dist[b.key] : 0]),
    1,
  );

  return (
    <div className="bg-surface border border-border shadow-subtle p-6 mb-8">
      <div className="flex items-center justify-between mb-5 pb-4 border-b border-border/50">
        <div>
          <h3 className="font-serif font-bold text-lg text-text">Booking gap analysis</h3>
          <p className="text-[10px] text-text-muted mt-0.5 uppercase tracking-widest font-bold">
            {showProjected ? "Current vs after applying fixes" : "How your empty nights are distributed — next 20 days"}
          </p>
        </div>
        {showProjected && (
          <div className="flex items-center gap-5 text-[9px] font-bold uppercase tracking-widest text-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-text/20 inline-block border border-border/60" /> Current
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-occugreen/50 inline-block border border-occugreen/30" /> Projected
            </span>
          </div>
        )}
      </div>

      <div className="space-y-5">
        {BUCKETS.map(({ label, key, desc, positiveIsMore }) => {
          const cur = current.dist[key];
          const proj = projected?.dist[key] ?? null;
          const delta = proj !== null ? proj - cur : null;
          const isGoodDelta = delta !== null && (positiveIsMore ? delta > 0 : delta < 0);
          const isBadDelta = delta !== null && delta !== 0 && !isGoodDelta;
          return (
            <div key={key} className="flex items-start gap-4">
              <div className="w-28 shrink-0 text-right pt-0.5">
                <div className="text-[10px] font-bold text-text uppercase tracking-wider leading-tight">{label}</div>
                <div className="text-[9px] text-text-muted mt-0.5 leading-tight hidden sm:block">{desc}</div>
              </div>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-6 bg-surface-2 relative overflow-hidden border border-border/50">
                    <div
                      className={`h-full transition-all duration-500 ${positiveIsMore ? "bg-accent/25" : "bg-occured/20"}`}
                      style={{ width: cur > 0 ? `${Math.max((cur / maxVal) * 100, 5)}%` : "0%" }}
                    />
                    <span className="absolute left-2 top-0 h-full flex items-center text-[10px] font-bold text-text">
                      {cur} run{cur !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                {showProjected && proj !== null && (
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-6 relative overflow-hidden border bg-occugreen/5 border-occugreen/20">
                      <div
                        className="h-full bg-occugreen/50 transition-all duration-700"
                        style={{ width: proj > 0 ? `${Math.max((proj / maxVal) * 100, 5)}%` : "0%" }}
                      />
                      <span className="absolute left-2 top-0 h-full flex items-center gap-2 text-[10px] font-bold text-occugreen">
                        {proj} run{proj !== 1 ? "s" : ""}
                        {delta !== null && delta !== 0 && (
                          <span className={`text-[9px] font-black ${isGoodDelta ? "text-occugreen" : isBadDelta ? "text-occured" : ""}`}>
                            {delta > 0 ? `+${delta}` : delta}
                          </span>
                        )}
                        {delta === 0 && <span className="text-[9px] text-text-muted font-normal">no change</span>}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GapEntry({ gap }: { gap: GapInfo }) {
  return (
    <div className="bg-surface-2 border border-border/50 p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full bg-accent" />
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[9px] font-bold tracking-wider uppercase bg-accent-dim text-accent px-2 py-0.5 border border-accent/20">
          Room move
        </span>
        <span className="text-xs text-text font-medium">
          Room {gap.room_id} · {gap.gap_length}-night gap · {gap.date_range}
        </span>
        <span className="ml-auto text-[10px] font-bold text-occugreen uppercase tracking-wider">
          {gap.gap_length} nights recovered
        </span>
      </div>
      <div className="pl-2 border-l border-border/60 ml-2 space-y-1.5">
        {gap.shuffle_plan.map((step, i) => (
          <div key={i} className="text-[11px] text-text-muted flex items-center gap-2">
            <span className="text-text font-mono tracking-tighter">{step.booking_id.slice(-6)}</span>
            <span className="bg-surface border border-border px-1.5 py-0.5">{step.from_room}</span>
            <span className="text-border">&rarr;</span>
            <span className="bg-surface border border-border font-bold text-text px-1.5 py-0.5">{step.to_room}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Occupancy Insights and Optimization tab: full calendar gap scan, before/after preview, and commit.
 * Pulled from the legacy Manager page Yield tab to be reused inside Overview.
 */
export function OccupancyOptimizationTab() {
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [gaps, setGaps] = useState<GapInfo[]>([]);
  const [swapPlan, setSwapPlan] = useState<SwapStep[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [loadingCommit, setLoadingCommit] = useState(false);
  const [slotModal, setSlotModal] = useState<{ id: string; room: string; date: string; block: string } | null>(null);
  const [appliedGains, setAppliedGains] = useState<{ gapsElim: number; nightsFreed: number; shuffleCount: number } | null>(null);
  const [convergedState, setConvergedState] = useState<"clean" | "stuck">("clean");

  const { show, Toasts } = useToast();

  const loadHeatmap = useCallback(async () => {
    try {
      const h = await getHeatmap();
      setHeatmap(h.data);
    } catch {
      show("Failed to load heatmap", "error");
    }
  }, [show]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  const runOptimization = async () => {
    setStage("processing");
    try {
      const res = await fireOptimise();
      const result = res.data as OptimiseResult;
      await loadHeatmap();

      if (result.fully_clean || result.converged) {
        setConvergedState(result.fully_clean ? "clean" : "stuck");
        setGaps([]);
        setSwapPlan([]);
        setStage("converged");
        return;
      }

      setGaps(result.gaps);
      setSwapPlan(result.swap_plan);
      setStage("preview");
    } catch {
      show("Failed to run optimization", "error");
      setStage("idle");
    }
  };

  const simulated = useMemo(
    () => (heatmap ? simulateRows(heatmap.rows, swapPlan) : []),
    [heatmap, swapPlan],
  );

  const currentMetrics = useMemo(
    () => (heatmap ? computeRunMetrics(heatmap.rows) : null),
    [heatmap],
  );

  const projectedMetrics = useMemo(
    () => (stage === "preview" && gaps.length > 0 ? computeRunMetrics(simulated) : null),
    [simulated, stage, gaps.length],
  );

  const handleCommit = async () => {
    if (!swapPlan.length) return;

    const gapsElim = projectedMetrics ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps : 0;
    const nightsFreed = projectedMetrics ? (currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights : 0;

    setLoadingCommit(true);
    show(`Committing ${swapPlan.length} optimization steps…`, "info");
    try {
      await commitPlan(swapPlan);
      setAppliedGains({ gapsElim, nightsFreed, shuffleCount: swapPlan.length });
      setGaps([]);
      setSwapPlan([]);
      await loadHeatmap();
      setStage("applied");
      show(`${swapPlan.length} room moves applied — calendar optimised`, "success");
    } catch {
      show("Commit failed", "error");
    } finally {
      setLoadingCommit(false);
    }
  };

  const handleSlotPatch = async (block_type: "EMPTY" | "HARD") => {
    if (!slotModal) return;
    try {
      await patchSlot(slotModal.id, { block_type, reason: "Manual edit by manager" });
      setSlotModal(null);
      await loadHeatmap();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Cannot edit this slot";
      show(msg, "error");
    }
  };

  return (
    <div>
      <Toasts />

      {/* Slot edit modal */}
      {slotModal && (
        <div className="fixed inset-0 bg-text/60 backdrop-blur-sm flex items-center justify-center z-[999]">
          <div className="bg-surface border border-border shadow-2xl p-6 w-full max-w-sm">
            <h2 className="font-serif font-bold text-xl text-text mb-2">Configure Slot</h2>
            <div className="text-sm text-text-muted mb-6 flex items-center gap-2">
              Room {slotModal.room} · {slotModal.date}
              <span
                className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 border ${
                  slotModal.block === "EMPTY"
                    ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                    : slotModal.block === "SOFT"
                      ? "bg-sky-100 text-sky-800 border-sky-300"
                      : "bg-stone-100 text-stone-700 border-stone-300"
                }`}
              >
                {slotModal.block}
              </span>
            </div>
            {slotModal.block === "SOFT" ? (
              <div className="bg-occuorange/10 border border-occuorange/20 text-occuorange text-xs font-semibold p-3 mb-6">
                Active guest reservation. Cannot override manually.
              </div>
            ) : (
              <div className="flex gap-2 mb-6">
                {slotModal.block !== "EMPTY" && (
                  <button
                    className="flex-1 bg-occugreen text-white text-sm font-semibold hover:bg-occugreen/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                    onClick={() => handleSlotPatch("EMPTY")}
                  >
                    <Unlock className="w-3.5 h-3.5" /> Free
                  </button>
                )}
                {slotModal.block !== "HARD" && (
                  <button
                    className="flex-1 bg-text text-surface text-sm font-semibold hover:bg-text/90 active:scale-95 py-2.5 transition-all flex justify-center items-center gap-1.5"
                    onClick={() => handleSlotPatch("HARD")}
                  >
                    <Lock className="w-3.5 h-3.5" /> Block
                  </button>
                )}
              </div>
            )}
            <button
              className="w-full bg-surface-2 text-text text-sm font-semibold hover:bg-border active:scale-95 py-2.5 transition-all border border-border"
              onClick={() => setSlotModal(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex items-end justify-between mb-8 border-b border-border/50">
        <div className="pb-3">
          <div className="text-xs tracking-wider text-text-muted uppercase">
            {stage === "idle" && "Find and fix empty nights trapped between bookings"}
            {stage === "processing" && "Scanning your booking calendar..."}
            {stage === "preview" && "Here's what we can fix — review and confirm"}
            {stage === "applied" && "Changes applied successfully"}
            {stage === "converged" &&
              (convergedState === "clean"
                ? "Your calendar is clean — no gaps to fix right now"
                : "Some gaps exist but can't be moved without disturbing current guests")}
          </div>
        </div>
        <div className="flex gap-3 pb-3">
          {(stage === "idle" || stage === "applied" || stage === "converged") && (
            <button
              className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all shadow-sm flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-text"
              onClick={runOptimization}
            >
              <Zap className="w-3.5 h-3.5 text-accent" /> Find & Fix Gaps
            </button>
          )}
          {stage === "processing" && (
            <button
              className="bg-surface-2 text-text font-semibold disabled:opacity-40 flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-border"
              disabled
            >
              <div className="w-3 h-3 border border-text border-t-accent rounded-full animate-spin" /> Processing
            </button>
          )}
          {stage === "preview" && (
            <>
              <button
                className="bg-accent text-white font-semibold hover:brightness-110 active:scale-95 disabled:opacity-40 shadow-sm flex items-center gap-2 text-xs uppercase tracking-widest px-6 py-3 rounded-sm border border-accent"
                onClick={handleCommit}
                disabled={loadingCommit || !swapPlan.length}
              >
                {loadingCommit ? (
                  <>
                    <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" /> Committing
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" /> Commit All ({swapPlan.length})
                  </>
                )}
              </button>
              <button
                className="bg-surface hover:bg-surface-2 border border-border text-text text-xs uppercase tracking-widest px-6 py-3 font-semibold rounded-sm transition-colors flex items-center gap-2"
                onClick={() => {
                  setGaps([]);
                  setSwapPlan([]);
                  setStage("idle");
                }}
              >
                <XCircle className="w-3.5 h-3.5 text-text-muted" /> Discard
              </button>
            </>
          )}
        </div>
      </div>

      {/* Operational KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        {[
          {
            label: "Empty Gaps",
            value: currentMetrics?.orphanGaps ?? "—",
            sub: `${currentMetrics?.orphanNights ?? 0} nights stuck between bookings`,
            color: "border-occured text-occured",
          },
          {
            label: "Hard to Fill",
            value: (currentMetrics?.dist.n1 ?? 0) + (currentMetrics?.dist.n2_3 ?? 0),
            sub: "1–3 night gaps — guests rarely book these",
            color: "border-occuorange text-occuorange",
          },
          (() => {
            const delta = projectedMetrics != null ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps : null;
            const nightsDelta =
              projectedMetrics != null ? (currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights : null;
            const improved = delta !== null && delta > 0;
            const neutral = delta !== null && delta === 0;
            return {
              label: "Gaps Fixed",
              value: delta === null ? "—" : improved ? `+${delta}` : delta === 0 ? "0" : "~0",
              sub:
                nightsDelta === null
                  ? "run scan to see impact"
                  : nightsDelta > 0
                    ? `${nightsDelta} nights recovered`
                    : nightsDelta < 0
                      ? "gaps consolidated — minor tradeoffs"
                      : "no orphan change",
              color: improved ? "border-occugreen text-occugreen" : neutral ? "border-border text-text-muted" : "border-occuorange text-occuorange",
            };
          })(),
          {
            label: "Easy to Sell",
            value:
              projectedMetrics != null
                ? projectedMetrics.dist.n4_7 + projectedMetrics.dist.n8p
                : (currentMetrics?.dist.n4_7 ?? 0) + (currentMetrics?.dist.n8p ?? 0),
            sub:
              projectedMetrics != null
                ? `after applying fixes (was ${(currentMetrics?.dist.n4_7 ?? 0) + (currentMetrics?.dist.n8p ?? 0)})`
                : "stretches of 4+ nights — bookable",
            color: "border-accent text-accent",
          },
        ].map((m, i) => (
          <div key={i} className="bg-surface border border-border shadow-subtle p-5 relative overflow-hidden">
            <div className={`absolute top-0 left-0 w-1 h-full ${m.color.split(" ")[0].replace("border", "bg")}`} />
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-[0.1em]">{m.label}</div>
            <div className={`text-3xl font-serif font-bold mt-2 ${m.color.split(" ")[1]}`}>{m.value}</div>
            <div className="text-xs text-text-muted mt-1 font-medium">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Run distribution widget */}
      {currentMetrics && stage !== "processing" && (
        <RunDistributionWidget current={currentMetrics} projected={projectedMetrics} stage={stage} />
      )}

      {/* Processing state */}
      {stage === "processing" && (
        <div className="bg-surface-2 border border-border p-10 mb-8 flex items-center justify-center">
          <div className="flex flex-col items-center max-w-sm text-center">
            <div className="w-10 h-10 border-2 border-border border-t-accent rounded-full animate-spin mb-6" />
            <h3 className="text-lg font-serif font-bold text-text">Scanning your booking calendar...</h3>
            <p className="text-xs text-text-muted mt-2 tracking-wide">
              Looking for empty nights trapped between bookings that can be moved to create longer, more bookable stretches.
            </p>
          </div>
        </div>
      )}

      {/* Heatmap(s) */}
      {heatmap && stage !== "processing" && (
        <div className="bg-surface border border-border">
          {stage === "preview" && gaps.length > 0 ? (
            <>
              <div className="px-6 py-4 flex justify-between items-center bg-surface-2/50 border-b border-border">
                <h3 className="font-serif font-bold text-lg text-text">Before & After Preview</h3>
                <span className="text-[10px] uppercase font-bold tracking-widest text-occuorange border border-occuorange/30 bg-occuorange/5 px-3 py-1">
                  Not applied yet
                </span>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-px bg-border p-[1px]">
                <div className="bg-surface p-6">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={heatmap.rows}
                    title="Current Topology"
                    compact
                    maxDays={20}
                    hideLegend
                    onCellClick={setSlotModal}
                  />
                </div>
                <div className="bg-surface p-6">
                  <HeatmapGrid
                    dates={heatmap.dates}
                    rows={simulated}
                    title="Projected After Commit"
                    compact
                    maxDays={20}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="p-6">
              <h3 className="font-serif font-bold text-lg text-text mb-6">Inventory Matrix</h3>
              <HeatmapGrid dates={heatmap.dates} rows={heatmap.rows} maxDays={20} onCellClick={setSlotModal} />
            </div>
          )}
        </div>
      )}

      {/* Gap plan summary (preview only) */}
      {stage === "preview" && gaps.length > 0 && (
        <div className="bg-surface border border-accent mt-8 p-6 shadow-subtle">
          <div className="flex justify-between flex-wrap gap-4 mb-6">
            <div>
              <h3 className="font-serif font-bold text-xl text-text">Ready to apply</h3>
              <div className="text-xs text-text-muted uppercase tracking-wider mt-1">
                {gaps.length} gap{gaps.length !== 1 ? "s" : ""} found · {swapPlan.length} room move{swapPlan.length !== 1 ? "s" : ""} needed
              </div>
            </div>
            <div className="text-right">
              {(() => {
                const gapDelta = projectedMetrics != null ? (currentMetrics?.orphanGaps ?? 0) - projectedMetrics.orphanGaps : null;
                const nightsDelta =
                  projectedMetrics != null ? (currentMetrics?.orphanNights ?? 0) - projectedMetrics.orphanNights : null;
                const improved = gapDelta !== null && gapDelta > 0;
                return (
                  <>
                    <div className="text-[10px] text-text-muted uppercase tracking-widest">
                      {improved ? "Gaps Eliminated" : "Calendar Optimised"}
                    </div>
                    <div className={`text-3xl font-serif font-bold ${improved ? "text-occugreen" : "text-accent"}`}>
                      {gapDelta === null ? gaps.length : improved ? gapDelta : gaps.length}
                    </div>
                    {nightsDelta !== null && (
                      <div className="text-xs text-text-muted mt-1">
                        {nightsDelta > 0 ? `${nightsDelta} nights freed up` : nightsDelta < 0 ? "bookings consolidated across rooms" : "calendar rearranged"}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          <div className="grid gap-2 mb-8 max-h-80 overflow-y-auto pr-2">
            {gaps.map((gap, i) => (
              <GapEntry key={i} gap={gap} />
            ))}
          </div>

          <div className="flex flex-wrap gap-4">
            <button
              className="flex-1 bg-occugreen text-white font-bold hover:brightness-110 active:scale-95 uppercase tracking-widest text-xs px-6 py-4 shadow-sm"
              onClick={handleCommit}
              disabled={loadingCommit}
            >
              {loadingCommit ? "Applying changes..." : "Apply Changes"}
            </button>
            <button
              className="bg-surface border border-border text-text uppercase tracking-widest font-bold text-xs px-8 py-4 hover:bg-surface-2"
              onClick={() => {
                setGaps([]);
                setSwapPlan([]);
                setStage("idle");
              }}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {/* Applied banner */}
      {stage === "applied" && appliedGains && (
        <div className="mt-8 bg-surface border border-border p-8 flex items-center justify-between shadow-subtle relative overflow-hidden">
          <div className="absolute top-0 left-0 h-1 w-full bg-occugreen" />
          <div>
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-[0.15em]">Done!</div>
            <div className="text-4xl font-serif font-bold text-occugreen mt-1">{appliedGains.shuffleCount} room moves applied</div>
            <div className="text-xs text-text-muted mt-2 font-medium">
              Calendar optimised · {appliedGains.nightsFreed > 0 ? `${appliedGains.nightsFreed} nights freed` : "bookings consolidated"} · {appliedGains.shuffleCount} swap{appliedGains.shuffleCount !== 1 ? "s" : ""}
            </div>
          </div>
          <TrendingUp className="w-12 h-12 text-occugreen opacity-80" />
        </div>
      )}

      {/* Converged banner */}
      {stage === "converged" && (
        <div className="mt-8 bg-surface-2 border border-border p-8 flex items-center justify-between relative overflow-hidden">
          <div className={`absolute top-0 left-0 h-1 w-full ${convergedState === "clean" ? "bg-occugreen" : "bg-text-muted"}`} />
          <div>
            <div className="text-[10px] font-bold text-text uppercase tracking-[0.15em]">Scan complete</div>
            <div className="text-2xl font-serif font-bold text-text mt-1">
              {convergedState === "clean" ? "Your calendar looks great!" : "Some gaps can't be fixed right now"}
            </div>
            <div className="text-xs text-text-muted mt-2 max-w-md leading-relaxed">
              {convergedState === "clean"
                ? "No empty gaps between bookings. Your rooms are well-organised and ready to sell."
                : "A few empty nights remain between bookings but moving them would disrupt current guests. Check back as new bookings come in."}
            </div>
          </div>
          <Lock className={`w-12 h-12 opacity-20 ${convergedState === "clean" ? "text-occugreen" : "text-text"}`} />
        </div>
      )}
    </div>
  );
}

