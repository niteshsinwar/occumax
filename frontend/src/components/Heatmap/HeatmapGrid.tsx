import { format, parseISO } from "date-fns";
import type { HeatmapRow } from "../../types";
import { displayRoomLabel } from "../../utils/roomLabels";

export interface CellClickInfo {
  id: string;
  room: string;
  date: string;
  block: string;
  rate: number;
  channel: string | null;
  booking_id: string | null;
  category: string;
  offer_type: string | null;
}

export type HeatmapPalette = "default" | "optihost";

interface HeatmapGridProps {
  dates: string[];
  rows: HeatmapRow[];
  title?: string;
  compact?: boolean;
  maxDays?: number;
  hideDateHeader?: boolean;
  hideLegend?: boolean;
  /** When enabled, highlights 1-night EMPTY orphan-night gaps between non-EMPTY cells. */
  highlightSandwichGaps?: boolean;
  /** Softer luxury colors for Overview Occupancy (mockup-aligned). */
  palette?: HeatmapPalette;
  onCellClick?: (cell: CellClickInfo) => void;
}

const CHANNEL_BOOKING_CHANNELS = new Set(["OTA"]);

/** Base cell colors — `optihost` matches muted gold / blue / orange / green from dashboard mockup. */
const PALETTE_STYLES: Record<
  HeatmapPalette,
  { EMPTY: string; SOFT: string; SOFT_CHANNEL: string; HARD: string; FALLBACK: string }
> = {
  default: {
    EMPTY: "bg-emerald-200 text-emerald-900",
    SOFT: "bg-sky-400 text-white",
    SOFT_CHANNEL: "bg-amber-400 text-white",
    HARD: "bg-stone-400 text-white",
    FALLBACK: "bg-surface-2 text-text",
  },
  optihost: {
    EMPTY: "bg-[#c8e6d4] text-[#1a3528]",
    SOFT: "bg-[#e6d28c] text-[#3d3310]",
    SOFT_CHANNEL: "bg-[#7a9fbc] text-[#1a2533]",
    HARD: "bg-[#d4a574] text-[#2c1b18]",
    FALLBACK: "bg-surface-2 text-text",
  },
};

function cellClass(blockType: string, channel: string | null | undefined, palette: HeatmapPalette): string {
  const p = PALETTE_STYLES[palette];
  if (blockType === "SOFT" && channel && CHANNEL_BOOKING_CHANNELS.has(channel)) {
    return p.SOFT_CHANNEL;
  }
  if (blockType === "EMPTY") return p.EMPTY;
  if (blockType === "SOFT") return p.SOFT;
  if (blockType === "HARD") return p.HARD;
  return p.FALLBACK;
}

const CATEGORIES = ["STANDARD", "DELUXE", "SUITE", "ECONOMY"] as const;

export function HeatmapGrid({
  dates,
  rows,
  title,
  compact,
  maxDays,
  hideDateHeader,
  hideLegend,
  highlightSandwichGaps,
  palette = "default",
  onCellClick,
}: HeatmapGridProps) {
  const visibleDates    = maxDays ? dates.slice(0, maxDays) : dates;
  // Compact: 20×20px  Normal: 28×28px — large enough to read booking IDs
  const cellSizeClass   = compact ? "w-5 h-5" : "w-7 h-7";
  const labelWidthClass = compact ? "w-[52px]" : "w-[68px]";
  const bookingChars    = compact ? 2 : 3;
  const cellRounded     = palette === "optihost" ? "rounded-md" : "rounded-[2px]";
  const bookingMarkClass =
    palette === "optihost"
      ? compact
        ? "text-[#2c1b18]/85 font-mono font-bold leading-none select-none tracking-tighter text-[6px]"
        : "text-[#2c1b18]/85 font-mono font-bold leading-none select-none tracking-tighter text-[7px]"
      : compact
        ? "text-white/90 font-mono font-bold leading-none select-none tracking-tighter text-[6px]"
        : "text-white/90 font-mono font-bold leading-none select-none tracking-tighter text-[7px]";

  const groupedRows = CATEGORIES
    .map(cat => ({ cat, rows: rows.filter(r => r.category === cat) }))
    .filter(g => g.rows.length > 0);

  return (
    <div className="w-full">
      {title && (
        <div className="font-bold text-xs mb-3 text-text uppercase tracking-widest">{title}</div>
      )}

      {/* Date header */}
      {!hideDateHeader && (
        <div className="flex mb-2">
          <div className={`${labelWidthClass} shrink-0`} />
          {visibleDates.map(d => (
            <div
              key={d}
              title={d}
              className={`${cellSizeClass} shrink-0 mr-0.5 text-[8px] sm:text-[9px] font-semibold text-text-muted text-center flex items-end justify-center transform -rotate-45 origin-bottom-left h-8 whitespace-nowrap`}
            >
              {format(parseISO(d), "d/M")}
            </div>
          ))}
        </div>
      )}

      {/* Category groups */}
      {groupedRows.map(({ cat, rows: catRows }) => (
        <div key={cat} className="mb-2">
          <div className="text-[9px] font-bold text-text-muted uppercase tracking-[0.1em] py-1 border-b border-border mb-1.5 pl-1">
            {cat}
          </div>
          {catRows.map(row => (
            <div key={row.room_id} className="flex items-center mb-0.5">
              <div
                className={`${labelWidthClass} shrink-0 text-[10px] font-bold text-text-muted text-right pr-2`}
                title={`Room ID: ${row.room_id}`}
              >
                {displayRoomLabel(row.room_id, String(row.category), rows)}
              </div>

              {(maxDays ? row.cells.slice(0, maxDays) : row.cells).map((cell, idx, visibleCells) => {
                  const baseClass = cellClass(cell.block_type, cell.channel, palette);
                  let finalClass =
                    `${cellSizeClass} shrink-0 ${cellRounded} flex items-center justify-center ` +
                    `overflow-hidden transition-colors mr-0.5 border border-black/10 ${baseClass}`;
                  if (onCellClick) finalClass += " cursor-pointer hover:shadow-md hover:brightness-105";

                  if (highlightSandwichGaps) {
                    const before = idx > 0 ? visibleCells[idx - 1] : null;
                    const after = idx < visibleCells.length - 1 ? visibleCells[idx + 1] : null;
                    const isSandwichGap =
                      cell.block_type === "EMPTY" &&
                      before != null &&
                      before.block_type !== "EMPTY" &&
                      after != null &&
                      after.block_type !== "EMPTY";

                    if (isSandwichGap) {
                      const minStayActive = Boolean(cell.min_stay_active);
                      const minStayNights = Number(cell.min_stay_nights ?? 0);
                      const isMinLosBlocked = minStayActive && minStayNights > 1;
                      finalClass += isMinLosBlocked
                        ? " ring-2 ring-black/50"
                        : " ring-2 ring-occuorange/70";
                    }
                  }

                  const ch = cell.channel;
                  const offerType = cell.offer_type;
                  const tooltipBase = cell.block_type === "SOFT" && ch
                    ? `${cell.room_id} · ${cell.date} · ${ch}`
                    : `${cell.room_id} · ${cell.date} · ${cell.block_type}`;
                  const tooltip = offerType
                    ? `${tooltipBase} · OFFER=${offerType}`
                    : tooltipBase;
                  const rawId        = cell.booking_id || "";
                  const shortId      = rawId.replace(/^BK[A-Z]*/, "") || rawId.slice(0, bookingChars);
                  const bookingLabel = cell.block_type === "SOFT" && rawId
                    ? shortId.slice(0, bookingChars)
                    : null;
                  const offerLabel = !bookingLabel && offerType ? "٪" : null;

                  return (
                    <button
                      type="button"
                      key={cell.slot_id}
                      title={tooltip}
                      aria-label={tooltip}
                      disabled={!onCellClick}
                      onClick={() =>
                        onCellClick?.({
                          id:         cell.slot_id,
                          room:       cell.room_id,
                          date:       String(cell.date),
                          block:      cell.block_type,
                          rate:       cell.current_rate,
                          channel:    cell.channel ?? null,
                          booking_id: cell.booking_id,
                          category:   cell.category,
                          offer_type: offerType ?? null,
                        })
                      }
                      className={`${finalClass} disabled:cursor-default`}
                    >
                      {bookingLabel && <span className={bookingMarkClass}>{bookingLabel}</span>}
                      {offerLabel && (
                        <span
                          className={
                            palette === "optihost"
                              ? `text-[#2c1b18]/90 font-mono font-black leading-none select-none ${
                                  compact ? "text-[7px]" : "text-[9px]"
                                }`
                              : `text-white/90 font-mono font-black leading-none select-none ${
                                  compact ? "text-[7px]" : "text-[9px]"
                                }`
                          }
                        >
                          {offerLabel}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      ))}

      {/* Legend */}
      {!hideLegend && (
        <div className="flex flex-wrap gap-4 mt-6 px-2 py-2 border-t border-border">
          {(() => {
            const p = PALETTE_STYLES[palette];
            return [
              { cls: p.EMPTY, label: "Available" },
              { cls: p.SOFT, label: "Guest booking" },
              { cls: p.SOFT_CHANNEL, label: "Channel booking" },
              { cls: p.HARD, label: "Blocked" },
            ].map(({ cls, label }) => (
              <div key={label} className="flex items-center gap-1.5 text-[9px] font-bold text-text-muted uppercase tracking-widest">
                <div className={`w-3 h-3 ${cellRounded} shadow-sm ${cls}`} />
                {label}
              </div>
            ));
          })()}
        </div>
      )}
    </div>
  );
}
