import { useState } from "react";
import { CheckCircle2, Loader2, ClipboardCheck, XCircle, Sparkles, Send, Bot, User, X } from "lucide-react";
import { confirmBooking, confirmSplitStay, bookingConfirmBooking, bookingConfirmSplitStay } from "../../api/client";
import type { ComparisonTable, SplitSegment, SwapStep } from "../../types";
import { useToast } from "./Toast";

export type ApiRole = "receptionist" | "booking";

export type SearchRequestRef = {
  category: string;
  check_in: string;
  check_out: string;
};

/** True when a confirmable option differs from the guest's original search. */
export function isAlternateToSearch(
  option: SearchRequestRef | undefined,
  original: SearchRequestRef | undefined,
): boolean {
  if (!option || !original) return false;
  return (
    option.check_in !== original.check_in
    || option.check_out !== original.check_out
    || option.category.toUpperCase() !== original.category.toUpperCase()
  );
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  action_data?: { type: string; data: Record<string, unknown> } | null;
}

const BT_BG: Record<string, string> = {
  EMPTY: "var(--green)",
  SOFT:  "var(--surface2)",
  HARD:  "var(--text)",
  NEW:   "var(--accent)", 
};

export function ComparisonSection({ comparison }: { comparison: ComparisonTable }) {
  const { dates, rows, summary } = comparison;
  return (
    <div className="bg-surface-2 border border-border p-5 mt-8">
      <h4 className="text-[10px] font-bold text-text uppercase tracking-[0.15em] mb-1">Room Swap Plan</h4>
      <p className="text-[10px] text-text-muted mb-4">Shows current state (BEFORE) and what changes after this booking is confirmed (AFTER).</p>

      {summary && summary.length > 0 && (
        <div className="bg-surface border border-border/60 p-3 mb-5 space-y-1.5">
          <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest mb-2">What will move</div>
          {summary.map((line, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-text">
              <span className="text-accent font-black shrink-0 mt-0.5">→</span>
              <span>{line}</span>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto pb-2">
        <div className="flex font-mono text-[9px] font-bold text-text-muted mb-3 min-w-[max-content] uppercase tracking-widest">
          <div className="w-44 shrink-0" />
          {dates.map((d) => <div key={d} className="flex-1 min-w-[42px] text-center px-0.5">{d.slice(5)}</div>)}
        </div>

        {rows.map((row) => {
          const isTarget = row.role === "TARGET";
          const roomLabel = isTarget
            ? `Room ${row.room_id} — clearing for new guest`
            : `Room ${row.room_id} — receives displaced booking ·${row.booking_id_received?.slice(-3) ?? ""}`;
          return (
            <div key={row.room_id} className="mb-5 min-w-[max-content]">
              <div className="mb-2 text-[10px] font-bold text-text uppercase tracking-wider">{roomLabel}</div>

              <div className="flex items-center mb-1">
                <div className="w-44 shrink-0 flex items-center gap-2 pr-2">
                  <span className="text-[8px] font-bold text-text-muted bg-surface border border-border px-2 py-0.5 uppercase tracking-wider shrink-0">BEFORE</span>
                  <span className="text-[9px] text-text-muted truncate">current state</span>
                </div>
                {row.cells.map((cell) => (
                  <div key={cell.date}
                    className="flex-1 min-w-[42px] h-7 mx-0.5 border border-border/20 flex justify-center items-center text-[9px] font-bold font-mono text-white shadow-sm"
                    style={{ backgroundColor: BT_BG[cell.before_type] || "var(--surface2)" }}>
                    {cell.before_booking ? `·${cell.before_booking.slice(-3)}` : "·open"}
                  </div>
                ))}
              </div>

              <div className="flex items-center">
                <div className="w-44 shrink-0 flex items-center gap-2 pr-2">
                  <span className="text-[8px] font-bold text-accent bg-accent/5 border border-accent/20 px-2 py-0.5 uppercase tracking-wider shrink-0">AFTER</span>
                  <span className="text-[9px] text-accent truncate">after commit</span>
                </div>
                {row.cells.map((cell) => {
                  const isNew     = cell.after_booking === "NEW";
                  const isFreed   = cell.after_type === "EMPTY" && cell.before_type !== "EMPTY";
                  const unchanged = cell.before_type === cell.after_type && cell.before_booking === cell.after_booking;
                  const bt        = isNew ? "NEW" : cell.after_type;
                  return (
                    <div key={cell.date}
                      className={`flex-1 min-w-[42px] h-7 mx-0.5 flex justify-center items-center text-[9px] font-bold font-mono shadow-sm border ${
                        isNew     ? "border-accent text-accent bg-accent-dim"
                        : isFreed ? "border-occugreen/40 text-occugreen bg-occugreen/5"
                        : unchanged ? "border-border/10 opacity-40"
                        : "border-border/20 text-white"
                      }`}
                      style={!isNew && !isFreed && !unchanged ? { backgroundColor: BT_BG[bt] || "var(--surface2)" } : {}}>
                      {isNew     ? "NEW"
                       : isFreed ? "FREE"
                       : cell.after_booking ? `·${cell.after_booking.slice(-3)}` : "·open"}
                    </div>
                  );
                })}
              </div>
              <div className="h-px bg-border/40 mt-3" />
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-4 pt-3 border-t border-border/40">
        {[
          { label: "BOOKED (stay)",  color: BT_BG["SOFT"] },
          { label: "HARD BLOCK",     color: BT_BG["HARD"] },
          { label: "NEW GUEST",      color: "var(--accent)" },
        ].map(({ label, color }) => (
          <div key={label} className="flex items-center gap-1.5 text-[9px] font-bold text-text uppercase tracking-widest">
            <span className="w-3 h-3 block border border-border/40" style={{ backgroundColor: color }} />
            {label}
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[9px] font-bold text-occugreen uppercase tracking-widest">
          <span className="w-3 h-3 block border border-occugreen/40 bg-occugreen/5" />
          FREE (slot vacated)
        </div>
        <div className="flex items-center gap-1.5 text-[9px] font-bold text-text-muted uppercase tracking-widest">
          <span className="w-3 h-3 block border border-border/20 opacity-40 bg-surface-2" />
          UNCHANGED
        </div>
      </div>
    </div>
  );
}

export function ActionCard({
  data,
  apiRole,
  originalSearchRequest = null,
}: {
  data: { type: string; data: Record<string, unknown> };
  apiRole: ApiRole;
  originalSearchRequest?: SearchRequestRef | null;
}) {
  const [guestName, setGuestName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<{ booking_id: string; room_id: string } | null>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const { show } = useToast();

  const apiConfirmBooking = apiRole === "booking" ? bookingConfirmBooking : confirmBooking;
  const apiConfirmSplitStay = apiRole === "booking" ? bookingConfirmSplitStay : confirmSplitStay;

  if (data.type === "live_agent_handoff") {
    return (
      <div className="mt-2 rounded-md border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-text">
        <p className="font-bold text-text">Connecting with our team</p>
        <p className="mt-1 text-text-muted leading-relaxed">
          A live team member will follow up shortly to help with your stay and any promotional rates.
        </p>
      </div>
    );
  }

  if (data.type === "booking_confirmed") {
    const d = data.data as { booking_id: string; room_id: string };
    return (
      <div className="bg-occugreen/10 border border-occugreen/30 p-3 mt-2 text-xs">
        <div className="flex items-center gap-2 text-occugreen font-bold uppercase tracking-wider mb-1">
          <CheckCircle2 className="w-3.5 h-3.5" /> Booking Confirmed
        </div>
        <div className="font-mono text-text">ID: {d.booking_id} {apiRole === "receptionist" && <span>· Room {d.room_id}</span>}</div>
      </div>
    );
  }

  if (data.type === "split_stay_confirmed") {
    const d = data.data as { stay_group_id: string; booking_ids: string[]; segments: number; discount_pct: number };
    return (
      <div className="bg-occugreen/10 border border-occugreen/30 p-3 mt-2 text-xs space-y-1">
        <div className="flex items-center gap-2 text-occugreen font-bold uppercase tracking-wider">
          <CheckCircle2 className="w-3.5 h-3.5" /> Split Stay Confirmed
        </div>
        <div className="font-mono text-text">Group: {d.stay_group_id}</div>
        <div className="text-text-muted">{d.segments} segments · {d.discount_pct}% discount applied</div>
        <div className="text-text-muted font-mono text-[10px]">Booking IDs: {d.booking_ids?.join(", ")}</div>
      </div>
    );
  }

  if (data.type === "recovery_menu") {
    const d = data.data as {
      preferred_category: string;
      check_in: string;
      check_out: string;
      requested_nights: number;
      options?: {
        option_id?: string;
        display_rank?: number;
        kind: string;
        title: string;
        category?: string;
        room_id?: string;
        state?: string;
        check_in?: string;
        check_out?: string;
        nights?: number;
        segments?: SplitSegment[];
        discount_pct?: number;
        estimated_total?: number | null;
        confirmable?: boolean;
        rationale?: string;
        pricing_signal?: { action?: string; confidence?: string; reason?: string };
      }[];
      failures?: { path: string; detail: string }[];
      primary_action_data?: { type: string; data: Record<string, unknown> } | null;
    };

    if (apiRole === "booking") {
      const failedSearch: SearchRequestRef = {
        category: d.preferred_category,
        check_in: d.check_in,
        check_out: d.check_out,
      };
      return (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-text-muted leading-relaxed px-1">
            Your search ({d.check_in} → {d.check_out}, {d.preferred_category}) is not available.
            These are alternate options — confirm only if the dates and room style work for you.
          </p>
          {d.options && d.options.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-bold text-text mb-2 px-1">Alternate options</div>
              {d.options.slice(0, 3).map((opt, i) => (
                <div key={i} className="bg-surface border border-accent/20 rounded-[8px] p-3 shadow-sm hover:border-accent/50 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-text text-sm">{opt.title}</span>
                    {typeof opt.estimated_total === "number" && (
                      <span className="font-mono font-bold text-accent">${Math.round(opt.estimated_total).toLocaleString("en-US")}</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <div className="flex items-center gap-2">
                      <span className="text-text-muted font-medium uppercase tracking-wider">{opt.category}</span>
                      {opt.check_in && opt.check_out && (
                        <span className="text-text-muted">{opt.check_in} → {opt.check_out}</span>
                      )}
                      {typeof opt.nights === "number" && (
                        <span className="text-text-muted">{opt.nights}n</span>
                      )}
                    </div>
                    {typeof opt.discount_pct === "number" && opt.discount_pct > 0 && (
                      <span className="text-occugreen font-bold bg-occugreen/10 px-2 py-0.5 rounded-full">{opt.discount_pct}% OFF</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {d.primary_action_data && (
            <div className="pt-2">
              <ActionCard
                data={d.primary_action_data}
                apiRole={apiRole}
                originalSearchRequest={failedSearch}
              />
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mt-2 border border-accent/30 bg-accent/3">
        <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border-b border-accent/20 text-xs font-bold uppercase tracking-wider text-accent">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          Recovery Menu
          <span className="ml-auto font-mono font-normal normal-case text-text">
            {d.preferred_category} · {d.requested_nights}n
          </span>
        </div>
        <div className="p-3 space-y-2">
          {apiRole === "receptionist" && (d.options ?? []).map((opt, i) => {
            const rank = opt.display_rank ?? i + 1;
            const segments = opt.segments ?? [];
            return (
              <div key={opt.option_id ?? `${opt.kind}-${i}`} className="border border-border bg-surface p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 bg-accent/15 text-accent font-bold flex items-center justify-center text-[10px] shrink-0">
                        {rank}
                      </span>
                      <span className="font-bold text-text">{opt.title}</span>
                    </div>
                    <div className="mt-1 text-text-muted leading-relaxed">{opt.rationale}</div>
                  </div>
                  <span className={`text-[9px] uppercase tracking-widest border px-2 py-1 shrink-0 ${
                    opt.confirmable ? "border-occugreen/30 text-occugreen" : "border-border text-text-muted"
                  }`}>
                    {opt.confirmable ? "Ready" : "Advisory"}
                  </span>
                </div>
                {segments.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {segments.map((seg, idx) => (
                      <div key={`${seg.room_id}-${seg.check_in}-${idx}`} className="grid grid-cols-4 gap-2 text-[10px] text-text-muted">
                        <span className="font-mono text-text">Room {seg.room_id}</span>
                        <span>Floor {seg.floor}</span>
                        <span className="col-span-2">{seg.check_in} → {seg.check_out} · {seg.nights}n</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-text-muted">
                  {opt.room_id && <div>Room <span className="font-mono text-text">{opt.room_id}</span></div>}
                  {opt.category && <div>Category <span className="text-text">{opt.category}</span></div>}
                  {opt.check_in && opt.check_out && (
                    <div className="col-span-2">
                      Dates <span className="font-mono text-text">{opt.check_in} → {opt.check_out}</span>
                      {typeof opt.nights === "number" && <span> · {opt.nights}n</span>}
                    </div>
                  )}
                  {typeof opt.discount_pct === "number" && opt.discount_pct > 0 && (
                    <div>Offer <span className="text-accent">{opt.discount_pct}% discount</span></div>
                  )}
                  {typeof opt.estimated_total === "number" && (
                    <div>Total <span className="text-text">${Math.round(opt.estimated_total).toLocaleString("en-US")}</span></div>
                  )}
                  {apiRole === "receptionist" && opt.pricing_signal?.action && (
                    <div>Pricing <span className="text-text">{opt.pricing_signal.action}</span></div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {apiRole === "receptionist" && d.failures && d.failures.length > 0 && (
          <div className="mt-3 pt-3 border-t border-accent/20 text-[10px] text-text-muted space-y-1 font-mono">
            {d.failures.map((f, i) => (
              <div key={i}>
                <span className="text-text">{f.path}:</span> {f.detail}
              </div>
            ))}
          </div>
        )}

        {d.primary_action_data && (
          <div className="border-t border-accent/20 p-3">
            <ActionCard data={d.primary_action_data} apiRole={apiRole} />
          </div>
        )}
      </div>
    );
  }

  if (data.type === "recovery_options") {
    const d = data.data as {
      preferred_category: string;
      check_in: string;
      check_out: string;
      requested_nights: number;
      options?: {
        kind: string;
        priority: string;
        title: string;
        category?: string;
        room_id?: string;
        check_in?: string;
        check_out?: string;
        nights?: number;
        discount_pct?: number;
        estimated_total?: number | null;
        pricing_action?: string;
        rationale?: string;
      }[];
      attempts?: string[];
    };
    return (
      <div className="mt-2 border border-accent/30 bg-accent/3">
        <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border-b border-accent/20 text-xs font-bold uppercase tracking-wider text-accent">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          Recovery Options
          <span className="ml-auto font-mono font-normal normal-case text-text">
            {d.preferred_category} · {d.requested_nights}n
          </span>
        </div>
        <div className="p-3 space-y-2">
          {(d.options ?? []).map((opt, i) => (
            <div key={`${opt.kind}-${i}`} className="border border-border bg-surface p-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 bg-accent/15 text-accent font-bold flex items-center justify-center text-[10px] shrink-0">
                      {i + 1}
                    </span>
                    <span className="font-bold text-text">{opt.title}</span>
                  </div>
                  <div className="mt-1 text-text-muted leading-relaxed">{opt.rationale}</div>
                </div>
                <span className="text-[9px] uppercase tracking-widest border border-border px-2 py-1 text-text-muted shrink-0">
                  {opt.priority}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-text-muted">
                {opt.room_id && <div>Room <span className="font-mono text-text">{opt.room_id}</span></div>}
                {opt.category && <div>Category <span className="text-text">{opt.category}</span></div>}
                {opt.check_in && opt.check_out && (
                  <div className="col-span-2">
                    Dates <span className="font-mono text-text">{opt.check_in} → {opt.check_out}</span>
                    {typeof opt.nights === "number" && <span> · {opt.nights}n</span>}
                  </div>
                )}
                {apiRole === "receptionist" && typeof opt.discount_pct === "number" && opt.discount_pct > 0 && (
                  <div>Offer <span className="text-accent">{opt.discount_pct}% discount</span></div>
                )}
                {apiRole === "receptionist" && typeof opt.estimated_total === "number" && (
                  <div>Total <span className="text-text">${Math.round(opt.estimated_total).toLocaleString("en-US")}</span></div>
                )}
                {apiRole === "receptionist" && opt.pricing_action && <div>Pricing <span className="text-text">{opt.pricing_action}</span></div>}
              </div>
            </div>
          ))}
        </div>
        {(d.attempts?.length ?? 0) > 0 && (
          <div className="border-t border-border bg-surface-2 px-3 py-2 text-[10px] text-text-muted">
            Exact full-stay paths checked: same-category split, mixed split, upgrades, alternatives, and nearby dates.
          </div>
        )}
      </div>
    );
  }

  if (data.type === "split_stay_result") {
    const d = data.data as {
      state: string;
      message: string;
      category: string;
      discount_pct: number;
      total_nights: number;
      total_rate: number;
      segments: SplitSegment[];
      request?: { category: string; check_in: string; check_out: string };
    };
    const isAlternateSplit =
      apiRole === "booking"
      && isAlternateToSearch(d.request, originalSearchRequest ?? undefined);
    const handleConfirmSplit = async () => {
      if (!guestName.trim()) { setConfirmErr("Enter guest name to confirm."); return; }
      if (!d.segments?.length) return;
      setConfirmErr(null);
      setConfirming(true);
      try {
        const r = await apiConfirmSplitStay({
          guest_name:      guestName.trim(),
          category:        d.category,
          discount_pct:    d.discount_pct,
          segments:        d.segments,
          channel:         "DIRECT",
          channel_partner: null,
        });
        setConfirmed({ booking_id: r.data.stay_group_id, room_id: `${d.segments.length} rooms` });
        show(`Split stay confirmed — Group ${r.data.stay_group_id}`, "success");
      } catch (e: unknown) {
        const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Confirm failed";
        setConfirmErr(msg);
      } finally {
        setConfirming(false);
      }
    };
    return (
      <div className="mt-2 border border-accent/30 bg-accent/3">
        <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border-b border-accent/20 text-xs font-bold uppercase tracking-wider text-accent">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          {isAlternateSplit ? "Alternate split stay" : "Split Stay"} — {d.segments?.length} rooms
          {d.discount_pct > 0 && <span> · {d.discount_pct}% off</span>}
          <span className="ml-auto font-mono font-normal normal-case text-text">${d.total_rate?.toLocaleString("en-US")} total</span>
        </div>
        {isAlternateSplit && originalSearchRequest && (
          <p className="px-3 pt-2 text-[10px] text-text-muted leading-relaxed">
            Covers different dates or segments than your original search (
            {originalSearchRequest.check_in} → {originalSearchRequest.check_out}).
          </p>
        )}
        <div className="p-3 space-y-1.5">
          {d.segments?.map((seg, i) => (
            <div key={i} className="flex items-center gap-3 text-xs">
              <div className="w-5 h-5 rounded-full bg-accent/20 text-accent font-bold flex items-center justify-center text-[10px] shrink-0">
                {i + 1}
              </div>
              <div className="flex-1 grid grid-cols-4 gap-2">
                {apiRole === "receptionist" ? (
                  <>
                    <span className="font-mono font-bold text-text">Room {seg.room_id}</span>
                    <span className="text-text-muted">Floor {seg.floor}</span>
                  </>
                ) : (
                  <span className="col-span-2 font-bold text-text">Stay segment {i + 1}</span>
                )}
                <span className="text-text-muted">{seg.check_in} → {seg.check_out}</span>
                <span className="text-text font-medium">${seg.discounted_rate?.toLocaleString("en-US")}/night</span>
              </div>
              <span className="text-text-muted shrink-0">{seg.nights}n</span>
            </div>
          ))}
        </div>
        {d.discount_pct > 0 && (
          <div className="px-3 py-2 border-t border-accent/20 text-[10px] text-accent font-medium">
            {d.discount_pct}% consecutive-stay discount saves ${
              Math.round(d.segments?.reduce((acc, s) => acc + s.nights * (s.base_rate - s.discounted_rate), 0) ?? 0)
                .toLocaleString("en-US")
            } vs full rate
          </div>
        )}
        {confirmed ? (
          <div className="bg-occugreen/10 border-t border-occugreen/30 p-3 text-xs">
            <div className="flex items-center gap-2 text-occugreen font-bold uppercase tracking-wider mb-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> Split Stay Committed
            </div>
            <div className="font-mono text-text">Group: {confirmed.booking_id}</div>
          </div>
        ) : (
          <div className="border-t border-border bg-surface-2 p-3 text-xs space-y-2">
            <div className="text-text-muted uppercase tracking-wider font-bold text-[10px]">
              Enter guest name and confirm to book all segments
            </div>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                placeholder="Guest name"
                value={guestName}
                onChange={e => setGuestName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleConfirmSplit()}
                className="flex-1 bg-surface border border-border px-3 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
              <button
                onClick={handleConfirmSplit}
                disabled={confirming}
                className="flex items-center gap-1.5 bg-accent text-surface font-bold uppercase tracking-wider text-[10px] px-4 py-1.5 hover:opacity-90 active:scale-95 disabled:opacity-50 transition-all"
              >
                {confirming ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardCheck className="w-3 h-3" />}
                {isAlternateSplit ? "Confirm this alternative" : "Confirm Split Stay"}
              </button>
            </div>
            {confirmErr && <div className="text-occured text-[10px]">{confirmErr}</div>}
          </div>
        )}
      </div>
    );
  }

  if (data.type === "availability_result") {
    const d = data.data as {
      state: string;
      room_id?: string;
      message?: string;
      comparison?: ComparisonTable;
      infeasible_dates?: string[];
      swap_plan?: SwapStep[];
      request?: { category: string; check_in: string; check_out: string };
    };
    const ok = d.state !== "NOT_POSSIBLE";
    const isAlternate =
      apiRole === "booking"
      && isAlternateToSearch(d.request, originalSearchRequest ?? undefined);

    const handleConfirm = async () => {
      if (!d.room_id || !d.request) return;
      if (!guestName.trim()) { setConfirmErr("Enter guest name to confirm."); return; }
      setConfirmErr(null);
      setConfirming(true);
      try {
        const r = await apiConfirmBooking({
          request: {
            category:        d.request.category,
            check_in:        d.request.check_in,
            check_out:       d.request.check_out,
            guest_name:      guestName.trim(),
            channel:         "DIRECT",
            channel_partner: null,
          },
          room_id:   d.room_id,
          swap_plan: d.swap_plan ?? [],
        });
        setConfirmed({ booking_id: r.data.booking_id, room_id: r.data.room_id });
        show(`Booking confirmed — ID ${r.data.booking_id}`, "success");
      } catch (e: unknown) {
        const msg = (e as { response?: { data?: { detail?: string } } })
          ?.response?.data?.detail ?? "Confirm failed";
        setConfirmErr(msg);
      } finally {
        setConfirming(false);
      }
    };

    return (
      <div className="mt-2">
        <div className={`flex items-center gap-2 px-3 py-2 border text-xs font-bold uppercase tracking-wider ${
          ok ? "bg-occugreen/5 border-occugreen/20 text-occugreen"
             : "bg-occured/5 border-occured/20 text-occured"
        }`}>
          {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
          <span>
            {isAlternate
              ? "Alternate stay available"
              : d.state === "DIRECT_AVAILABLE"
                ? (apiRole === "booking" ? "Your stay is available" : "Direct block available")
                : d.state === "SHUFFLE_POSSIBLE"
                  ? (apiRole === "booking" ? "Your stay is available" : "Available via rearrangement")
                  : "No room available"}
          </span>
          {d.room_id && apiRole === "receptionist" && (
            <span className="ml-auto font-mono font-normal normal-case text-text">Room {d.room_id}</span>
          )}
        </div>
        {isAlternate && d.request && originalSearchRequest && (
          <div className="mt-2 rounded-md border border-border bg-surface-2/60 px-3 py-2 text-[10px] text-text-muted leading-relaxed">
            <span className="font-bold text-text">Not your original search.</span>{" "}
            Requested {originalSearchRequest.check_in} → {originalSearchRequest.check_out} (
            {originalSearchRequest.category}) is unavailable. This option:{" "}
            {d.request.check_in} → {d.request.check_out} ({d.request.category}).
          </div>
        )}
        {apiRole === "receptionist" && d.comparison && <ComparisonSection comparison={d.comparison} />}
        {d.state === "NOT_POSSIBLE" && d.infeasible_dates && d.infeasible_dates.length > 0 && (
          <div className="bg-surface-2 border border-occured/30 p-3 mt-2 text-xs">
            <span className="font-bold text-occured uppercase tracking-wider">Fully blocked on: </span>
            <span className="text-text font-mono">{d.infeasible_dates.join(", ")}</span>
          </div>
        )}
        {ok && d.room_id && d.request && (
          confirmed ? (
            <div className="bg-occugreen/10 border border-occugreen/30 p-3 mt-2 text-xs">
              <div className="flex items-center gap-2 text-occugreen font-bold uppercase tracking-wider mb-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Booking Committed
              </div>
              <div className="font-mono text-text">
                ID: {confirmed.booking_id} {apiRole === "receptionist" && <span>· Room {confirmed.room_id}</span>}
              </div>
            </div>
          ) : (
            <div className="border border-border bg-surface-2 p-3 mt-2 text-xs space-y-2">
              <div className="text-text-muted uppercase tracking-wider font-bold text-[10px]">
                {isAlternate
                  ? "Enter guest name to confirm this alternate stay"
                  : "Enter guest name and confirm to book"}
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <input
                  type="text"
                  placeholder="Guest name"
                  value={guestName}
                  onChange={e => setGuestName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleConfirm()}
                  className="flex-1 min-w-32 bg-surface border border-border px-3 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
                />
                <button
                  onClick={handleConfirm}
                  disabled={confirming}
                  className="flex items-center gap-1.5 bg-accent text-surface font-bold uppercase tracking-wider text-[10px] px-4 py-1.5 hover:opacity-90 active:scale-95 disabled:opacity-50 transition-all"
                >
                  {confirming
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <ClipboardCheck className="w-3 h-3" />}
                  {isAlternate ? "Confirm this alternative" : "Confirm Booking"}
                </button>
              </div>
              {confirmErr && (
                <div className="text-occured text-[10px]">{confirmErr}</div>
              )}
            </div>
          )
        )}
      </div>
    );
  }
  return null;
}

export function ChatBubble({
  msg,
  apiRole,
  originalSearchRequest = null,
}: {
  msg: ChatMsg;
  apiRole: ApiRole;
  originalSearchRequest?: SearchRequestRef | null;
}) {
  const isUser = msg.role === "user";
  if (isUser && (
    msg.content.startsWith("[HANDOFF]")
    || msg.content.startsWith("[PREFS]")
    || msg.content.startsWith("[STRUCTURED_STATE]")
  )) return null;
  return (
    <div className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`w-7 h-7 flex items-center justify-center shrink-0 mt-0.5 border ${
        isUser ? "bg-surface-2 border-border" : "bg-accent/10 border-accent/20"
      }`}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-text-muted" />
          : <Bot className="w-3.5 h-3.5 text-accent" />}
      </div>
      <div className="max-w-[78%] space-y-1">
        <div className={`px-4 py-3 text-sm leading-relaxed border whitespace-pre-wrap ${
          isUser
            ? "bg-text text-surface border-text"
            : "bg-surface-2 border-border text-text"
        }`}>
          {msg.content}
        </div>
        {msg.action_data && (
          <ActionCard
            data={msg.action_data}
            apiRole={apiRole}
            originalSearchRequest={originalSearchRequest}
          />
        )}
      </div>
    </div>
  );
}

export interface FloatingAiWidgetProps {
  chatMessages: ChatMsg[];
  chatInput: string;
  setChatInput: (v: string) => void;
  chatLoading: boolean;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  onSend: () => void;
  aiOpen: boolean;
  setAiOpen: (v: boolean) => void;
  hasProactive: boolean;
  setHasProactive: (v: boolean) => void;
  apiRole: ApiRole;
  title?: string;
  subtitle?: string;
  originalSearchRequest?: SearchRequestRef | null;
}

export function FloatingAiWidget({
  chatMessages, chatInput, setChatInput, chatLoading, chatEndRef,
  onSend, aiOpen, setAiOpen, hasProactive, setHasProactive, apiRole,
  title, subtitle, originalSearchRequest = null,
}: FloatingAiWidgetProps) {
  const handleToggle = () => {
    setAiOpen(!aiOpen);
    if (hasProactive) setHasProactive(false);
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {aiOpen && (
        <div className="w-[380px] flex flex-col bg-surface border border-border shadow-2xl rounded-sm overflow-hidden" style={{ height: '520px' }}>
          <div className="flex items-center justify-between px-4 py-3 bg-surface-2 border-b border-border shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-accent flex items-center justify-center rounded-sm shrink-0">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div>
                <div className="text-sm font-serif font-bold text-text leading-tight">{title || "Stay Assistant"}</div>
                <div className="text-[9px] text-text-muted uppercase tracking-widest">{subtitle || "Find your perfect stay"}</div>
              </div>
            </div>
            <button onClick={handleToggle} className="w-7 h-7 flex items-center justify-center text-text-muted hover:text-text hover:bg-border rounded-sm transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 flex flex-col">
            {chatMessages.length === 0 && !chatLoading && (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <Bot className="w-9 h-9 text-accent/25 mb-3" />
                <p className="text-sm font-serif font-bold text-text mb-1">Always on. Ask anything.</p>
                <p className="text-xs text-text-muted max-w-[220px] leading-relaxed">
                  Ask about availability, upgrades, occupancy, or tonight's best rooms to sell.
                </p>
                <div className="mt-4 space-y-1.5 w-full max-w-[240px]">
                  {["What's looking good to sell today?", "Any upgrades available tonight?", "How's occupancy this week?"].map(q => (
                    <button key={q} onClick={() => setChatInput(q)}
                      className="w-full text-left text-[10px] text-accent border border-accent/20 bg-accent/5 px-3 py-2 hover:bg-accent/10 transition-colors font-medium">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <ChatBubble
                key={i}
                msg={msg}
                apiRole={apiRole}
                originalSearchRequest={originalSearchRequest}
              />
            ))}
            {chatLoading && (
              <div className="flex items-start gap-2.5">
                <div className="w-7 h-7 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 mt-0.5 rounded-sm">
                  <Bot className="w-3.5 h-3.5 text-accent" />
                </div>
                <div className="bg-surface-2 border border-border px-3 py-2.5 text-sm text-text-muted flex items-center gap-2 rounded-sm">
                  <Loader2 className="w-3 h-3 animate-spin text-accent" /> Thinking…
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-border p-3 flex gap-2 shrink-0">
            <input
              type="text"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
              placeholder="Ask about rooms or guests…"
              className="flex-1 bg-surface-2 border border-border text-sm px-3 py-2.5 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              disabled={chatLoading}
            />
            <button onClick={onSend} disabled={chatLoading || !chatInput.trim()}
              className="bg-accent text-white px-4 py-2.5 font-bold hover:brightness-110 active:scale-95 disabled:opacity-40 transition-all flex items-center">
              {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      <button
        onClick={handleToggle}
        className={`w-14 h-14 rounded-full bg-accent text-white shadow-xl flex items-center justify-center hover:brightness-110 active:scale-95 transition-all relative ${
          hasProactive ? 'ring-2 ring-occuorange ring-offset-2 ring-offset-surface' : ''
        }`}
      >
        <Bot className="w-6 h-6" />
        {hasProactive && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-occuorange rounded-full border-2 border-surface animate-bounce" />
        )}
      </button>
    </div>
  );
}
