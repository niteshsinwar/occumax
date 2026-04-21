import { PricingPanel } from "../PricingPanel";

/**
 * Pricing Insights and Optimization tab.
 * Wraps the existing Manager pricing panel for reuse in Overview.
 */
export function PricingOptimizationTab() {
  return (
    <div className="bg-surface border border-border min-h-[600px] flex flex-col relative">
      <PricingPanel />
    </div>
  );
}

