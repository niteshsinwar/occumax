import { format, parseISO } from "date-fns";
import type { HeatmapRow } from "../../types";

interface CellClickInfo {
  id: string; room: string; date: string; block: string;
}

interface HeatmapGridProps {
  dates: string[];
  rows: HeatmapRow[];
  title?: string;
  compact?: boolean;
  maxDays?: number;
  hideDateHeader?: boolean;
  hideLegend?: boolean;
  onCellClick?: (cell: CellClickInfo) => void;
}

// Three and only three block types.
// Bright palette: easy to distinguish at a glance.
//   EMPTY → light green  (available night — good signal)
//   SOFT  → sky blue     (booked night — neutral)
//   HARD  → warm stone   (blocked/maintenance — warning)
const CELL_CLASSES: Record<string, string> = {
  EMPTY: "bg-emerald-200 text-emerald-900",
  SOFT:  "bg-sky-400 text-white",
  HARD:  "bg-stone-400 text-white",
};

const CATEGORIES = ["STANDARD", "STUDIO", "DELUXE", "SUITE", "PREMIUM", "ECONOMY"] as const;

export function HeatmapGrid({
  dates,
  rows,
  title,
  compact,
  maxDays,
  hideDateHeader,
  hideLegend,
  onCellClick,
}: HeatmapGridProps) {
  const visibleDates    = maxDays ? dates.slice(0, maxDays) : dates;
  const visibleDateSet  = new Set(visibleDates);
  // Compact: 20×20px  Normal: 28×28px — large enough to read booking IDs
  const cellSizeClass   = compact ? "w-5 h-5" : "w-7 h-7";
  const labelWidthClass = compact ? "w-[52px]" : "w-[68px]";
  const bookingChars    = compact ? 2 : 3;

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
              <div className={`${labelWidthClass} shrink-0 text-[10px] font-bold text-text-muted text-right pr-2`}>
                {row.room_id}
              </div>

              {row.cells
                .filter(cell => !maxDays || visibleDateSet.has(String(cell.date)))
                .map(cell => {
                  const baseClass = CELL_CLASSES[cell.block_type] ?? "bg-surface-2 text-text";
                  let finalClass =
                    `${cellSizeClass} shrink-0 rounded-[2px] flex items-center justify-center ` +
                    `overflow-hidden transition-colors mr-0.5 border border-black/10 ${baseClass}`;
                  if (onCellClick) finalClass += " cursor-pointer hover:shadow-md hover:brightness-105";

                  const tooltip      = `${cell.room_id} | ${cell.date} | ${cell.block_type}`;
                  const rawId        = cell.booking_id || "";
                  const shortId      = rawId.replace(/^BK[A-Z]*/, "") || rawId.slice(0, bookingChars);
                  const bookingLabel = cell.block_type === "SOFT" && rawId
                    ? shortId.slice(0, bookingChars)
                    : null;

                  return (
                    <div
                      key={cell.slot_id}
                      title={tooltip}
                      onClick={() =>
                        onCellClick?.({
                          id:    cell.slot_id,
                          room:  cell.room_id,
                          date:  String(cell.date),
                          block: cell.block_type,
                        })
                      }
                      className={finalClass}
                    >
                      {bookingLabel && (
                        <span
                          className={`text-white/90 font-mono font-bold leading-none select-none tracking-tighter ${
                            compact ? "text-[6px]" : "text-[7px]"
                          }`}
                        >
                          {bookingLabel}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      ))}

      {/* Legend */}
      {!hideLegend && (
        <div className="flex flex-wrap gap-4 mt-6 px-2 py-2 border-t border-border">
          {[
            { cls: CELL_CLASSES.EMPTY, label: "Available" },
            { cls: CELL_CLASSES.SOFT,  label: "Booked"    },
            { cls: CELL_CLASSES.HARD,  label: "Blocked"   },
          ].map(({ cls, label }) => (
            <div
              key={label}
              className="flex items-center gap-1.5 text-[9px] font-bold text-text-muted uppercase tracking-widest"
            >
              <div className={`w-3 h-3 rounded-[2px] shadow-sm ${cls}`} />
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
