import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { format, addDays } from "date-fns";
import { checkAvailability, confirmBooking, confirmSplitStay, listBookings, getAiContext, sendAiMessage, adminListCategories } from "../api/client";
import type { ShuffleResult, RoomCategory, ComparisonTable, SplitSegment, SwapStep } from "../types";
import { useToast } from "../components/shared/Toast";
import { CheckCircle2, ArrowRight, Loader2, Calendar, ClipboardCheck, Info, XCircle, Sparkles, Send, Bot, User, X } from "lucide-react";

const AI_HISTORY_KEY = "optihost_front_desk_ai_history";
const MAX_AI_HISTORY_MESSAGES = 20;
const AI_HISTORY_TTL_MS = 30 * 60 * 1000;
const FALLBACK_CATEGORIES: RoomCategory[] = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "PREMIUM", "SUITE"];

interface AdminCategorySummary {
  name: RoomCategory;
  room_count: number;
}

// Receptionist desk = direct routes only. OTA allocations happen in Manager → Channels.

// ── AI chat types ─────────────────────────────────────────────────────────────
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  action_data?: { type: string; data: Record<string, unknown> } | null;
}

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

const BT_BG: Record<string, string> = {
  EMPTY: "var(--green)",
  SOFT:  "var(--surface2)",
  HARD:  "var(--text)",
  NEW:   "var(--accent)", 
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
      />
    </div>
  );
}

function ComparisonSection({ comparison }: { comparison: ComparisonTable }) {
  const { dates, rows, summary } = comparison;
  return (
    <div className="bg-surface-2 border border-border p-5 mt-8">
      <h4 className="text-[10px] font-bold text-text uppercase tracking-[0.15em] mb-1">Room Swap Plan</h4>
      <p className="text-[10px] text-text-muted mb-4">Shows current state (BEFORE) and what changes after this booking is confirmed (AFTER).</p>

      {/* Plain-English move summary */}
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
        {/* Date column headers */}
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
              {/* Room title */}
              <div className="mb-2 text-[10px] font-bold text-text uppercase tracking-wider">{roomLabel}</div>

              {/* BEFORE row */}
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

              {/* AFTER row */}
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

      {/* Legend */}
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

// ── AI chat sub-components ────────────────────────────────────────────────────

function ActionCard({ data }: { data: { type: string; data: Record<string, unknown> } }) {
  // Confirm-from-chat state — agent only recommends; receptionist must click to commit
  const [guestName,      setGuestName]      = useState("");
  const [confirming,     setConfirming]     = useState(false);
  const [confirmed,      setConfirmed]      = useState<{ booking_id: string; room_id: string } | null>(null);
  const [confirmErr,     setConfirmErr]     = useState<string | null>(null);
  const { show } = useToast();

  if (data.type === "booking_confirmed") {
    const d = data.data as { booking_id: string; room_id: string };
    return (
      <div className="bg-occugreen/10 border border-occugreen/30 p-3 mt-2 text-xs">
        <div className="flex items-center gap-2 text-occugreen font-bold uppercase tracking-wider mb-1">
          <CheckCircle2 className="w-3.5 h-3.5" /> Booking Confirmed
        </div>
        <div className="font-mono text-text">ID: {d.booking_id} · Room {d.room_id}</div>
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
          {(d.options ?? []).map((opt, i) => {
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
                  {opt.pricing_signal?.action && (
                    <div>Pricing <span className="text-text">{opt.pricing_signal.action}</span></div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {(d.failures?.length ?? 0) > 0 && (
          <div className="border-t border-border bg-surface-2 px-3 py-2 text-[10px] text-text-muted space-y-1">
            {d.failures?.slice(0, 3).map((failure) => (
              <div key={failure.path}>
                <span className="font-bold text-text">{failure.path}:</span> {failure.detail}
              </div>
            ))}
          </div>
        )}

        {d.primary_action_data && (
          <div className="border-t border-accent/20 p-3">
            <ActionCard data={d.primary_action_data} />
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
                {typeof opt.discount_pct === "number" && opt.discount_pct > 0 && (
                  <div>Offer <span className="text-accent">{opt.discount_pct}% discount</span></div>
                )}
                {typeof opt.estimated_total === "number" && (
                  <div>Total <span className="text-text">${Math.round(opt.estimated_total).toLocaleString("en-US")}</span></div>
                )}
                {opt.pricing_action && <div>Pricing <span className="text-text">{opt.pricing_action}</span></div>}
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
    };

    const handleConfirmSplit = async () => {
      if (!guestName.trim()) { setConfirmErr("Enter guest name to confirm."); return; }
      if (!d.segments?.length) return;
      setConfirmErr(null);
      setConfirming(true);
      try {
        const r = await confirmSplitStay({
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
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border-b border-accent/20 text-xs font-bold uppercase tracking-wider text-accent">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          Split Stay — {d.segments?.length} rooms · {d.discount_pct}% discount
          <span className="ml-auto font-mono font-normal normal-case text-text">${d.total_rate?.toLocaleString("en-US")} total</span>
        </div>

        {/* Segment timeline */}
        <div className="p-3 space-y-1.5">
          {d.segments?.map((seg, i) => (
            <div key={i} className="flex items-center gap-3 text-xs">
              <div className="w-5 h-5 rounded-full bg-accent/20 text-accent font-bold flex items-center justify-center text-[10px] shrink-0">
                {i + 1}
              </div>
              <div className="flex-1 grid grid-cols-4 gap-2">
                <span className="font-mono font-bold text-text">Room {seg.room_id}</span>
                <span className="text-text-muted">Floor {seg.floor}</span>
                <span className="text-text-muted">{seg.check_in} → {seg.check_out}</span>
                <span className="text-text font-medium">${seg.discounted_rate?.toLocaleString("en-US")}/night</span>
              </div>
              <span className="text-text-muted shrink-0">{seg.nights}n</span>
            </div>
          ))}
        </div>

        {/* Divider + savings callout */}
        {d.discount_pct > 0 && (
          <div className="px-3 py-2 border-t border-accent/20 text-[10px] text-accent font-medium">
            {d.discount_pct}% consecutive-stay discount saves ${
              Math.round(d.segments?.reduce((acc, s) => acc + s.nights * (s.base_rate - s.discounted_rate), 0) ?? 0)
                .toLocaleString("en-US")
            } vs full rate
          </div>
        )}

        {/* Confirm section */}
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
                Confirm Split Stay
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

    const handleConfirm = async () => {
      if (!d.room_id || !d.request) return;
      if (!guestName.trim()) { setConfirmErr("Enter guest name to confirm."); return; }
      setConfirmErr(null);
      setConfirming(true);
      try {
        const r = await confirmBooking({
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
        {/* Status pill */}
        <div className={`flex items-center gap-2 px-3 py-2 border text-xs font-bold uppercase tracking-wider ${
          ok ? "bg-occugreen/5 border-occugreen/20 text-occugreen"
             : "bg-occured/5 border-occured/20 text-occured"
        }`}>
          {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
          <span>
            {d.state === "DIRECT_AVAILABLE" ? "Direct block available"
              : d.state === "SHUFFLE_POSSIBLE" ? "Available via rearrangement"
              : "No room available"}
          </span>
          {d.room_id && <span className="ml-auto font-mono font-normal normal-case text-text">Room {d.room_id}</span>}
        </div>

        {/* Full comparison table — same component as manual mode */}
        {d.comparison && <ComparisonSection comparison={d.comparison} />}

        {/* Infeasible dates for NOT_POSSIBLE */}
        {d.state === "NOT_POSSIBLE" && d.infeasible_dates && d.infeasible_dates.length > 0 && (
          <div className="bg-surface-2 border border-occured/30 p-3 mt-2 text-xs">
            <span className="font-bold text-occured uppercase tracking-wider">Fully blocked on: </span>
            <span className="text-text font-mono">{d.infeasible_dates.join(", ")}</span>
          </div>
        )}

        {/* ── Receptionist Confirm section ──────────────────────────────────
            AI only recommends — this button is what actually writes to DB   */}
        {ok && d.room_id && d.request && (
          confirmed ? (
            <div className="bg-occugreen/10 border border-occugreen/30 p-3 mt-2 text-xs">
              <div className="flex items-center gap-2 text-occugreen font-bold uppercase tracking-wider mb-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Booking Committed
              </div>
              <div className="font-mono text-text">
                ID: {confirmed.booking_id} · Room {confirmed.room_id}
              </div>
            </div>
          ) : (
            <div className="border border-border bg-surface-2 p-3 mt-2 text-xs space-y-2">
              <div className="text-text-muted uppercase tracking-wider font-bold text-[10px]">
                Enter guest name and confirm to book
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
                  Confirm Booking
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

function ChatBubble({ msg }: { msg: ChatMsg }) {
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
        {msg.action_data && <ActionCard data={msg.action_data} />}
      </div>
    </div>
  );
}

interface FloatingAiWidgetProps {
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
}

function FloatingAiWidget({
  chatMessages, chatInput, setChatInput, chatLoading, chatEndRef,
  onSend, aiOpen, setAiOpen, hasProactive, setHasProactive,
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
                <div className="text-sm font-serif font-bold text-text leading-tight">AI Revenue Assistant</div>
                <div className="text-[9px] text-text-muted uppercase tracking-widest">Live hotel intelligence</div>
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
            {chatMessages.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
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
