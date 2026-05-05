import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Blocks, Radar, Newspaper, ArrowRightLeft } from "lucide-react";
import type { HeatmapCell, HeatmapRow, RoomCategory } from "../types";
import { HeatmapGrid } from "../components/Heatmap/HeatmapGrid";

type OptimizerTab = "inventoryReconstitution" | "marginalRevenueCapture" | "channelResilience";

type PartnerHealth = "GREEN" | "YELLOW" | "RED";

type PartnerPulse = {
  partner: string;
  channel: "OTA" | "GDS" | "DIRECT";
  health: PartnerHealth;
  healthScore: number;
  note: string;
};

function dateRange(startIso: string, days: number): string[] {
  const start = new Date(`${startIso}T00:00:00`);
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function makeCell(args: {
  slotId: string;
  roomId: string;
  date: string;
  category: RoomCategory;
  blockType: HeatmapCell["block_type"];
  currentRate: number;
  bookingId?: string | null;
  channel?: HeatmapCell["channel"] | null;
  offerType?: string | null;
  minStayActive?: boolean;
  minStayNights?: number;
}): HeatmapCell {
  return {
    slot_id: args.slotId,
    room_id: args.roomId,
    date: args.date,
    category: args.category,
    block_type: args.blockType,
    current_rate: args.currentRate,
    booking_id: args.bookingId ?? null,
    channel: args.channel ?? null,
    min_stay_active: args.minStayActive ?? false,
    min_stay_nights: args.minStayNights ?? 1,
    offer_type: args.offerType ?? null,
  };
}

function cloneRows(rows: HeatmapRow[]): HeatmapRow[] {
  return rows.map(r => ({ ...r, cells: r.cells.map(c => ({ ...c })) }));
}

function setBooking(row: HeatmapRow, date: string, bookingId: string, channel: HeatmapCell["channel"] = "DIRECT") {
  const idx = row.cells.findIndex(c => c.date === date);
  if (idx === -1) return;
  const c = row.cells[idx]!;
  row.cells[idx] = {
    ...c,
    block_type: "SOFT",
    booking_id: bookingId,
    channel,
    offer_type: null,
  };
}

function clearCell(row: HeatmapRow, date: string) {
  const idx = row.cells.findIndex(c => c.date === date);
  if (idx === -1) return;
  const c = row.cells[idx]!;
  row.cells[idx] = {
    ...c,
    block_type: "EMPTY",
    booking_id: null,
    channel: null,
    offer_type: null,
  };
}

function markTargetBlock(row: HeatmapRow, dates: string[]) {
  for (const d of dates) {
    const idx = row.cells.findIndex(c => c.date === d);
    if (idx === -1) continue;
    const c = row.cells[idx]!;
    if (c.block_type === "EMPTY") {
      row.cells[idx] = { ...c, offer_type: "TARGET_BLOCK" };
    }
  }
}

function partnerRingClass(health: PartnerHealth): string {
  if (health === "GREEN") return "border-occugreen text-occugreen";
  if (health === "YELLOW") return "border-occuorange text-occuorange";
  return "border-occured text-occured";
}

export function Optimizer() {
  const [activeTab, setActiveTab] = useState<OptimizerTab>("inventoryReconstitution");

  // ── Tab 1: deterministic “healing” animation ───────────────────────────────
  const invDates = useMemo(() => dateRange("2026-05-15", 7), []);
  const invCategory: RoomCategory = "DELUXE";
  const legacyRows = useMemo<HeatmapRow[]>(() => {
    const baseRate = 220;
    const rooms: HeatmapRow[] = ["D201", "D202", "D203"].map((roomId, ri) => ({
      room_id: roomId,
      category: invCategory,
      base_rate: baseRate + ri * 10,
      cells: invDates.map((d, di) =>
        makeCell({
          slotId: `mock-${roomId}-${d}`,
          roomId,
          date: d,
          category: invCategory,
          blockType: "EMPTY",
          currentRate: baseRate + (di % 3) * 15,
        }),
      ),
    }));

    // Fragmented one-night bookings across rooms (legacy PMS snapshot)
    setBooking(rooms[0]!, invDates[1]!, "BK101", "DIRECT");
    setBooking(rooms[1]!, invDates[2]!, "BK102", "DIRECT");
    setBooking(rooms[2]!, invDates[3]!, "BK103", "DIRECT");
    setBooking(rooms[0]!, invDates[4]!, "BK104", "DIRECT");

    // A fixed HARD block that cannot move (to make it feel real)
    const hardIdx = 5;
    rooms[1]!.cells[hardIdx] = {
      ...rooms[1]!.cells[hardIdx]!,
      block_type: "HARD",
      booking_id: null,
      channel: null,
    };

    return rooms;
  }, [invDates]);

  const healingFrames = useMemo<HeatmapRow[][]>(() => {
    const f0 = cloneRows(legacyRows);
    const f1 = cloneRows(legacyRows);
    // Step 1: slide BK102 into D201, freeing D202 on that date
    clearCell(f1[1]!, invDates[2]!);
    setBooking(f1[0]!, invDates[2]!, "BK102", "DIRECT");

    const f2 = cloneRows(f1);
    // Step 2: slide BK103 into D201, freeing D203 on that date
    clearCell(f2[2]!, invDates[3]!);
    setBooking(f2[0]!, invDates[3]!, "BK103", "DIRECT");

    const f3 = cloneRows(f2);
    // Step 3: slide BK104 into D201, freeing D201's later date, and open a contiguous 3-night block on D203
    clearCell(f3[0]!, invDates[4]!);
    setBooking(f3[0]!, invDates[4]!, "BK104", "DIRECT");

    // Mark the target 3-night block on D203 (right pane) after healing
    const target = [invDates[2]!, invDates[3]!, invDates[4]!];
    markTargetBlock(f3[2]!, target);

    return [f0, f1, f2, f3];
  }, [legacyRows, invDates]);

  const [healingFrameIdx, setHealingFrameIdx] = useState<number>(0);
  const healingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (healingTimerRef.current != null) window.clearInterval(healingTimerRef.current);
    };
  }, []);

  const runHealing = () => {
    if (healingTimerRef.current != null) window.clearInterval(healingTimerRef.current);
    setHealingFrameIdx(0);
    healingTimerRef.current = window.setInterval(() => {
      setHealingFrameIdx(prev => {
        const next = Math.min(prev + 1, healingFrames.length - 1);
        if (next >= healingFrames.length - 1 && healingTimerRef.current != null) {
          window.clearInterval(healingTimerRef.current);
          healingTimerRef.current = null;
        }
        return next;
      });
    }, 650);
  };

  const resetHealing = () => {
    if (healingTimerRef.current != null) window.clearInterval(healingTimerRef.current);
    healingTimerRef.current = null;
    setHealingFrameIdx(0);
  };

  // ── Tab 2: clearance + profit gauge ────────────────────────────────────────
  const clearanceDates = useMemo(() => dateRange("2026-05-20", 7), []);
  const [shockTriggered, setShockTriggered] = useState(false);
  const discountedRate = 110;
  const operationalCost = 40;
  const netProfit = discountedRate - operationalCost;
  const gaugeMax = 120;
  const profitPct = Math.max(0, Math.min(100, (netProfit / gaugeMax) * 100));

  // ── Tab 3: partner pulse + pivot ───────────────────────────────────────────
  const basePartners = useMemo<PartnerPulse[]>(
    () => [
      { partner: "Expedia", channel: "OTA", health: "GREEN", healthScore: 92, note: "Strong conversion · stable API" },
      { partner: "Booking.com", channel: "OTA", health: "GREEN", healthScore: 88, note: "High intent demand · normal pace" },
      { partner: "Partner B", channel: "GDS", health: "YELLOW", healthScore: 71, note: "Minor latency spikes (monitor)" },
      { partner: "Amadeus", channel: "GDS", health: "GREEN", healthScore: 84, note: "Corporate demand steady" },
    ],
    [],
  );

  const [downtimeSimulated, setDowntimeSimulated] = useState(false);

  const partners = useMemo<PartnerPulse[]>(() => {
    if (!downtimeSimulated) return basePartners;
    return basePartners.map(p =>
      p.partner === "Partner B"
        ? { ...p, health: "RED", healthScore: 22, note: "4-hour API downtime (simulated)" }
        : p,
    );
  }, [basePartners, downtimeSimulated]);

  const allocations = useMemo(() => {
    const base = [
      { partner: "Expedia", pct: 28, tone: "bg-occugreen/55" },
      { partner: "Booking.com", pct: 26, tone: "bg-occugreen/35" },
      { partner: "Partner B", pct: 24, tone: "bg-occuorange/55" },
      { partner: "Amadeus", pct: 22, tone: "bg-text/20" },
    ];
    if (!downtimeSimulated) return base;
    return base.map(a => {
      if (a.partner === "Partner B") return { ...a, pct: 4, tone: "bg-occured/50" };
      if (a.partner === "Expedia") return { ...a, pct: 37, tone: "bg-occugreen/65" };
      if (a.partner === "Booking.com") return { ...a, pct: 34, tone: "bg-occugreen/45" };
      if (a.partner === "Amadeus") return { ...a, pct: 25, tone: "bg-text/20" };
      return a;
    });
  }, [downtimeSimulated]);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Optimizer</div>
        <h1 className="font-serif font-bold text-2xl text-text">Three Pillars of Revenue Recovery</h1>
        <p className="text-xs text-text-muted mt-2 max-w-3xl leading-relaxed">
          Deterministic demo experience (mock data). This page is designed for a pitch-style reveal of healing, clearance, and channel resilience.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-end justify-between mb-8 border-b border-border/50">
        <div className="flex gap-0">
          {(
            [
              { id: "inventoryReconstitution", label: "Inventory Healing", icon: <Blocks className="w-3.5 h-3.5" /> },
              { id: "marginalRevenueCapture", label: "Smart Clearance", icon: <Newspaper className="w-3.5 h-3.5" /> },
              { id: "channelResilience", label: "Channel Resilience", icon: <Radar className="w-3.5 h-3.5" /> },
            ] as const
          ).map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-6 py-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === t.id
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text hover:border-border"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <div className="mb-1 flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-accent bg-accent/8 border border-accent/25 px-3 py-1">
          <Sparkles className="w-3 h-3" /> Demo
        </div>
      </div>

      {/* ── Pillar 1 ───────────────────────────────────────────────────────── */}
      {activeTab === "inventoryReconstitution" && (
        <div className="space-y-4">
          <div className="bg-surface border border-border p-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Pillar 1</div>
                <div className="font-serif font-bold text-lg text-text mt-0.5">Revenue-Centric Inventory Reconstitution</div>
                <div className="text-xs text-text-muted mt-1 max-w-3xl leading-relaxed">
                  A “healing layer” pre-shapes inventory to prevent fragmentation and manufacture usable multi-night capacity.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={runHealing}
                  className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all flex items-center gap-2 text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text"
                  title="Run the healing animation on the right-hand calendar"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                  Run Healing
                </button>
                <button
                  type="button"
                  onClick={resetHealing}
                  className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-surface border border-border p-5">
              <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-3">Legacy PMS view</div>
              <HeatmapGrid
                title="Fragmented weekend"
                dates={invDates}
                rows={legacyRows}
                compact
                maxDays={7}
                hideLegend
              />
              <div className="mt-4 text-[11px] text-text-muted leading-relaxed">
                One-night bookings scatter across rooms of the same category, blocking longer-stay demand even when total empties exist.
              </div>
            </div>

            <div className="bg-surface border border-border p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">AI healing in action</div>
                <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">
                  Frame {healingFrameIdx + 1}/{healingFrames.length}
                </div>
              </div>
              <div className="transition-all">
                <HeatmapGrid
                  title="Reconstituted capacity"
                  dates={invDates}
                  rows={healingFrames[healingFrameIdx] ?? legacyRows}
                  compact
                  maxDays={7}
                  hideLegend
                />
              </div>
              <div className="mt-4 text-[11px] text-text-muted leading-relaxed">
                The highlighted cells (tooltip: <span className="font-bold text-text">OFFER=TARGET_BLOCK</span>) represent a newly-opened contiguous 3-night block.
              </div>
            </div>
          </div>

          <div className="bg-accent/5 border border-accent/20 p-6 flex items-center justify-between gap-6 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-widest font-bold text-accent">Metric</div>
              <div className="font-serif font-black text-3xl text-text mt-1">Usable Capacity Increased by 22%</div>
              <div className="text-[11px] text-text-muted mt-1">Manufactures bookable 3-night blocks and improves ALOS.</div>
            </div>
            <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted bg-surface px-4 py-3 border border-border">
              Predictive constraint layer · Tetris-style scheduling · Move-minimizing
            </div>
          </div>
        </div>
      )}

      {/* ── Pillar 2 ───────────────────────────────────────────────────────── */}
      {activeTab === "marginalRevenueCapture" && (
        <div className="space-y-4">
          <div className="bg-surface border border-border p-5">
            <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Pillar 2</div>
            <div className="font-serif font-bold text-lg text-text mt-0.5">Marginal Revenue Capture</div>
            <div className="text-xs text-text-muted mt-1 max-w-3xl leading-relaxed">
              Smart clearance monetizes “sandwich nights” that cannot be physically moved, while protecting a price floor.
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {/* News feed */}
            <div className="bg-surface border border-border p-5">
              <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-3">Context feed</div>
              <button
                type="button"
                onClick={() => setShockTriggered(true)}
                className={`w-full text-left p-4 border transition-colors ${
                  shockTriggered ? "border-accent/40 bg-accent/10" : "border-border bg-surface-2/40 hover:bg-surface-2"
                }`}
              >
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Alert</div>
                <div className="font-bold text-text mt-1">O’Hare Airport: 50+ Flight Cancellations Due to Weather</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                  External shock detected → last-minute demand spike likely. Trigger clearance simulation.
                </div>
              </button>
              {shockTriggered && (
                <div className="mt-4 text-[11px] text-accent font-bold uppercase tracking-widest border border-accent/30 bg-accent/5 px-4 py-3">
                  Trigger active: last-minute clearance window
                </div>
              )}
            </div>

            {/* Sandwich night selection */}
            <div className="bg-surface border border-border p-5 xl:col-span-2">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Sandwich night</div>
                  <div className="font-serif font-bold text-base text-text mt-0.5">Clearance decision</div>
                </div>
                <button
                  type="button"
                  onClick={() => setShockTriggered(false)}
                  className="text-[10px] font-bold uppercase tracking-widest px-3 py-2 border border-border bg-surface hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
                >
                  Reset trigger
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-surface-2/40 border border-border p-4">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Calendar snippet</div>
                  <HeatmapGrid
                    title="Room S501 (Suite)"
                    dates={clearanceDates}
                    rows={[
                      {
                        room_id: "S501",
                        category: "SUITE",
                        base_rate: 180,
                        cells: clearanceDates.map((d, i) => {
                          const isSandwich = i === 3;
                          const bookedBefore = i === 2;
                          const bookedAfter = i === 4;
                          const blockType: HeatmapCell["block_type"] =
                            bookedBefore || bookedAfter ? "SOFT" : isSandwich ? "EMPTY" : "EMPTY";
                          const bookingId = bookedBefore ? "BK771" : bookedAfter ? "BK772" : null;
                          return makeCell({
                            slotId: `mock-S501-${d}`,
                            roomId: "S501",
                            date: d,
                            category: "SUITE",
                            blockType,
                            currentRate: 160 + (i % 3) * 10,
                            bookingId,
                            channel: bookingId ? "OTA" : null,
                            minStayActive: isSandwich,
                            minStayNights: 2,
                            offerType: shockTriggered && isSandwich ? "LAST_MINUTE_CLEARANCE" : null,
                          });
                        }),
                      },
                    ]}
                    compact
                    maxDays={7}
                    highlightSandwichGaps
                    hideLegend
                  />
                  <div className="mt-3 text-[11px] text-text-muted leading-relaxed">
                    The highlighted gap is a stranded night between bookings. Triggered clearance proposes a targeted offer.
                  </div>
                </div>

                <div className="bg-surface-2/40 border border-border p-4">
                  <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">AI trade-off</div>
                  <div className="space-y-2 text-sm text-text">
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted font-medium">Empty room</span>
                      <span className="font-mono font-bold tabular-nums">$0</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted font-medium">Discounted rate</span>
                      <span className="font-mono font-bold tabular-nums">${discountedRate}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted font-medium">Operational cost (TCO)</span>
                      <span className="font-mono font-bold tabular-nums">-${operationalCost}</span>
                    </div>
                    <div className="pt-2 mt-2 border-t border-border flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Net profit</span>
                      <span className={`font-mono font-black tabular-nums ${shockTriggered ? "text-occugreen" : "text-text"}`}>
                        {shockTriggered ? `$${netProfit}` : "—"}
                      </span>
                    </div>
                  </div>

                  {/* Profit gauge */}
                  <div className="mt-4">
                    <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Profit gauge</div>
                    <div className="h-3.5 bg-surface border border-border overflow-hidden">
                      <div
                        className="h-full bg-occugreen/70 transition-all duration-700"
                        style={{ width: shockTriggered ? `${profitPct}%` : "0%" }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-text-muted">
                      <span>$0 (empty)</span>
                      <span>{shockTriggered ? `$${netProfit} net` : "$—"}</span>
                    </div>
                    <div className="mt-2 text-[11px] text-text-muted leading-relaxed">
                      This demonstrates that the system is not “just discounting” — it protects the floor by optimizing for net profit.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Pillar 3 ───────────────────────────────────────────────────────── */}
      {activeTab === "channelResilience" && (
        <div className="space-y-4">
          <div className="bg-surface border border-border p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Pillar 3</div>
                <div className="font-serif font-bold text-lg text-text mt-0.5">Strategic Channel Resilience</div>
                <div className="text-xs text-text-muted mt-1 max-w-3xl leading-relaxed">
                  Market Radar monitors partner health and shifts flexible inventory away from high-risk channels to protect net margin.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDowntimeSimulated(true)}
                  className="bg-text text-surface font-semibold hover:bg-text/90 active:scale-95 transition-all text-xs uppercase tracking-widest px-5 py-2.5 rounded-sm border border-text"
                >
                  Simulate Partner B: 4-hour API downtime
                </button>
                <button
                  type="button"
                  onClick={() => setDowntimeSimulated(false)}
                  className="bg-surface-2 text-text font-semibold hover:bg-border active:scale-95 transition-all text-xs uppercase tracking-widest px-4 py-2.5 rounded-sm border border-border"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Partner pulse */}
            <div className="bg-surface border border-border p-5">
              <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-4">Partner pulse</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {partners.map(p => (
                  <div key={p.partner} className="bg-surface-2/40 border border-border p-4 flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-full border-2 flex items-center justify-center shrink-0 ${partnerRingClass(p.health)}`}>
                      <span className="text-[10px] font-black tabular-nums">{p.healthScore}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-bold text-text truncate">{p.partner}</div>
                        <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{p.channel}</div>
                      </div>
                      <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{p.note}</div>
                      <div className="mt-2 h-1 bg-border overflow-hidden">
                        <div
                          className={`h-full transition-all duration-700 ${
                            p.health === "GREEN" ? "bg-occugreen" : p.health === "YELLOW" ? "bg-occuorange" : "bg-occured"
                          }`}
                          style={{ width: `${Math.max(0, Math.min(100, p.healthScore))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 text-[11px] text-text-muted leading-relaxed">
                Health is a composite demo signal (downtime, latency, sentiment/news). In production this would be driven by monitoring and NLP.
              </div>
            </div>

            {/* Pivot allocations */}
            <div className="bg-surface border border-border p-5">
              <div className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">Strategic pivot</div>
              <div className="font-serif font-bold text-base text-text">Flexible inventory reallocation</div>
              <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                Only flexible inventory shifts. Contracted blocks remain respected; this is a prioritization change.
              </div>

              <div className="mt-4 space-y-3">
                {allocations.map(a => (
                  <div key={a.partner} className="grid grid-cols-[120px_1fr_42px] gap-3 items-center">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted text-right">{a.partner}</div>
                    <div className="h-3.5 bg-surface-2 border border-border/40 overflow-hidden">
                      <div
                        className={`h-full ${a.tone} transition-all duration-700`}
                        style={{ width: `${Math.max(0, Math.min(100, a.pct))}%` }}
                      />
                    </div>
                    <div className="text-[10px] font-bold tabular-nums text-text text-right">{a.pct}%</div>
                  </div>
                ))}
              </div>

              <div className={`mt-5 p-4 border transition-colors ${downtimeSimulated ? "border-occuorange/40 bg-occuorange/5" : "border-border bg-surface-2/40"}`}>
                <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Decision</div>
                <div className="text-sm text-text mt-1 leading-relaxed">
                  {downtimeSimulated
                    ? "Partner B flagged as high-risk. The system pivots flexible inventory toward green partners to preserve booking flow and net margin."
                    : "All partners healthy. Flexible inventory remains balanced across high-performing channels."}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

