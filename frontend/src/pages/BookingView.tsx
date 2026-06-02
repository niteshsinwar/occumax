import { useEffect, useMemo, useRef, useState } from "react";
import { getHotelTodayStr } from "../utils/dateUtils";
import {
  bookingCheckAvailability,
  getBookingAiContext,
  sendBookingAiMessage,
} from "../api/client";
import type { RoomCategory, ShuffleResult } from "../types";
import { useToast } from "../components/shared/Toast";
import heroImage from "../assets/hero.png";
import { CalendarDays, Loader2, BedDouble, MessageCircle, Sparkles } from "lucide-react";
import { FloatingAiWidget, ActionCard, type ChatMsg } from "../components/shared/FloatingAiWidget";

const CUSTOMER_HISTORY_LIMIT = 20;
const FALLBACK_BOOKING_WINDOW_DAYS = 20;
const CATEGORIES: RoomCategory[] = ["ECONOMY", "STANDARD", "DELUXE", "SUITE"];

const categoryCopy: Record<string, { title: string; description: string; image: string }> = {
  ECONOMY: {
    title: "ECONOMY",
    description: "A calm, efficient stay with everything needed for a comfortable night.",
    image: "https://images.unsplash.com/photo-1566665797739-1674de7a421a?auto=format&fit=crop&w=900&q=80",
  },
  STANDARD: {
    title: "STANDARD",
    description: "Our most versatile guest room, ideal for business or short leisure stays.",
    image: "https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=900&q=80",
  },
  DELUXE: {
    title: "DELUXE",
    description: "More space, upgraded finishes, and a quieter stay for longer visits.",
    image: "https://images.unsplash.com/photo-1591088398332-8a7791972843?auto=format&fit=crop&w=900&q=80",
  },
  SUITE: {
    title: "SUITE",
    description: "A spacious suite experience with separate living space and premium comfort.",
    image: "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=900&q=80",
  },
};

const publicLabelForCategory = (category: string) => category.toUpperCase();
const trimHistory = (messages: ChatMsg[]) => messages.slice(-CUSTOMER_HISTORY_LIMIT);

function addIsoDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getErrorDetail(e: unknown): string | null {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg ?? JSON.stringify(item)).join("; ");
  return null;
}

const sanitizeCustomerText = (text: string) =>
  text
    .replace(/\bRoom\s+[A-Z]{1,4}\d{1,5}\b/g, "A matching room")
    .replace(/\b[A-Z]{1,4}\d{2,5}\b/g, "a matching room")
    .replace(/\bRevPAR\b/gi, "stay value")
    .replace(/\bpricing engine\b/gi, "current booking conditions")
    .replace(/\boccupancy\b/gi, "availability")
    .replace(/\bhard-blocked\b/gi, "unavailable")
    .replace(/\bsoft-blocked\b/gi, "reserved")
    .replace(/\bOTA\b/g, "travel partner")
    .trim();

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

export function BookingView() {
  const browserToday = getHotelTodayStr();
  
  const [category, setCategory] = useState<RoomCategory>("STANDARD");
  const [serverToday, setServerToday] = useState(browserToday);
  const [bookingWindowDays, setBookingWindowDays] = useState(FALLBACK_BOOKING_WINDOW_DAYS);
  const [checkIn, setCheckIn] = useState(browserToday);
  const [checkOut, setCheckOut] = useState(addIsoDays(browserToday, 3));
  const [guestName, setGuestName] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ShuffleResult | null>(null);
  
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [aiHasProactive, setAiHasProactive] = useState(false);
  const [hotelContext, setHotelContext] = useState<string | null>(null);
  
  const { show, Toasts } = useToast();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const aiRunIdRef = useRef(0);
  const today = serverToday;
  const maxDate = addIsoDays(serverToday, bookingWindowDays);
  const maxCheckInDate = addIsoDays(serverToday, Math.max(0, bookingWindowDays - 1));

  const nights = useMemo(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0;
    return Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000);
  }, [checkIn, checkOut]);

  const selectedCategory = categoryCopy[category] ?? categoryCopy.STANDARD;

  useEffect(() => {
    getBookingAiContext()
      .then((res) => {
        const data = res.data as { today?: string; booking_window?: number; context_text?: string };
        const nextToday = data.today || browserToday;
        const nextWindow = Number(data.booking_window || FALLBACK_BOOKING_WINDOW_DAYS);
        setHotelContext(data.context_text ?? null);
        setServerToday(nextToday);
        setBookingWindowDays(nextWindow);
        setCheckIn((prev) => (prev < nextToday ? nextToday : prev));
        setCheckOut((prev) => {
          const fallbackOut = addIsoDays(nextToday, Math.min(3, nextWindow));
          const latestOut = addIsoDays(nextToday, nextWindow);
          if (prev <= nextToday || prev === addIsoDays(browserToday, 3)) return fallbackOut;
          if (prev > latestOut) return latestOut;
          return prev;
        });
      })
      .catch(() => {});
  }, [browserToday]);

  const triggerAiHandoff = async (data: ShuffleResult, runId = aiRunIdRef.current) => {
    if (runId !== aiRunIdRef.current) return;
    const name = guestName.trim() || "Guest";
    const handoff = {
      type: "customer_booking_recovery_handoff",
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
    };
    await fireAiMessage(`[HANDOFF]\n${JSON.stringify(handoff, null, 2)}`, [], runId);
  };

  const handleSearch = async () => {
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      show("Choose valid stay dates.", "error");
      return;
    }
    
    aiRunIdRef.current += 1;
    const runId = aiRunIdRef.current;
    
    setChecking(true);
    setChatMessages([]);
    setAiHasProactive(false);
    setResult(null);
    
    try {
      const response = await bookingCheckAvailability({
        category,
        check_in: checkIn,
        check_out: checkOut,
        guest_name: guestName || "Guest",
      });
      const data = response.data as ShuffleResult;
      setResult(data);
      
      if (data.state === "NOT_POSSIBLE") {
        setChatOpen(true);
        setAiHasProactive(true);
        setChatMessages([{
          role: "assistant",
          content:
            "No inventory is available for your selected dates. Redirecting you to our stay assistant to help find alternate options.",
        }]);
        setTimeout(() => triggerAiHandoff(data, runId), 100);
      } else if (data.state === "DIRECT_AVAILABLE" || data.state === "SHUFFLE_POSSIBLE") {
        setAiHasProactive(true);
        setChatMessages([{
          role: "assistant",
          content: "Good news! The room you requested is available for your dates.",
          action_data: {
            type: "availability_result",
            data: {
              state: data.state,
              room_id: data.room_id,
              request: { category, check_in: checkIn, check_out: checkOut },
              swap_plan: data.swap_plan,
            }
          }
        }]);
      }
    } catch (e: unknown) {
      show(getErrorDetail(e) || "Availability check failed. Please try again.", "error");
    } finally {
      setChecking(false);
    }
  };

  const fireAiMessage = async (text: string, history: ChatMsg[], runId = aiRunIdRef.current) => {
    const userMsg: ChatMsg = { role: "user", content: text };
    const stateMsg = latestStructuredStateMessage(history);
    const updated = trimHistory([
      ...history,
      ...(stateMsg && !text.startsWith("[HANDOFF]") && !text.startsWith("[PREFS]") ? [stateMsg] : []),
      userMsg,
    ]);
    if (runId !== aiRunIdRef.current) return;
    setChatMessages(updated);
    setChatLoading(true);

    let ctx = hotelContext;
    try {
      const ctxRes = await getBookingAiContext();
      ctx = (ctxRes.data.context_text as string) ?? "";
      setHotelContext(ctx);
    } catch {
      ctx = ctx ?? "";
    }

    try {
      const res = await sendBookingAiMessage(
        updated.map(m => ({ role: m.role, content: m.content })),
        ctx ?? undefined,
      );
      if (runId !== aiRunIdRef.current) return;
      const aMsg: ChatMsg = {
        role: "assistant",
        content: sanitizeCustomerText(res.data.reply),
        action_data: res.data.action_data ?? null,
      };
      setChatMessages(prev => trimHistory([...prev, aMsg]));
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch {
      if (runId === aiRunIdRef.current) {
        show("The stay assistant could not respond. Please try again.", "error");
      }
    } finally {
      if (runId === aiRunIdRef.current) {
        setChatLoading(false);
      }
    }
  };

  const handleSendAiMessage = () => {
    if (!chatInput.trim() || chatLoading) return;
    const text = chatInput.trim();
    setChatInput("");
    fireAiMessage(text, chatMessages);
  };

  return (
    <div className="min-h-[calc(100vh-72px)] bg-[#f8f4ed]">
      <Toasts />
      
      <section className="relative min-h-[560px] overflow-hidden">
        <img
          src={heroImage}
          alt="Hotel guest room"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/35 to-transparent" />
        <div className="relative mx-auto flex min-h-[560px] max-w-7xl flex-col justify-end px-4 pb-8 sm:px-6 lg:px-8">
          <div className="max-w-2xl pb-8 text-white">
            <div className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-occuyellow">
              OptiHost
            </div>
            <h1 className="font-serif text-5xl font-black leading-tight sm:text-6xl">
              Book a smarter stay in New Jersey.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-white/85">
              Choose your dates, compare room styles, and let our stay assistant help find the best fit when plans are flexible.
            </p>
          </div>

          <div className="rounded-[10px] border border-white/25 bg-white p-4 shadow-[0_20px_70px_rgba(0,0,0,0.25)]">
            <div className="grid gap-3 md:grid-cols-[1.1fr_1fr_1fr_1fr_auto]">
              <label>
                Room style
                <select value={category} onChange={(event) => setCategory(event.target.value as RoomCategory)}>
                  {CATEGORIES.map((item) => (
                    <option key={item} value={item}>{publicLabelForCategory(item)}</option>
                  ))}
                </select>
              </label>
              <label>
                Check-in
                <input
                  type="date"
                  min={today}
                  max={maxCheckInDate}
                  value={checkIn}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCheckIn(next);
                    if (checkOut <= next) {
                      const nextOut = addIsoDays(next, 1);
                      setCheckOut(nextOut > maxDate ? maxDate : nextOut);
                    }
                  }}
                />
              </label>
              <label>
                Check-out
                <input type="date" min={addIsoDays(checkIn, 1)} max={maxDate} value={checkOut} onChange={(event) => setCheckOut(event.target.value)} />
              </label>
              <label>
                Guest name
                <input value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Your name" />
              </label>
              <button
                type="button"
                onClick={handleSearch}
                disabled={checking}
                className="mt-5 inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-occugreen px-5 text-xs font-bold uppercase tracking-[0.14em] text-white transition hover:brightness-110 disabled:opacity-50 md:mt-[22px]"
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
                Search
              </button>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section>
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-accent">Selected stay</div>
                <h2 className="mt-1 font-serif text-3xl font-bold text-text">{selectedCategory.title}</h2>
              </div>
              {nights > 0 && (
                <div className="rounded-full border border-border bg-white px-4 py-2 text-xs font-bold text-text-muted">
                  {nights} night{nights === 1 ? "" : "s"}
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-[10px] border border-border bg-white shadow-subtle">
              <img src={selectedCategory.image} alt={selectedCategory.title} className="h-72 w-full object-cover" />
              <div className="p-6">
                <p className="text-sm leading-7 text-text-muted">{selectedCategory.description}</p>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {["Flexible assistance", "Secure request", "Best-fit alternatives"].map((item) => (
                    <div key={item} className="rounded-md border border-border bg-surface-2/40 px-3 py-3 text-xs font-bold text-text">
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <aside className="space-y-5">
            <div className="rounded-[10px] border border-border bg-white p-5 shadow-subtle">
              <div className="flex items-center gap-2 text-sm font-bold text-text">
                <BedDouble className="h-4 w-4 text-accent" />
                Availability
              </div>
              <div className="mt-4">
                {result?.state === "NOT_POSSIBLE" ? (
                  <div className="rounded-md border border-orange/25 bg-orange-dim px-4 py-3 text-sm text-text space-y-2">
                    <p className="font-bold text-text">No inventory available</p>
                    <p className="text-text-muted leading-relaxed">
                      {chatLoading
                        ? "Redirecting to our stay assistant to help find alternate options…"
                        : "Our stay assistant can help find alternate options — open the chat in the lower-right corner."}
                    </p>
                  </div>
                ) : result?.state === "DIRECT_AVAILABLE" || result?.state === "SHUFFLE_POSSIBLE" ? (
                  <div className="mt-2">
                    <ActionCard 
                      data={{
                        type: "availability_result",
                        data: {
                          state: result.state,
                          room_id: result.room_id,
                          request: { category, check_in: checkIn, check_out: checkOut },
                          swap_plan: result.swap_plan,
                        }
                      }}
                      apiRole="booking"
                    />
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-surface-2/40 px-4 py-8 text-center text-sm text-text-muted">
                    Search your dates to see available stays.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-[10px] border border-border bg-white p-5 shadow-subtle">
              <button
                type="button"
                onClick={() => setChatOpen((value) => !value)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span>
                  <span className="flex items-center gap-2 text-sm font-bold text-text">
                    <MessageCircle className="h-4 w-4 text-accent" />
                    Stay assistant
                  </span>
                  <span className="mt-1 block text-xs text-text-muted">
                    Ask about dates, room styles, or flexible alternatives.
                  </span>
                </span>
                <Sparkles className="h-4 w-4 text-accent" />
              </button>
            </div>
          </aside>
        </div>
      </main>

      <FloatingAiWidget
        chatMessages={chatMessages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        chatLoading={chatLoading}
        chatEndRef={chatEndRef}
        onSend={handleSendAiMessage}
        aiOpen={chatOpen}
        setAiOpen={setChatOpen}
        hasProactive={aiHasProactive}
        setHasProactive={setAiHasProactive}
        apiRole="booking"
        title="Stay Assistant"
        subtitle="Find your perfect stay"
      />
    </div>
  );
}
