import { useMemo } from "react";
import { contextFeed, computeCompositeScore } from "../../mock/contextFeed";
import { useOverviewSignals } from "../../context/overviewSignals";

type SignalKind = "EVENT" | "WEATHER" | "TRAVEL" | "MARKET";

/** Maps API/mock kind to the four fixed Overview signal labels (ui-decisions). */
function labelForKind(kind: SignalKind): string {
  if (kind === "EVENT") return "Big Event";
  if (kind === "WEATHER") return "Weather";
  if (kind === "TRAVEL") return "Flight / Travel Disruption";
  return "Market";
}

function pickTopByKind(kind: SignalKind) {
  const items = contextFeed.filter(i => i.kind === kind);
  if (items.length === 0) return null;
  return [...items].sort((a, b) => computeCompositeScore(b) - computeCompositeScore(a))[0]!;
}

/**
 * Full-width dark band: shared exogenous demand context for all Overview subtabs.
 * Matches OPTIHOST mockup (dark chrome + four white signal cards).
 */
export function ExogenousDemandSignals() {
  const { selectedItems } = useOverviewSignals();
  const sections = useMemo(() => {
    const kinds: SignalKind[] = ["EVENT", "WEATHER", "TRAVEL", "MARKET"];
    return kinds.map(k => ({ kind: k, item: selectedItems[k] ?? pickTopByKind(k) }));
  }, [selectedItems]);

  return (
    <section
      className="w-full bg-nav-elevated border-b border-nav-border text-[#E8E0D8]"
      aria-labelledby="exogenous-demand-signals-heading"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h2
            id="exogenous-demand-signals-heading"
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#E8E0D8]"
          >
            Exogenous Demand Signals
          </h2>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-nav-muted shrink-0">
            Source: Mock context feed
          </p>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {sections.map(({ kind, item }) => {
            const title = labelForKind(kind);
            const score = item ? computeCompositeScore(item) : null;
            return (
              <article
                key={kind}
                className="rounded-[10px] bg-surface text-text shadow-[0_6px_20px_rgba(0,0,0,0.12)] border border-black/[0.06] p-4 flex flex-col min-h-[140px]"
              >
                <div className="text-[9px] font-black uppercase tracking-[0.15em] text-text-muted">
                  {title}
                </div>
                <div className="mt-2 text-sm font-bold text-text leading-snug line-clamp-2">
                  {item?.title ?? "—"}
                </div>
                <div className="mt-1 text-[11px] text-text-muted leading-relaxed line-clamp-3 flex-1">
                  {item?.detail ?? "No signal configured."}
                </div>
                <div className="mt-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-text-muted pt-2 border-t border-border/60">
                  <span>Score</span>
                  <span className="font-mono font-black text-text">
                    {score != null ? `${score}/100` : "—"}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
