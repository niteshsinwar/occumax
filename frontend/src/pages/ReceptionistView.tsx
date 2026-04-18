import { useState, useEffect, useRef } from "react";
import { format, addDays } from "date-fns";
import { checkAvailability, confirmBooking, confirmSplitStay, findSplitStay, listBookings, getAiContext, sendAiMessage } from "../api/client";
import type { ShuffleResult, RoomCategory, ComparisonTable, Alternative, SplitSegment } from "../types";
import { useToast } from "../components/shared/Toast";
import { CheckCircle2, ArrowRight, Loader2, Calendar, ClipboardCheck, Info, XCircle, Sparkles, Send, Bot, User } from "lucide-react";

const CATEGORIES: RoomCategory[] = ["STANDARD", "STUDIO", "DELUXE", "SUITE"];

// ── AI chat types ─────────────────────────────────────────────────────────────
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  action_data?: { type: string; data: Record<string, unknown> } | null;
}

type StepState = "idle" | "running" | "done" | "skipped";
interface CheckSteps { direct: StepState; shuffle: StepState; }
interface RecentBooking {
  id: string; guest_name: string; category: string; room_id: string;
  check_in: string; check_out: string; is_live: boolean;
}

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
  const [checking,       setChecking]       = useState(false);
  const [confirming,     setConfirming]     = useState(false);
  const [result,         setResult]         = useState<ShuffleResult | null>(null);
  const [steps,          setSteps]          = useState<CheckSteps>({ direct: "idle", shuffle: "idle" });
  const [recentBookings, setRecentBookings] = useState<RecentBooking[]>([]);
  const [loadingRecent,  setLoadingRecent]  = useState(false);
  const [lastConfirmed,  setLastConfirmed]  = useState<string | null>(null);
  const [showFallback,   setShowFallback]   = useState(false);
  const [showDeterministicAlternatives, setShowDeterministicAlternatives] = useState(false);
  const [fallbackPrefs,  setFallbackPrefs]  = useState({
    nearbyDatesPm1: true,
    differentCategory: true,
    splitStay: true,
    allowMixedCategorySplit: false,
  });
  const { show, Toasts } = useToast();
  const timers    = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── AI chat state — always-on parallel assistant ─────────────────────────
  const [aiGuided,     setAiGuided]    = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput,    setChatInput]   = useState("");
  const [chatLoading,  setChatLoading] = useState(false);
  const [hotelContext, setHotelContext] = useState<string | null>(null);
  const chatEndRef  = useRef<HTMLDivElement>(null);
  const aiPanelRef  = useRef<HTMLDivElement>(null);

  const loadRecent = async () => {
    setLoadingRecent(true);
    try {
      const r = await listBookings();
      setRecentBookings(r.data.slice(0, 8));
    } catch {
      show("Failed to load recent bookings", "error");
    } finally {
      setLoadingRecent(false);
    }
  };

  useEffect(() => { loadRecent(); }, []);
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const handleCheck = async () => {
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      show("Please select valid dates", "error");
      return;
    }
    clearTimers();
    setChecking(true);
    setResult(null);
    setLastConfirmed(null);
    setAiGuided(false);
    setChatMessages([]);
    setShowFallback(false);
    setShowDeterministicAlternatives(false);

    setSteps({ direct: "running", shuffle: "idle" });
    timers.current.push(setTimeout(() => {
      setSteps((s) => ({ ...s, direct: "done", shuffle: "running" }));
    }, 400));

    try {
      const res = await checkAvailability({
        category, check_in: checkIn, check_out: checkOut, guest_name: guestName || "Walk-in Guest",
      });
      const data = res.data as ShuffleResult;
      setSteps({ direct: "done", shuffle: data.state === "DIRECT_AVAILABLE" ? "skipped" : "done" });
      setResult(data);
      if (data.state === "NOT_POSSIBLE") {
        // Do not pre-run split stay checks here — split is one of the selectable
        // fallback options and should only run as part of guided agentic search.
        setShowFallback(true);
        // Auto handoff to AI using current default filter selections.
        // Receptionist can toggle filters and re-run the guided handoff.
        setTimeout(() => { handleExploreWithAi(); }, 0);
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
        request: { category, check_in: checkIn, check_out: checkOut, guest_name: guestName || "Walk-in Guest" },
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
  const fireAiMessage = async (text: string, history: ChatMsg[]) => {
    const userMsg: ChatMsg = { role: "user", content: text };
    const updated = [...history, userMsg];
    setChatMessages(updated);
    setChatLoading(true);

    let ctx = hotelContext;
    if (!ctx) {
      try {
        const ctxRes = await getAiContext();
        ctx = (ctxRes.data.context_text as string) ?? "";
        setHotelContext(ctx);
      } catch { ctx = ""; }
    }

    try {
      const res = await sendAiMessage(
        updated.map(m => ({ role: m.role, content: m.content })),
        ctx ?? undefined,
      );
      const aMsg: ChatMsg = {
        role: "assistant",
        content: res.data.reply,
        action_data: res.data.action_data ?? null,
      };
      setChatMessages(prev => [...prev, aMsg]);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

      // ── Post-process: if AI returned no actionable card, run deterministic
      // fallback pipeline silently and append a card to the chat.
      // Covers: AI mentions alternative verbally without calling the tool,
      // or AI's tool chain ends on NOT_POSSIBLE without trying shifted dates.
      const ad = res.data.action_data;
      const isActionable = ad?.type === "availability_result" && (ad.data as Record<string,unknown>)?.state !== "NOT_POSSIBLE";
      const isSplitCard  = ad?.type === "split_stay_result";

      // Deduplication: build a fingerprint of every card already shown in chat
      // so we never inject the exact same room+dates twice in the same session.
      const shownCards = new Set(
        chatMessages
          .filter(m => m.action_data?.type === "availability_result")
          .map(m => {
            const d = m.action_data!.data as Record<string, unknown>;
            const req = d.request as Record<string, unknown> | undefined;
            return `${d.room_id}|${req?.check_in}|${req?.check_out}`;
          })
      );

      if (!aiGuided && !isActionable && !isSplitCard && checkIn && checkOut && category) {
        const name    = guestName.trim() || "Walk-in Guest";
        const nights  = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000);
        // +1 day shift — same duration, one day later
        const shiftedIn  = new Date(checkIn);
        shiftedIn.setDate(shiftedIn.getDate() + 1);
        const shiftedOut = new Date(shiftedIn);
        shiftedOut.setDate(shiftedOut.getDate() + nights);
        const shiftedCheckIn  = shiftedIn.toISOString().slice(0, 10);
        const shiftedCheckOut = shiftedOut.toISOString().slice(0, 10);

        const LADDER = ["ECONOMY", "STANDARD", "STUDIO", "DELUXE", "PREMIUM", "SUITE"] as const;
        const idx    = LADDER.indexOf(category as typeof LADDER[number]);
        const upCat  = idx < LADDER.length - 1 ? LADDER[idx + 1] : null;
        const dnCat  = idx > 0 ? LADDER[idx - 1] : null;

        // Ordered fallback attempts
        const attempts: Array<{ label: string; fn: () => Promise<unknown> }> = [
          // split stay (exact dates)
          { label: "split", fn: async () => {
            const r = await findSplitStay({ category, check_in: checkIn, check_out: checkOut, guest_name: name });
            if (r.data.state === "SPLIT_POSSIBLE") return { type: "split", data: r.data };
            return null;
          }},
          // same category, same dates
          { label: `${category} exact`, fn: async () => {
            const r = await checkAvailability({ category, check_in: checkIn, check_out: checkOut, guest_name: name });
            if (r.data.state !== "NOT_POSSIBLE") return { type: "avail", cat: category, ci: checkIn, co: checkOut, data: r.data };
            return null;
          }},
          // same category, +1 day shift
          { label: `${category} +1d`, fn: async () => {
            const r = await checkAvailability({ category, check_in: shiftedCheckIn, check_out: shiftedCheckOut, guest_name: name });
            if (r.data.state !== "NOT_POSSIBLE") return { type: "avail", cat: category, ci: shiftedCheckIn, co: shiftedCheckOut, data: r.data };
            return null;
          }},
          // one category up, exact dates
          ...(upCat ? [{ label: upCat, fn: async () => {
            const r = await checkAvailability({ category: upCat, check_in: checkIn, check_out: checkOut, guest_name: name });
            if (r.data.state !== "NOT_POSSIBLE") return { type: "avail", cat: upCat, ci: checkIn, co: checkOut, data: r.data };
            return null;
          }}] : []),
          // one category down, exact dates
          ...(dnCat ? [{ label: dnCat, fn: async () => {
            const r = await checkAvailability({ category: dnCat, check_in: checkIn, check_out: checkOut, guest_name: name });
            if (r.data.state !== "NOT_POSSIBLE") return { type: "avail", cat: dnCat, ci: checkIn, co: checkOut, data: r.data };
            return null;
          }}] : []),
        ];

        for (const attempt of attempts) {
          try {
            const result = await attempt.fn() as { type: string; data: Record<string, unknown>; cat?: string; ci?: string; co?: string } | null;
            if (!result) continue;

            let card: ChatMsg;
            if (result.type === "split") {
              const sd = result.data as { segments?: unknown[]; discount_pct?: number };
              card = {
                role: "assistant",
                content: `${category} split stay available across ${sd.segments?.length} rooms with ${sd.discount_pct}% discount.`,
                action_data: { type: "split_stay_result", data: { ...result.data, category } as Record<string, unknown> },
              };
            } else {
              const avail = result.data as unknown as ShuffleResult;
              const fingerprint = `${avail.room_id}|${result.ci}|${result.co}`;
              if (shownCards.has(fingerprint)) continue; // already shown this exact card
              card = {
                role: "assistant",
                content: `Room ${avail.room_id} (${result.cat}) is available ${result.ci} → ${result.co}.`,
                action_data: {
                  type: "availability_result",
                  data: { ...avail, request: { category: result.cat, check_in: result.ci, check_out: result.co } } as Record<string, unknown>,
                },
              };
            }
            setChatMessages(prev => [...prev, card]);
            setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
            break; // first success wins
          } catch { /* continue to next attempt */ }
        }
      }
    } catch {
      show("AI agent error — please try again", "error");
    } finally {
      setChatLoading(false);
    }
  };

  // Input bar handler — uses live chatInput + existing history
  const handleSendAiMessage = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    setChatInput("");
    await fireAiMessage(text, chatMessages);
  };

  const handleExploreWithAi = async () => {
    if (!result || result.state !== "NOT_POSSIBLE") return;
    const name = guestName.trim() || "Walk-in Guest";
    const blocked = result.infeasible_dates?.join(", ") || `${checkIn} – ${checkOut}`;
    const splitState = "NOT_CHECKED";

    setChatMessages([]);
    setAiGuided(true);
    setTimeout(() => aiPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);

    const handoffLines = [
      "[HANDOFF]",
      `Guest="${name}"`,
      `preferred_category=${category}`,
      `check_in=${checkIn}`,
      `check_out=${checkOut}`,
      `deterministic_check=NOT_POSSIBLE`,
      `infeasible_dates=${blocked}`,
      `split_same_category=${splitState}`,
      `options.nearby_dates_pm1=${fallbackPrefs.nearbyDatesPm1}`,
      `options.different_category=${fallbackPrefs.differentCategory}`,
      `options.split_stay=${fallbackPrefs.splitStay}`,
      `options.mixed_category_split=${fallbackPrefs.allowMixedCategorySplit}`,
      "Rules: Only explore selected options. Prefer exact dates first, then minimal category delta (±1), then other categories, then date shift (±1).",
      "If mixed_category_split=true and split_stay=true, you may use find_split_stay_flex(preferred_category, same dates).",
      "Return the best actionable option as an action card.",
    ];

    await fireAiMessage(handoffLines.join("\n"), []);
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

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] gap-6 items-start">
        <div className="min-w-0 space-y-8">
          {/* ── Booking Form ─────────────────────────────────────────────────── */}
          <>

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
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
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
            <input type="text" className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-3 focus:border-accent focus:ring-1 focus:ring-accent outline-none font-serif" placeholder="Walk-in Guest" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
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
            <div>
              <h3 className={`text-xl font-serif font-bold ${isAvailable ? 'text-text' : 'text-occured'}`}>
                {result.state === "DIRECT_AVAILABLE" && "Room Available"}
                {result.state === "SHUFFLE_POSSIBLE" && "Room Available via Swap"}
                {result.state === "NOT_POSSIBLE" && "No Rooms Available"}
              </h3>
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
            <div className="mt-6 space-y-4">
              {showFallback && (
                <div className="bg-surface border border-border shadow-subtle">
                  <div className="px-6 py-4 border-b border-border bg-surface-2/60">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div>
                        <h4 className="font-serif font-bold text-lg text-text">Explore alternatives</h4>
                        <p className="text-[10px] text-text-muted mt-0.5 uppercase tracking-widest font-medium">
                          Choose what the AI is allowed to search
                        </p>
                      </div>
                      <button
                        className="text-[9px] font-bold text-text-muted uppercase tracking-widest hover:text-text border border-border px-3 py-2 bg-surface hover:bg-surface-2 shrink-0"
                        onClick={() => setShowFallback(false)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>

                  <div className="p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <label className="flex items-start gap-3 border border-border bg-surface-2/40 px-4 py-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                          checked={fallbackPrefs.nearbyDatesPm1}
                          onChange={(e) => setFallbackPrefs(p => ({ ...p, nearbyDatesPm1: e.target.checked }))}
                        />
                        <div className="leading-5">
                          <div className="font-bold uppercase tracking-widest text-[10px] text-text">Nearby dates</div>
                          <div className="text-text-muted">Search ±1 day (same stay length)</div>
                        </div>
                      </label>

                      <label className="flex items-start gap-3 border border-border bg-surface-2/40 px-4 py-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                          checked={fallbackPrefs.differentCategory}
                          onChange={(e) => setFallbackPrefs(p => ({ ...p, differentCategory: e.target.checked }))}
                        />
                        <div className="leading-5">
                          <div className="font-bold uppercase tracking-widest text-[10px] text-text">Different category</div>
                          <div className="text-text-muted">Any category, prefer ±1</div>
                        </div>
                      </label>

                      <label className="flex items-start gap-3 border border-border bg-surface-2/40 px-4 py-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                          checked={fallbackPrefs.splitStay}
                          onChange={(e) => setFallbackPrefs(p => ({ ...p, splitStay: e.target.checked }))}
                        />
                        <div className="leading-5">
                          <div className="font-bold uppercase tracking-widest text-[10px] text-text">Split stay</div>
                          <div className="text-text-muted">2–3 rooms if needed</div>
                        </div>
                      </label>

                      <label className={`flex items-start gap-3 border border-border bg-surface-2/40 px-4 py-3 ${!fallbackPrefs.splitStay ? "opacity-40" : ""}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                          checked={fallbackPrefs.allowMixedCategorySplit}
                          disabled={!fallbackPrefs.splitStay}
                          onChange={(e) => setFallbackPrefs(p => ({ ...p, allowMixedCategorySplit: e.target.checked }))}
                        />
                        <div className="leading-5">
                          <div className="font-bold uppercase tracking-widest text-[10px] text-text">Mixed-category split</div>
                          <div className="text-text-muted">Allow room type changes between segments</div>
                        </div>
                      </label>
                    </div>

                    <div className="mt-6 flex flex-wrap gap-3 border-t border-border/50 pt-5">
                    <button
                      className="bg-accent text-white font-bold uppercase tracking-widest text-[11px] px-6 py-3 hover:brightness-110 active:scale-95 disabled:opacity-40 transition-all"
                      onClick={handleExploreWithAi}
                      disabled={chatLoading || (!fallbackPrefs.nearbyDatesPm1 && !fallbackPrefs.differentCategory && !fallbackPrefs.splitStay)}
                    >
                      Explore selected with AI
                    </button>
                      {result.alternatives && result.alternatives.length > 0 && (
                        <button
                          className="bg-surface hover:bg-surface-2 border border-border text-text font-bold uppercase tracking-widest text-[11px] px-6 py-3 transition-colors"
                          onClick={() => setShowDeterministicAlternatives((v) => !v)}
                        >
                          {showDeterministicAlternatives ? "Hide deterministic suggestions" : "Show deterministic suggestions"}
                        </button>
                      )}
                    <button
                      className="bg-surface hover:bg-surface-2 border border-border text-text font-bold uppercase tracking-widest text-[11px] px-6 py-3 transition-colors"
                      onClick={() => { setChatMessages([]); setAiGuided(false); }}
                    >
                      Close AI panel
                    </button>
                  </div>

                    {showDeterministicAlternatives && result.alternatives && (
                      <AlternativesSection
                        alternatives={result.alternatives}
                        onSelect={alt => { setCheckIn(alt.check_in); setCheckOut(alt.check_out); setCategory(alt.category as RoomCategory); setResult(null); setSteps({ direct: "idle", shuffle: "idle" }); }}
                      />
                    )}
                </div>
                </div>
              )}
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

          </>

      {/* ── AI PANEL — always-on parallel revenue assistant ──────────────── */}
      <div ref={aiPanelRef} className="bg-surface border border-accent/30 shadow-subtle">
          {/* Handoff banner — only shown on NOT_POSSIBLE */}
          {aiGuided && result?.state === "NOT_POSSIBLE" && (
          <div className="bg-occuorange/5 border-b border-occuorange/20 px-6 py-3 flex items-center gap-3">
            <Sparkles className="w-3.5 h-3.5 text-occuorange shrink-0" />
            <p className="text-xs text-occuorange font-medium">
              No {category} rooms for <span className="font-bold">{checkIn} → {checkOut}</span> — AI is searching for the best alternative
            </p>
          </div>
          )}

          {/* Panel header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-2/60">
            <div>
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-accent" />
                <h3 className="font-serif font-bold text-lg text-text">AI Revenue Assistant</h3>
              </div>
              <p className="text-[10px] text-text-muted mt-0.5 uppercase tracking-widest">
                Gemini 2.5 · Live hotel intelligence
              </p>
            </div>
            {chatMessages.length > 0 && (
              <button
                onClick={() => { setChatMessages([]); setAiGuided(false); }}
                className="text-[9px] font-bold text-text-muted uppercase tracking-widest hover:text-text border border-border px-2 py-1 bg-surface hover:bg-surface-2"
              >
                Clear chat
              </button>
            )}
          </div>

          {/* Message thread */}
          <div className="h-[440px] overflow-y-auto p-6 space-y-4 flex flex-col">
            {chatMessages.length === 0 && !chatLoading && (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <Bot className="w-10 h-10 text-accent/25 mb-4" />
                <p className="text-sm font-serif font-bold text-text mb-1">Always on. Ask anything.</p>
                <p className="text-xs text-text-muted max-w-xs leading-relaxed">
                  Ask about room availability, tonight's occupancy, which category to push, upgrade opportunities, or anything about today's bookings.
                </p>
                <div className="mt-4 grid grid-cols-1 gap-2 w-full max-w-xs">
                  {["What's looking good to sell today?", "Any upgrades available tonight?", "How's our occupancy this week?"].map(q => (
                    <button
                      key={q}
                      onClick={() => { setChatInput(q); }}
                      className="text-left text-[10px] text-accent border border-accent/20 bg-accent/5 px-3 py-2 hover:bg-accent/10 transition-colors font-medium"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chatMessages.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
            {chatLoading && (
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-3.5 h-3.5 text-accent" />
                </div>
                <div className="bg-surface-2 border border-border px-4 py-3 text-sm text-text-muted flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin text-accent" /> Thinking…
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input bar */}
          <div className="border-t border-border p-4 flex gap-3">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendAiMessage(); } }}
              placeholder="Describe the guest's request…"
              className="flex-1 bg-surface-2 border border-border text-sm px-4 py-3 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              disabled={chatLoading}
            />
            <button
              onClick={handleSendAiMessage}
              disabled={chatLoading || !chatInput.trim()}
              className="bg-accent text-white px-5 py-3 font-bold hover:brightness-110 active:scale-95 disabled:opacity-40 transition-all flex items-center gap-2 text-sm"
            >
              {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
        </div>

      {/* Recent Bookings Sidebar */}
        <aside className="min-w-0">
          <div className="bg-surface border border-border shadow-subtle p-5 lg:sticky lg:top-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-serif font-bold text-lg text-text">Recent Bookings</h3>
              <button className="text-[10px] font-bold uppercase tracking-widest text-text-muted hover:text-text flex items-center gap-1 bg-surface-2 border border-border px-3 py-1.5 transition-colors" onClick={loadRecent} disabled={loadingRecent}>
                {loadingRecent ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : "Refresh"}
              </button>
            </div>
            {recentBookings.length === 0 ? (
              <div className="py-10 text-center text-text-muted font-medium text-sm border-t border-border/50">No recent bookings.</div>
            ) : (
              <div className="space-y-2">
                {recentBookings.map((b) => (
                  <div key={b.id} className="border border-border bg-surface-2/40 px-4 py-3 hover:bg-surface-2/70 transition-colors">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span className="font-serif font-medium text-sm text-text truncate">{b.guest_name}</span>
                      <span className={`shrink-0 inline-flex items-center px-2 py-0.5 border text-[9px] font-bold tracking-[0.1em] uppercase ${b.is_live ? 'bg-occugreen/10 text-occugreen border-occugreen/20' : 'bg-surface-2 text-text-muted border-border'}`}>
                        {b.is_live ? "IN-HOUSE" : "CONFIRMED"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-text-muted font-mono">
                      <span className="font-bold text-text">Room {b.room_id}</span>
                      <span className="text-border">·</span>
                      <span>{b.check_in}</span>
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5 font-mono">{b.id}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
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

function AlternativesSection({ alternatives, onSelect }: { alternatives: Alternative[]; onSelect: (alt: Alternative) => void }) {
  return (
    <div className="bg-surface border border-border p-5 mt-6">
      <h4 className="text-[10px] font-bold text-text uppercase tracking-[0.15em] mb-4">Fallback Suggestions</h4>
      <div className="space-y-3">
        {alternatives.map((alt, i) => (
          <div key={i} className="flex items-center justify-between p-4 border border-border bg-surface-2 hover:bg-border transition-colors">
            <div>
              <span className={`text-[9px] font-bold px-2 py-1 uppercase tracking-widest mr-3 border ${alt.type === "ALT_CATEGORY" ? 'bg-accent/10 border-accent/20 text-accent' : 'bg-surface border-border text-text-muted'}`}>{alt.type === "ALT_CATEGORY" ? alt.category : "Date Shift"}</span>
              <span className="text-sm font-serif text-text">{alt.message}</span>
            </div>
            <button className="text-[10px] font-bold uppercase tracking-widest text-text hover:text-accent flex items-center gap-1 border-b border-text hover:border-accent pb-0.5" onClick={() => onSelect(alt)}>Execute <ArrowRight className="w-3 h-3"/></button>
          </div>
        ))}
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
  const [guestName,   setGuestName]   = useState("");
  const [confirming,  setConfirming]  = useState(false);
  const [confirmed,   setConfirmed]   = useState<{ booking_id: string; room_id: string } | null>(null);
  const [confirmErr,  setConfirmErr]  = useState<string | null>(null);
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
        // Derive category from first segment's room_id prefix — or ask; for now use the form's active category
        const r = await confirmSplitStay({
          guest_name:   guestName.trim(),
          category:     d.category,
          discount_pct: d.discount_pct,
          segments:     d.segments,
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
          <span className="ml-auto font-mono font-normal normal-case text-text">₹{d.total_rate?.toLocaleString()} total</span>
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
                <span className="text-text font-medium">₹{seg.discounted_rate?.toLocaleString()}/night</span>
              </div>
              <span className="text-text-muted shrink-0">{seg.nights}n</span>
            </div>
          ))}
        </div>

        {/* Divider + savings callout */}
        {d.discount_pct > 0 && (
          <div className="px-3 py-2 border-t border-accent/20 text-[10px] text-accent font-medium">
            {d.discount_pct}% consecutive-stay discount saves ₹{
              Math.round(d.segments?.reduce((acc, s) => acc + s.nights * (s.base_rate - s.discounted_rate), 0) ?? 0)
                .toLocaleString()
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
      swap_plan?: unknown[];
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
            category:   d.request.category,
            check_in:   d.request.check_in,
            check_out:  d.request.check_out,
            guest_name: guestName.trim(),
          },
          room_id:   d.room_id,
          swap_plan: (d.swap_plan ?? []) as unknown[],
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
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Guest name"
                  value={guestName}
                  onChange={e => setGuestName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleConfirm()}
                  className="flex-1 bg-surface border border-border px-3 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
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
  if (isUser && msg.content.startsWith("[HANDOFF]")) return null;
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
