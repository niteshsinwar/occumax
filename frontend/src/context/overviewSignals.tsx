/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, useState } from "react";
import type { ContextFeedItem } from "../mock/contextFeed";
import { contextFeed, computeCompositeScore } from "../mock/contextFeed";

export type OverviewSignalKind = "EVENT" | "WEATHER" | "TRAVEL" | "MARKET";

export type OverviewSignalsSelection = Record<OverviewSignalKind, string | null>;

function pickTopIdByKind(kind: OverviewSignalKind): string | null {
  const items = contextFeed.filter(i => i.kind === kind);
  if (items.length === 0) return null;
  return [...items].sort((a, b) => computeCompositeScore(b) - computeCompositeScore(a))[0]!.id;
}

function defaultSelection(): OverviewSignalsSelection {
  return {
    EVENT: pickTopIdByKind("EVENT"),
    WEATHER: pickTopIdByKind("WEATHER"),
    TRAVEL: pickTopIdByKind("TRAVEL"),
    MARKET: pickTopIdByKind("MARKET"),
  };
}

type OverviewSignalsContextValue = {
  selection: OverviewSignalsSelection;
  setSelected: (kind: OverviewSignalKind, id: string | null) => void;
  selectedItems: Record<OverviewSignalKind, ContextFeedItem | null>;
};

const OverviewSignalsContext = createContext<OverviewSignalsContextValue | null>(null);

export function OverviewSignalsProvider(props: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<OverviewSignalsSelection>(() => defaultSelection());

  const selectedItems = useMemo(() => {
    const byId = new Map<string, ContextFeedItem>();
    for (const i of contextFeed) byId.set(i.id, i);
    return {
      EVENT: selection.EVENT ? byId.get(selection.EVENT) ?? null : null,
      WEATHER: selection.WEATHER ? byId.get(selection.WEATHER) ?? null : null,
      TRAVEL: selection.TRAVEL ? byId.get(selection.TRAVEL) ?? null : null,
      MARKET: selection.MARKET ? byId.get(selection.MARKET) ?? null : null,
    };
  }, [selection]);

  const value: OverviewSignalsContextValue = useMemo(
    () => ({
      selection,
      setSelected: (kind, id) => setSelection(prev => ({ ...prev, [kind]: id })),
      selectedItems,
    }),
    [selection, selectedItems],
  );

  return (
    <OverviewSignalsContext.Provider value={value}>
      {props.children}
    </OverviewSignalsContext.Provider>
  );
}

export function useOverviewSignals(): OverviewSignalsContextValue {
  const ctx = useContext(OverviewSignalsContext);
  if (!ctx) throw new Error("useOverviewSignals must be used within OverviewSignalsProvider");
  return ctx;
}
