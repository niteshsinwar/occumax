import { useState } from "react";
import { OccupancyOptimizationTab } from "../components/overview/OccupancyOptimizationTab";
import { PricingOptimizationTab } from "../components/overview/PricingOptimizationTab";
import { ChannelOptimizationTab } from "../components/overview/ChannelOptimizationTab";
import { Zap, DollarSign, BarChart2 } from "lucide-react";

type ManagerTab = "yield" | "pricing" | "channels";

// ── Main page ─────────────────────────────────────────────────────────────────

export function ManagerDashboard() {
  const [activeTab,     setActiveTab]     = useState<ManagerTab>("yield");

  return (
    <div>
      {/* ── TAB BAR ───────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between mb-8 border-b border-border/50">
        <div className="flex gap-0">
          {(["yield", "pricing", "channels"] as ManagerTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === tab
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text hover:border-border"
              }`}
            >
              {tab === "yield"    && <><Zap        className="w-3.5 h-3.5" /> Room Optimisation</>}
              {tab === "pricing"  && <><DollarSign className="w-3.5 h-3.5" /> Pricing</>}
              {tab === "channels" && <><BarChart2  className="w-3.5 h-3.5" /> Channels</>}
            </button>
          ))}
        </div>
      </div>
      {activeTab === "yield" && <OccupancyOptimizationTab />}
      {activeTab === "pricing" && <PricingOptimizationTab />}
      {activeTab === "channels" && <ChannelOptimizationTab />}
    </div>
  );
}
