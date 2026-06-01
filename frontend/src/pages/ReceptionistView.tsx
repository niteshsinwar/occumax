import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { format, addDays } from "date-fns";
import { checkAvailability, confirmBooking, listBookings, getAiContext, sendAiMessage, adminListCategories } from "../api/client";
import type { ShuffleResult, RoomCategory } from "../types";
import { useToast } from "../components/shared/Toast";
import { CheckCircle2, Loader2, Info, Sparkles, ArrowRight, Calendar, ClipboardCheck, XCircle } from "lucide-react";
import { FloatingAiWidget, type ChatMsg, ComparisonSection } from "../components/shared/FloatingAiWidget";

const AI_HISTORY_KEY = "optihost_front_desk_ai_history";
const MAX_AI_HISTORY_MESSAGES = 20;
const AI_HISTORY_TTL_MS = 30 * 60 * 1000;
const FALLBACK_CATEGORIES: RoomCategory[] = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "PREMIUM", "SUITE"];

interface AdminCategorySummary {
  name: RoomCategory;
  room_count: number;
}

// Receptionist desk = direct routes only. OTA allocations happen in Manager → Channels.

interface AiHistorySnapshot {
  searchKey: string;
  savedAt: number;
  messages: ChatMsg[];
}

type StepState = "idle" | "running" | "done" | "skipped";
interface CheckSteps { direct: StepState; shuffle: StepState; }
interface RecentBooking {
  id: string; guest_name: string; category: string; room_id: string;
  check_in: string; check_out: string; is_live: boolean;
}

const trimAiHistory = (messages: ChatMsg[]) => messages.slice(-MAX_AI_HISTORY_MESSAGES);
const persistableAiHistory = (messages: ChatMsg[]) =>
  trimAiHistory(messages);

const latestStructuredStateMessage = (messages: ChatMsg[]): ChatMsg | null => {
  const latest = [...messages].reverse().find((msg) => msg.role === "assistant" && msg.action_data);
  if (!latest?.action_data) return null;
  const payload = {
    source: "previous_assistant_action_data",
    action_data: latest.action_data,
  };
  return {
    role: "user",
    content: `[STRUCTURED_STATE]\n${JSON.stringify(payload)}`,
  };
};

export function ReceptionistView() {
  const today      = format(new Date(), "yyyy-MM-dd");
  const maxDate    = format(addDays(new Date(), 20), "yyyy-MM-dd");
  const defaultOut = format(addDays(new Date(), 3), "yyyy-MM-dd");

  const [category,       setCategory]       = useState<RoomCategory>("DELUXE");
  const [checkIn,        setCheckIn]        = useState(today);
  const [checkOut,       setCheckOut]       = useState(defaultOut);
  const [guestName,      setGuestName]      = useState("");
  const searchKey = useMemo(() => `${category}|${checkIn}|${checkOut}`, [category, checkIn, checkOut]);

  const [checking,       setChecking]       = useState(false);
  const [confirming,     setConfirming]     = useState(false);
  const [result,         setResult]         = useState<ShuffleResult | null>(null);
  const [steps,          setSteps]          = useState<CheckSteps>({ direct: "idle", shuffle: "idle" });
  const [recentBookings, setRecentBookings] = useState<RecentBooking[]>([]);
  const [loadingRecent,  setLoadingRecent]  = useState(false);
  const [lastConfirmed,  setLastConfirmed]  = useState<string | null>(null);
  const { show, Toasts } = useToast();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── AI floating agent state ───────────────────────────────────────────────
  const [chatMessages,    setChatMessages]    = useState<ChatMsg[]>([]);
  const [chatInput,       setChatInput]       = useState("");
  const [chatLoading,     setChatLoading]     = useState(false);
  const [hotelContext,    setHotelContext]    = useState<string | null>(null);
  const [aiOpen,          setAiOpen]          = useState(false);
  const [aiHasProactive,  setAiHasProactive]  = useState(false);

  const [activeCategories, setActiveCategories] = useState<RoomCategory[]>(FALLBACK_CATEGORIES);

  useEffect(() => {
    adminListCategories().then((res) => {
      const live = (res.data as AdminCategorySummary[])
        .filter((c) => c.room_count > 0)
        .map((c) => c.name);
      if (live.length > 0) {
        setActiveCategories(live);
        setCategory((current) => live.includes(current) ? current : live[0]);
      }
    }).catch(() => {});
  }, []);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const aiRunIdRef = useRef(0);

  const loadRecent = useCallback(async () => {
    setLoadingRecent(true);
    try {
      const r = await listBookings();
      setRecentBookings(r.data.slice(0, 8));
    } catch {
      show("Failed to load recent bookings", "error");
    } finally {
      setLoadingRecent(false);
    }
  }, [show]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(AI_HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AiHistorySnapshot;
      if (
        parsed.searchKey === searchKey
        && Date.now() - parsed.savedAt < AI_HISTORY_TTL_MS
        && Array.isArray(parsed.messages)
      ) {
        setChatMessages(trimAiHistory(parsed.messages));
      } else {
        window.sessionStorage.removeItem(AI_HISTORY_KEY);
      }
    } catch {
      window.sessionStorage.removeItem(AI_HISTORY_KEY);
    }
  }, [searchKey]);

  useEffect(() => {
    try {
      const messages = persistableAiHistory(chatMessages);
      if (!messages.length) {
        window.sessionStorage.removeItem(AI_HISTORY_KEY);
        return;
      }
      window.sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify({
        searchKey,
        savedAt: Date.now(),
        messages,
      } satisfies AiHistorySnapshot));
    } catch {
      // Non-critical: chat history persistence should never block booking flow.
    }
  }, [chatMessages, searchKey]);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const handleCheck = async () => {
    // Clear previous chat/AI state when explicitly running a new check
    aiRunIdRef.current += 1;
    setChatMessages([]);
    setChatLoading(false);
    setAiHasProactive(false);
    window.sessionStorage.removeItem(AI_HISTORY_KEY);

    if (!checkIn || !checkOut || checkOut <= checkIn) {
      show("Please select valid dates", "error");
      return;
    }
    clearTimers();
    const runId = aiRunIdRef.current + 1;
    aiRunIdRef.current = runId;
    setChecking(true);
    setResult(null);
    setLastConfirmed(null);
    setChatMessages([]);
    window.sessionStorage.removeItem(AI_HISTORY_KEY);
    setAiHasProactive(false);

    setSteps({ direct: "running", shuffle: "idle" });
    timers.current.push(setTimeout(() => {
      setSteps((s) => ({ ...s, direct: "done", shuffle: "running" }));
    }, 400));

    try {
      const res = await checkAvailability({
        category, check_in: checkIn, check_out: checkOut, guest_name: guestName || "Direct Guest",
      });
      const data = res.data as ShuffleResult;
      setSteps({ direct: "done", shuffle: data.state === "DIRECT_AVAILABLE" ? "skipped" : "done" });
      setResult(data);
      if (data.state === "NOT_POSSIBLE") {
        // Auto-open floating agent and proactively fire handoff
        setAiOpen(true);
        setAiHasProactive(true);
        setTimeout(() => triggerAiHandoff(data, runId), 100);
      }
    } catch {
      show("Failed to check availability", "error");
      setSteps({ direct: "idle", shuffle: "idle" });
    } finally {
      setChecking(false);
      clearTimers();
    }
  };

  const handleConfirm = async () => {
    if (!result?.room_id) return;
    setConfirming(true);
    try {
      const res = await confirmBooking({
        request: { category, check_in: checkIn, check_out: checkOut, guest_name: guestName || "Direct Guest", channel: "DIRECT", channel_partner: null },
        room_id: result.room_id, swap_plan: result.swap_plan ?? undefined,
      });
      setLastConfirmed(res.data.booking_id);
      setResult(null);
      setSteps({ direct: "idle", shuffle: "idle" });
      show(`Booking ${res.data.booking_id} confirmed!`, "success");
      loadRecent();
    } catch {
      show("Failed to confirm booking", "error");
    } finally {
      setConfirming(false);
    }
  };

  // ── AI core: accepts explicit text + history so handoff can fire directly ──
  const fireAiMessage = async (text: string, history: ChatMsg[], runId = aiRunIdRef.current) => {
    const userMsg: ChatMsg = { role: "user", content: text };
    const stateMsg = latestStructuredStateMessage(history);
    const updated = trimAiHistory([
      ...history,
      ...(stateMsg && !text.startsWith("[HANDOFF]") && !text.startsWith("[PREFS]") ? [stateMsg] : []),
      userMsg,
    ]);
    if (runId !== aiRunIdRef.current) return;
    setChatMessages(updated);
    setChatLoading(true);

    let ctx = hotelContext;
    try {
      const ctxRes = await getAiContext();
      ctx = (ctxRes.data.context_text as string) ?? "";
      setHotelContext(ctx);
    } catch {
      ctx = ctx ?? "";
    }

    try {
      const res = await sendAiMessage(
        updated.map(m => ({ role: m.role, content: m.content })),
        ctx ?? undefined,
      );
      if (runId !== aiRunIdRef.current) return;
      const aMsg: ChatMsg = {
        role: "assistant",
        content: res.data.reply,
        action_data: res.data.action_data ?? null,
      };
      setChatMessages(prev => trimAiHistory([...prev, aMsg]));
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch {
      if (runId === aiRunIdRef.current) show("AI agent error — please try again", "error");
    } finally {
      if (runId === aiRunIdRef.current) setChatLoading(false);
    }
  };

  // Input bar handler — uses live chatInput + existing history
  const handleSendAiMessage = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    setChatInput("");
    await fireAiMessage(text, chatMessages);
  };

  // Proactive handoff — fires automatically when booking returns NOT_POSSIBLE.
  // Sends a maximally directive payload: the agent must explore ALL paths and
  // present a complete numbered options menu BEFORE the receptionist asks.
  const triggerAiHandoff = async (data: ShuffleResult, runId = aiRunIdRef.current) => {
    if (runId !== aiRunIdRef.current) return;
    const name = guestName.trim() || "Direct Guest";
    const handoff = {
      type: "booking_recovery_handoff",
      execution_mode: "EXPLORE_ALL_OPTIONS",
      // ── Explicit step-by-step instructions for the agent ──────────────────
      instructions: [
        "Execute ALL steps in allowed_paths IN SEQUENCE, one tool per turn.",
        "Do NOT stop at the first success — continue through every allowed path.",
        "Tally EVERY option found (split stays, upgrades, alt categories, date shifts, shortened fragments).",
        "After all steps: present a numbered options list covering every viable path found.",
        "For each option include: room(s), dates, estimated total, discount if pricing recommends one, and ONE revenue insight.",
        "Rank by: same-category full stay > split stay > upgrade > alt category > date shift > shortened stay.",
        "Use pricing intelligence from hotel_context to annotate each option with a demand signal.",
        "Attach the action card for the top-ranked confirmable option; describe all others in text.",
        "End with: 'Which of these works best for this guest?'",
      ],
      guest: { name },
      request: {
        preferred_category: category,
        check_in: checkIn,
        check_out: checkOut,
        nights,
      },
      deterministic_check: {
        state: "NOT_POSSIBLE",
        message: data.message,
        infeasible_dates: data.infeasible_dates ?? [],
      },
      allowed_paths: {
        same_category_split: true,
        mixed_category_split: true,
        upgrade: true,
        alternative_category: true,
        nearby_dates_pm1: true,
        shortened_stay_fragment: true,
      },
      decision_policy: {
        explore_all_paths_before_responding: true,
        present_numbered_options_menu: true,
        use_pricing_intelligence_for_ranking: true,
        never_call_build_recovery_options_before_full_stay_paths: true,
        stop_only_when_tool_budget_exhausted_or_all_paths_tried: true,
        never_ask_permission_before_a_tool_call: true,
      },
    };
    await fireAiMessage(`[HANDOFF]\n${JSON.stringify(handoff, null, 2)}`, [], runId);
  };

  const nights = checkIn && checkOut ? Math.max(0, (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000) : 0;
  const isAvailable = result && result.state !== "NOT_POSSIBLE";

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <Toasts />

      {/* Header */}
      <div className="border-b border-border/50 pb-4 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-serif font-bold text-text">Front Desk</h1>
          <p className="text-xs text-text-muted mt-1 uppercase tracking-widest font-medium">
            <span className="flex items-center gap-1.5">
              Room Availability &amp; Reservations
            </span>
          </p>
        </div>
        <span className="text-[9px] font-bold bg-accent/10 text-accent border border-accent/20 px-3 py-1.5 uppercase tracking-widest flex items-center gap-1.5 shrink-0">
          <Sparkles className="w-2.5 h-2.5" /> AI Ready
        </span>
      </div>

      <div className="space-y-6">

      {/* Booking Wizard */}
      <div className="bg-surface border border-border mt-4 shadow-subtle p-6 rounded-sm relative overflow-hidden group">
        <div className="absolute top-0 left-0 w-1 h-full bg-accent/30" />
        <div className="flex items-center justify-between mb-6 pb-6 border-b border-border/50">
          <div className="flex items-center gap-4 text-xs font-bold uppercase tracking-wider">
            <StepPill label="1. Checking rooms" state={steps.direct} />
            <ArrowRight className="w-4 h-4 text-border" />
            <StepPill label="2. Looking deeper" state={steps.shuffle} />
          </div>
          <span className="text-[9px] font-bold tracking-[0.1em] bg-surface-2 text-text-muted px-3 py-1 border border-border/50">{steps.direct === "idle" && steps.shuffle === "idle" ? "Ready" : steps.direct === "running" || steps.shuffle === "running" ? "Searching..." : "Done"}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Category</label>
            <select className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-3 focus:border-accent focus:ring-1 focus:ring-accent outline-none" value={category} onChange={(e) => setCategory(e.target.value as RoomCategory)}>
              {activeCategories.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Check-in</label>
            <input type="date" className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-3 focus:border-accent focus:ring-1 focus:ring-accent outline-none" value={checkIn} min={today} max={maxDate} onChange={(e) => setCheckIn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Check-out</label>
            <input type="date" className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-3 focus:border-accent focus:ring-1 focus:ring-accent outline-none" value={checkOut} min={checkIn} max={maxDate} onChange={(e) => setCheckOut(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Guest Name</label>
            <input type="text" className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-3 focus:border-accent focus:ring-1 focus:ring-accent outline-none font-serif" placeholder="Direct Guest" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          </div>

        </div>

        <div className="flex items-center justify-between pt-4">
          <div className="text-xs font-bold uppercase tracking-widest text-text-muted">
            {nights > 0 ? <span className="flex items-center gap-2"><Calendar className="w-4 h-4"/> {nights} nights <span className="mx-1 text-border">•</span> {category}</span> : "Select dates to continue"}
          </div>
          <button className="bg-text text-surface font-semibold hover:opacity-90 active:scale-95 disabled:opacity-40 shadow-sm flex items-center justify-center gap-2 px-8 py-3.5 rounded-sm transition-all uppercase tracking-widest text-xs" onClick={handleCheck} disabled={checking || nights < 1}>
            {checking ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching...</> : "Check Availability"}
          </button>
        </div>
      </div>

      {/* Result Card */}
      {result && (
        <div className={`p-8 border ${isAvailable ? 'bg-surface border-occugreen/30' : 'bg-surface border-occured/30'} shadow-subtle relative overflow-hidden`}>
          <div className={`absolute top-0 left-0 w-1 h-full ${isAvailable ? 'bg-occugreen' : 'bg-occured'}`} />
          <div className="flex items-start gap-4 mb-8">
            <div className={`p-3 border rounded-sm shrink-0 ${isAvailable ? 'border-occugreen/20 bg-occugreen/5' : 'border-occured/20 bg-occured/5'}`}>
              {result.state === "DIRECT_AVAILABLE" ? <CheckCircle2 className="w-6 h-6 text-occugreen" /> : result.state === "SHUFFLE_POSSIBLE" ? <ClipboardCheck className="w-6 h-6 text-occugreen" /> : <XCircle className="w-6 h-6 text-occured" />}
            </div>
            <div className="min-w-0">
              <h3 className={`text-xl font-serif font-bold ${isAvailable ? 'text-text' : 'text-occured'}`}>
                {result.state === "DIRECT_AVAILABLE" && "Room Available"}
                {result.state === "SHUFFLE_POSSIBLE" && "Room Available via Rearrangement"}
                {result.state === "NOT_POSSIBLE" && "No Rooms Available"}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {result.state === "DIRECT_AVAILABLE" && (
                  <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 border border-occugreen/30 bg-occugreen/5 text-occugreen">
                    Converted (direct match)
                  </span>
                )}
                {result.state === "SHUFFLE_POSSIBLE" && (
                  <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 border border-accent/30 bg-accent/5 text-accent">
                    Rescued via room shuffle
                  </span>
                )}
                {result.state === "NOT_POSSIBLE" && (
                  <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 border border-occured/30 bg-occured/5 text-occured">
                    Needs alternatives
                  </span>
                )}
                {result.state === "SHUFFLE_POSSIBLE" && result.swap_plan && result.swap_plan.length > 0 && (
                  <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 border border-border bg-surface-2 text-text-muted">
                    {result.swap_plan.length} move{result.swap_plan.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <p className="text-xs tracking-wide uppercase font-bold text-text-muted mt-2">{result.message}</p>
            </div>
          </div>

          {result.comparison && <ComparisonSection comparison={result.comparison} />}

          {result.state === "NOT_POSSIBLE" && result.infeasible_dates && (
            <div className="bg-surface-2 border border-occured/30 p-5 mt-6">
              <h4 className="text-xs font-bold text-occured flex items-center gap-2 mb-2 uppercase tracking-widest"><Info className="w-4 h-4"/> Fully Booked On These Dates</h4>
              <p className="text-sm text-text-muted">All {category} rooms are occupied on: <span className="font-bold text-text">{result.infeasible_dates.join(", ")}</span>.</p>
            </div>
          )}

          {result.state === "NOT_POSSIBLE" && (
            <div className="mt-6 flex items-center gap-3 bg-accent/5 border border-accent/20 px-5 py-4">
              <Sparkles className="w-4 h-4 text-accent shrink-0 animate-pulse" />
              <span className="text-xs text-accent">
                No {category} rooms for <span className="font-bold">{checkIn} → {checkOut}</span> — AI assistant is finding the best alternative.
                <span className="ml-1 text-text-muted">Check the chat bubble at the bottom right.</span>
              </span>
            </div>
          )}

          {/* Deterministic alternatives are now opt-in via the Explore panel toggle */}

          {isAvailable && result.room_id && (
            <div className="flex flex-wrap gap-4 mt-8 pt-6 border-t border-border/50">
              <button className="flex-1 bg-occugreen text-white font-bold hover:brightness-110 active:scale-95 disabled:opacity-40 shadow-sm flex items-center justify-center gap-2 px-6 py-4 transition-all uppercase tracking-widest text-[11px]" onClick={handleConfirm} disabled={confirming}>
                {confirming ? <><Loader2 className="w-4 h-4 animate-spin" /> Confirming...</> : <span>Confirm Booking — Room {result.room_id}</span>}
              </button>
              <button className="bg-surface hover:bg-surface-2 border border-border text-text font-bold uppercase tracking-widest text-[11px] px-8 py-4 transition-colors" onClick={() => { setResult(null); setSteps({ direct: "idle", shuffle: "idle" }); }}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* Success Banner */}
      {lastConfirmed && (
        <div className="bg-surface border border-occugreen/30 p-10 text-center shadow-subtle flex flex-col items-center">
          <CheckCircle2 className="w-12 h-12 text-occugreen mb-4" />
          <h2 className="text-3xl font-serif font-bold text-text mb-2">Booking Confirmed</h2>
          <p className="text-text-muted tracking-wide text-sm font-medium mb-8">Booking ID: <span className="text-text font-mono font-bold bg-surface-2 border border-border px-3 py-1">{lastConfirmed}</span></p>
          <button className="bg-surface-2 border border-border text-text font-bold uppercase tracking-widest text-xs hover:bg-border active:scale-95 px-8 py-3 shadow-sm transition-all" onClick={() => { setLastConfirmed(null); setGuestName(""); }}>New Booking</button>
        </div>
      )}


      {/* Recent Bookings — full-width 4-col grid */}
      <div className="bg-surface border border-border shadow-subtle p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-serif font-bold text-lg text-text">Recent Bookings</h3>
          <button className="text-[10px] font-bold uppercase tracking-widest text-text-muted hover:text-text flex items-center gap-1 bg-surface-2 border border-border px-3 py-1.5 transition-colors" onClick={loadRecent} disabled={loadingRecent}>
            {loadingRecent ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : "Refresh"}
          </button>
        </div>
        {recentBookings.length === 0 ? (
          <div className="py-8 text-center text-text-muted font-medium text-sm border-t border-border/50">No recent bookings.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {recentBookings.map((b) => (
              <div key={b.id} className="border border-border bg-surface-2/40 px-4 py-3 hover:bg-surface-2/70 transition-colors">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="font-serif font-medium text-sm text-text truncate">{b.guest_name}</span>
                  <span className={`shrink-0 inline-flex items-center px-2 py-0.5 border text-[9px] font-bold tracking-[0.1em] uppercase ${
                    b.is_live ? 'bg-occugreen/10 text-occugreen border-occugreen/20' : 'bg-surface-2 text-text-muted border-border'
                  }`}>{b.is_live ? "IN-HOUSE" : "CONFIRMED"}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-text-muted font-mono">
                  <span className="font-bold text-text">Room {b.room_id}</span>
                  <span className="text-border">·</span>
                  <span>{b.category}</span>
                </div>
                <div className="text-[10px] text-text-muted mt-1 font-mono">{b.check_in} → {b.check_out}</div>
                <div className="text-[9px] text-text-muted/60 mt-0.5 font-mono truncate">{b.id}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      </div>

      <FloatingAiWidget
        chatMessages={chatMessages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        chatLoading={chatLoading}
        chatEndRef={chatEndRef}
        onSend={handleSendAiMessage}
        aiOpen={aiOpen}
        setAiOpen={setAiOpen}
        hasProactive={aiHasProactive}
        setHasProactive={setAiHasProactive}
        apiRole="receptionist"
        title="AI Revenue Assistant"
        subtitle="Live hotel intelligence"
      />
    </div>
  );
}


function StepPill({ label, state }: { label: string; state: StepState }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase font-bold tracking-widest transition-all ${state === "running" ? "text-accent bg-accent/5 border border-accent/20" : state === "done" ? "text-occugreen bg-occugreen/5 border border-occugreen/20" : state === "skipped" ? "opacity-50 text-text border border-transparent" : "text-text border border-transparent"}`}>
      {state === "running" && <Loader2 className="w-3 h-3 animate-spin" />}
      {state === "idle" && <div className="w-1.5 h-1.5 bg-border" />}
      {state === "done" && <CheckCircle2 className="w-3.5 h-3.5" />}
      {label}
    </div>
  );
}
