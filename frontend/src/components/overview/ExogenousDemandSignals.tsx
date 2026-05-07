import { useMemo } from "react";
import { contextFeed, computeCompositeScore } from "../../mock/contextFeed";
import { useOverviewSignals } from "../../context/overviewSignals";

type SignalKind = "EVENT" | "WEATHER" | "TRAVEL" | "MARKET";

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

export function ExogenousDemandSignals() {
  const { selectedItems } = useOverviewSignals();
  const sections = useMemo(() => {
    const kinds: SignalKind[] = ["EVENT", "WEATHER", "TRAVEL", "MARKET"];
    return kinds.map(k => ({ kind: k, item: selectedItems[k] ?? pickTopByKind(k) }));
  }, [selectedItems]);

  return (
    <div className="bg-surface border border-border p-5 mb-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Exogenous Demand Signals</div>
          <div className="text-[11px] text-text-muted mt-1 max-w-3xl leading-relaxed">
            Shared signals across all subtabs (shown once). Used to contextualize decisions without duplicating the feed inside tabs.
          </div>
        </div>
        <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted border border-border/60 bg-surface-2/40 px-3 py-2">
          Source: mock context feed
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {sections.map(({ kind, item }) => {
          const title = labelForKind(kind);
          const score = item ? computeCompositeScore(item) : null;
          return (
            <div key={kind} className="border border-border bg-surface-2/20 p-4">
              <div className="text-[9px] font-black uppercase tracking-widest text-text-muted">{title}</div>
              <div className="mt-2 text-sm font-bold text-text leading-tight">
                {item?.title ?? "—"}
              </div>
              <div className="mt-1 text-[11px] text-text-muted leading-relaxed line-clamp-3">
                {item?.detail ?? "No signal configured."}
              </div>
              <div className="mt-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-text-muted">
                <span>Score</span>
                <span className="font-mono font-black text-text">{score != null ? `${score}/100` : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

