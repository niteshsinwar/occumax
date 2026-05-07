/**
 * Shared Overview subtab chrome (Dashboard, Occupancy, Pricing, Channels).
 * Aligns card radius, shadows, and typography with the OPTIHOST-style Occupancy reference.
 */

export const overviewStackClass = "space-y-8";

export const overviewEyebrowClass =
  "text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted";

export const overviewTitleClass = "font-serif font-bold text-2xl text-text tracking-tight";

export const overviewSectionTitleClass = "font-serif font-bold text-xl text-text tracking-tight";

export const overviewSubtitleClass =
  "text-[11px] text-text-muted mt-2 max-w-3xl leading-relaxed";

/** Standard elevated card (KPIs, nested panels). */
export const overviewCardClass =
  "rounded-[10px] bg-surface border border-border/80 shadow-[0_6px_20px_rgba(44,27,24,0.06)]";

/** Larger surface (tab hero blocks, calendar shell). */
export const overviewCardLgClass =
  "rounded-[12px] bg-surface border border-border/80 shadow-[0_8px_28px_rgba(44,27,24,0.08)]";

/** Softer inset panel inside a card. */
export const overviewInsetClass = "rounded-[10px] border border-border/70 bg-surface-2/30";

/** AI / insight callout (matches Occupancy predictive banner family). */
export const overviewInsightBannerClass =
  "rounded-[12px] border border-[#e6d8b8] bg-[#FDF7E6]/90 shadow-[0_6px_24px_rgba(44,27,24,0.06)]";

export const overviewSecondaryBtnClass =
  "inline-flex items-center justify-center gap-2 font-semibold text-[10px] uppercase tracking-[0.12em] px-5 py-2.5 rounded-[10px] border border-border bg-surface text-text hover:bg-surface-2 active:scale-[0.99] transition-all";

export const overviewMutedBadgeClass =
  "text-[10px] font-bold uppercase tracking-[0.12em] px-3 py-2 rounded-[10px] border border-border/80 bg-surface-2/50 text-text-muted";
