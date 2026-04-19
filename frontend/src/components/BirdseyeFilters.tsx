import type { RoomCategory } from "../types";

/** Week multiplier for Bird's Eye date span (each unit is seven days of the loaded heatmap). */
export type BirdseyeWeekSpan = 1 | 2 | 3;

const WEEK_OPTIONS: Array<{ weeks: BirdseyeWeekSpan; label: string }> = [
  { weeks: 1, label: "1 week" },
  { weeks: 2, label: "2 weeks" },
  { weeks: 3, label: "3 weeks" },
];

/** Human-readable label for a room category enum value. */
function categoryLabel(category: RoomCategory): string {
  return category.charAt(0) + category.slice(1).toLowerCase();
}

interface BirdseyeFiltersProps {
  /** Number of weeks shown (7 days per week, capped by data in parent). */
  weekSpan: BirdseyeWeekSpan;
  /** Updates the visible calendar span. */
  onWeekSpanChange: (weeks: BirdseyeWeekSpan) => void;
  /** Room categories that exist on the loaded heatmap (from the API / database). */
  availableCategories: RoomCategory[];
  /** Room categories included in the matrix and side panel. */
  selectedCategories: RoomCategory[];
  /** Toggles a category on or off; parent should keep at least one selected. */
  onToggleCategory: (category: RoomCategory) => void;
}

/**
 * Filter controls for Bird's Eye View: calendar length (1–3 weeks) and room-type toggles.
 * Only used on the Dashboard page; room types are supplied by the parent from heatmap data.
 */
export function BirdseyeFilters({
  weekSpan,
  onWeekSpanChange,
  availableCategories,
  selectedCategories,
  onToggleCategory,
}: BirdseyeFiltersProps) {
  const selectedSet = new Set(selectedCategories);

  return (
    <div className="mb-6 bg-surface border border-border p-4 sm:p-5 shadow-subtle">
      <div className="font-bold text-xs text-text uppercase tracking-widest mb-4">Filters</div>
      <div className="flex flex-col lg:flex-row lg:items-start gap-6 lg:gap-10">
        <div className="min-w-0">
          <div className="text-[9px] font-bold text-text-muted uppercase tracking-wide mb-2">Date range</div>
          <div className="flex flex-wrap gap-2">
            {WEEK_OPTIONS.map(({ weeks, label }) => {
              const active = weekSpan === weeks;
              return (
                <button
                  key={weeks}
                  type="button"
                  onClick={() => onWeekSpanChange(weeks)}
                  className={
                    "text-xs font-semibold uppercase tracking-wider px-4 py-2.5 rounded-sm border transition-all " +
                    (active
                      ? "bg-text text-surface border-text"
                      : "bg-surface-2 text-text border-border hover:bg-border")
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-bold text-text-muted uppercase tracking-wide mb-2">Room type</div>
          {availableCategories.length === 0 ? (
            <p className="text-xs text-text-muted">No active rooms returned for this property.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableCategories.map(category => {
                const active = selectedSet.has(category);
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => onToggleCategory(category)}
                    className={
                      "text-xs font-semibold uppercase tracking-wider px-4 py-2.5 rounded-sm border transition-all " +
                      (active
                        ? "bg-text text-surface border-text"
                        : "bg-surface-2 text-text border-border hover:bg-border")
                    }
                  >
                    {categoryLabel(category)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
