import { useMemo } from "react";
import type { ContextFeedItem } from "../../mock/contextFeed";
import { computeCompositeScore } from "../../mock/contextFeed";

export type ContextFeedPanelProps = {
  items: ContextFeedItem[];
  activeId: string;
  onSelect: (id: string) => void;
  header?: string;
  subheader?: string;
};

function kindBadgeClass(kind: ContextFeedItem["kind"]): string {
  if (kind === "TRAVEL") return "border-occuorange/40 bg-occuorange/10 text-occuorange";
  if (kind === "WEATHER") return "border-accent/30 bg-accent/5 text-accent";
  if (kind === "EVENT") return "border-occugreen/30 bg-occugreen/5 text-occugreen";
  return "border-border bg-surface text-text-muted";
}

export function ContextFeedPanel(props: ContextFeedPanelProps) {
  const { items, activeId, onSelect, header = "Context feed", subheader } = props;

  const scored = useMemo(
    () => items.map(i => ({ ...i, compositeScore: computeCompositeScore(i) })),
    [items],
  );

  return (
    <div className="border border-border bg-surface p-5">
      <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">{header}</div>
      {subheader ? (
        <div className="text-[11px] text-text-muted mb-3 leading-relaxed">{subheader}</div>
      ) : (
        <div className="text-[11px] text-text-muted mb-3 leading-relaxed">
          Weighted factors (weather · events · flights · market) drive a composite score for decisioning.
        </div>
      )}

      <div className="space-y-2">
        {scored.map(item => {
          const selected = item.id === activeId;
          const composite = item.compositeScore;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={`w-full text-left p-4 border transition-colors ${
                selected ? "border-accent/40 bg-accent/10" : "border-border bg-surface-2/40 hover:bg-surface-2"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    {item.severity === "ALERT" ? "Alert" : "Signal"} · score {composite}/100
                  </div>
                  <div className="font-bold text-text mt-1">{item.title}</div>
                  <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{item.detail}</div>
                </div>
                <div className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-1 border ${kindBadgeClass(item.kind)}`}>
                  {item.kind}
                </div>
              </div>

              <div className="mt-3 space-y-1.5 text-[10px] text-text-muted">
                {item.factors.map((f, idx) => (
                  <div key={`${item.id}-${idx}`} className="grid grid-cols-[54px_1fr_70px_52px] gap-2 items-center">
                    <div className="uppercase tracking-widest font-bold">{f.type}</div>
                    <div className="truncate">{f.label}: {f.value}</div>
                    <div className="text-right font-mono font-bold">{Math.round(f.weight * 100)}% wt</div>
                    <div className="text-right font-mono font-black text-text">{f.score}</div>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

