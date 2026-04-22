import { useState, useEffect, useCallback } from "react";
import {
  adminListRooms, adminAddRoom, adminUpdateRoom, adminDeleteRoom,
  adminListCategories,
  adminSeedAnalyticsHistory,
  getHeatmap, patchSlot,
  adminListBookings, adminUpdateBooking, adminDeleteBooking,
} from "../api/client";
import { useToast } from "../components/shared/Toast";
import { HeatmapGrid } from "../components/Heatmap/HeatmapGrid";
import type { HeatmapResponse, AdminBookingRow } from "../types";
import { Building2, Calendar as CalendarIcon, RefreshCw, Plus, Trash2, Edit2, Check, X, Sparkles, Settings } from "lucide-react";

const KNOWN_CATEGORIES = ["STANDARD", "STUDIO", "DELUXE", "SUITE", "PREMIUM", "ECONOMY"];

type Tab = "rooms" | "calendar" | "bookings";

interface RoomRow {
  id: string; category: string; base_rate: number; floor_number: number; is_active: boolean;
  stats: { total_slots: number; empty_nights: number; booked_nights: number; occupancy_pct: number };
}
interface CategoryRow { name: string; room_count: number; avg_base_rate: number; min_rate: number; max_rate: number; }

function getErrorDetail(e: unknown): string | null {
  const maybe = e as { response?: { data?: { detail?: unknown } } };
  const detail = maybe?.response?.data?.detail;
  return typeof detail === "string" ? detail : null;
}

export function AdminPanel() {
  const [tab, setTab] = useState<Tab>("rooms");
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookings, setBookings] = useState<AdminBookingRow[]>([]);
  const [bookingStart, setBookingStart] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [bookingEnd, setBookingEnd] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return d.toISOString().slice(0, 10);
  });
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [editBooking, setEditBooking] = useState<{ guestName: string; roomId: string; checkIn: string; checkOut: string; category: string }>({
    guestName: "",
    roomId: "",
    checkIn: "",
    checkOut: "",
    category: "STANDARD",
  });
  const { show, Toasts } = useToast();

  const [newRoom, setNewRoom] = useState({ id: "", category: "STANDARD", base_rate: 3000, floor_number: 1 });
  const [editingRoom, setEditingRoom] = useState<string | null>(null);
  const [editRate, setEditRate] = useState("");
  const [seedLoading, setSeedLoading] = useState(false);
  const [seedStart, setSeedStart] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [seedEnd, setSeedEnd] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return d.toISOString().slice(0, 10);
  });
  const [seedFillPct, setSeedFillPct] = useState<number>(35);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c, h] = await Promise.all([adminListRooms(), adminListCategories(), getHeatmap()]);
      setRooms(r.data); setCategories(c.data); setHeatmap(h.data);
    } catch {
      show("Failed to load admin data", "error");
    } finally {
      setLoading(false);
    }
  }, [show]);

  useEffect(() => { load(); }, [load]);

  const loadBookings = useCallback(async () => {
    if (!bookingStart || !bookingEnd) { show("Select a start and end date", "error"); return; }
    if (bookingEnd <= bookingStart) { show("End date must be after start date", "error"); return; }
    setBookingsLoading(true);
    try {
      const res = await adminListBookings({ start: bookingStart, end: bookingEnd });
      setBookings(res.data ?? []);
    } catch (e: unknown) {
      show(getErrorDetail(e) || "Failed to load bookings", "error");
    } finally {
      setBookingsLoading(false);
    }
  }, [bookingStart, bookingEnd, show]);

  const handleAddRoom = async () => {
    if (!newRoom.id.trim()) { show("Room ID is required", "error"); return; }
    if (newRoom.base_rate <= 0) { show("Base rate must be > 0", "error"); return; }
    try {
      await adminAddRoom(newRoom);
      show(`Room ${newRoom.id} added`, "success");
      setNewRoom({ id: "", category: "STANDARD", base_rate: 3000, floor_number: 1 });
      load();
    } catch (e: unknown) {
      show(getErrorDetail(e) || "Failed to add room", "error");
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm(`Deactivate room ${id}? It will be hidden from the calendar.`)) return;
    try {
      await adminDeleteRoom(id);
      show(`Room ${id} deactivated`, "info");
      load();
    } catch { show("Failed to deactivate", "error"); }
  };

  const handleSaveRate = async (id: string) => {
    const rate = parseFloat(editRate);
    if (isNaN(rate) || rate <= 0) { show("Enter a valid rate", "error"); return; }
    try {
      await adminUpdateRoom(id, { base_rate: rate });
      show(`Room ${id} base rate updated to ₹${rate.toLocaleString("en-IN")}`, "success");
      setEditingRoom(null);
      load();
    } catch { show("Failed to update rate", "error"); }
  };

  const handleSeedAnalytics = async () => {
    if (!seedStart || !seedEnd) { show("Select a start and end date", "error"); return; }
    if (seedEnd <= seedStart) { show("End date must be after start date", "error"); return; }
    if (!confirm(`Generate demo historical bookings/slots for ${seedStart} → ${seedEnd} at ~${seedFillPct}% occupancy? This will insert DEMO_ANALYTICS rows (1y/2y back).`)) return;
    setSeedLoading(true);
    try {
      const res = await adminSeedAnalyticsHistory({ start: seedStart, end: seedEnd, fill_pct: seedFillPct });
      const d = res.data ?? {};
      show(
        `Seeded analytics history: deleted ${d.deleted_bookings ?? 0} bookings (${d.cleared_slots ?? 0} nights), created ${d.inserted_bookings ?? 0} bookings (${d.updated_slots ?? 0} nights).`,
        "success"
      );
    } catch (e: unknown) {
      show(getErrorDetail(e) || "Failed to seed analytics history", "error");
    } finally {
      setSeedLoading(false);
    }
  };

  const startEditBooking = (b: AdminBookingRow) => {
    setEditingBookingId(b.id);
    setEditBooking({
      guestName: b.guest_name ?? "",
      roomId: b.room_id ?? "",
      checkIn: b.check_in ?? "",
      checkOut: b.check_out ?? "",
      category: String(b.category ?? "STANDARD"),
    });
  };

  const cancelEditBooking = () => {
    setEditingBookingId(null);
  };

  const saveBooking = async (bookingId: string) => {
    if (!editBooking.checkIn || !editBooking.checkOut) { show("Check-in/out is required", "error"); return; }
    if (editBooking.checkOut <= editBooking.checkIn) { show("Check-out must be after check-in", "error"); return; }
    if (!editBooking.roomId.trim()) { show("Room ID is required", "error"); return; }

    try {
      await adminUpdateBooking(bookingId, {
        guest_name: editBooking.guestName,
        room_id: editBooking.roomId.trim(),
        check_in: editBooking.checkIn,
        check_out: editBooking.checkOut,
        category: editBooking.category,
      });
      show(`Booking ${bookingId} updated`, "success");
      setEditingBookingId(null);
      loadBookings();
      load();
    } catch (e: unknown) {
      show(getErrorDetail(e) || "Failed to update booking", "error");
    }
  };

  const deleteBooking = async (bookingId: string) => {
    if (!confirm(`Delete booking ${bookingId}? This will free its slots.`)) return;
    try {
      await adminDeleteBooking(bookingId);
      show(`Booking ${bookingId} deleted`, "info");
      setEditingBookingId(null);
      loadBookings();
      load();
    } catch (e: unknown) {
      show(getErrorDetail(e) || "Failed to delete booking", "error");
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      <Toasts />

      {/* Header */}
      <div className="mb-8 pb-4 border-b border-border/50">
        <div className="flex items-start justify-between gap-6">
          <h1 className="text-3xl font-serif font-bold text-text">Hotel Settings</h1>
          <div className="hidden sm:block text-[9px] font-bold text-text-muted uppercase tracking-[0.2em] bg-surface-2 px-4 py-1.5 rounded-sm border border-border shadow-subtle relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-text" />
            Admin controls
          </div>
        </div>
        <p className="text-xs uppercase tracking-wider text-text-muted mt-1 font-medium">
          Add rooms, set base rates, and load historical data for better forecasting
        </p>

        <div className="mt-4 flex flex-col sm:flex-row sm:items-end sm:justify-start gap-3">
          <div className="flex items-end gap-2 bg-surface border border-border px-3 py-2 shadow-subtle">
            <div className="space-y-1">
              <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Historical data range</div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <input
                  type="date"
                  className="bg-surface-2 border border-border text-[11px] px-2 py-1.5 font-semibold text-text"
                  value={seedStart}
                  onChange={(e) => setSeedStart(e.target.value)}
                />
                <span className="hidden sm:inline text-[10px] font-bold text-text-muted uppercase tracking-widest">to</span>
                <input
                  type="date"
                  className="bg-surface-2 border border-border text-[11px] px-2 py-1.5 font-semibold text-text"
                  value={seedEnd}
                  onChange={(e) => setSeedEnd(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="flex items-end gap-2 bg-surface border border-border px-3 py-2 shadow-subtle">
            <div className="space-y-1 w-[220px]">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Occupancy</div>
                <div className="text-[10px] font-bold text-text uppercase tracking-widest tabular-nums">{seedFillPct}%</div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={seedFillPct}
                onChange={(e) => setSeedFillPct(Number(e.target.value))}
                className="w-full accent-accent"
              />
            </div>
          </div>
          <button
            className="bg-surface border border-accent/30 shadow-subtle text-text text-xs uppercase tracking-widest font-semibold hover:bg-surface-2 active:scale-95 transition-all px-6 py-3 rounded-sm flex items-center gap-2"
            onClick={handleSeedAnalytics}
            disabled={seedLoading}
            title="Load past booking history so the AI forecast and analytics have real data to work with"
          >
            <Sparkles className={`w-3.5 h-3.5 ${seedLoading ? "animate-pulse text-accent" : "text-accent"}`} />
            Load History for AI
          </button>
          <button className="bg-surface border border-accent/30 shadow-subtle text-text text-xs uppercase tracking-widest font-semibold hover:bg-surface-2 active:scale-95 transition-all px-6 py-3 rounded-sm flex items-center gap-2" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-accent' : 'text-accent'}`} /> Refresh Data
          </button>
        </div>
      </div>

      {/* Category summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
        {categories.map((c) => (
          <div key={c.name} className="bg-surface border border-border rounded-sm p-4 shadow-subtle relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-1 h-full bg-accent/50" />
            <div className="text-[9px] font-bold text-text-muted uppercase tracking-[0.15em]">{c.name}</div>
            <div className="text-2xl font-serif font-bold text-text mt-1 flex items-baseline gap-1">
              {c.room_count} <span className="text-[10px] font-medium text-text-muted uppercase tracking-widest">rooms</span>
            </div>
            <div className="text-[10px] font-semibold text-text-muted mt-2 bg-surface-2 px-2 py-1 inline-block border border-border">
              ₹{c.min_rate} – ₹{c.max_rate}
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-border pb-px">
        {(["rooms", "calendar", "bookings"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-2 px-6 py-3 font-semibold text-xs tracking-widest uppercase transition-colors border-b-[3px] ${tab === t ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text hover:bg-surface-2/50'}`}
          >
            {t === "rooms" ? <Building2 className="w-4 h-4" /> : t === "calendar" ? <CalendarIcon className="w-4 h-4" /> : <Settings className="w-4 h-4" />}
            {t === "rooms" ? "Room Inventory" : t === "calendar" ? "System Calendar" : "View Booking Data"}
          </button>
        ))}
      </div>

      {/* ── ROOMS TAB ── */}
      {tab === "rooms" && (
        <div className="space-y-6">
          {/* Add Room form */}
          <div className="bg-surface border border-border rounded-sm p-6 shadow-subtle">
            <h3 className="font-serif font-bold text-lg text-text flex items-center gap-2 mb-6 border-b border-border pb-4"><Plus className="w-4 h-4 text-accent" /> Register New Room</h3>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
              <div className="space-y-1.5">
                <label>Room ID</label>
                <input className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-2.5 focus:border-accent focus:ring-1 focus:ring-accent outline-none" placeholder="e.g. 201" value={newRoom.id} onChange={(e) => setNewRoom({ ...newRoom, id: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <label>Category</label>
                <select className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-2.5 focus:border-accent focus:ring-1 focus:ring-accent outline-none" value={newRoom.category} onChange={(e) => setNewRoom({ ...newRoom, category: e.target.value })}>
                  {KNOWN_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label>Base Rate (₹)</label>
                <input className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-2.5 focus:border-accent focus:ring-1 focus:ring-accent outline-none" type="number" value={newRoom.base_rate} onChange={(e) => setNewRoom({ ...newRoom, base_rate: Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <label>Floor</label>
                <input className="w-full bg-surface-2 border border-border rounded-sm text-sm px-3 py-2.5 focus:border-accent focus:ring-1 focus:ring-accent outline-none" type="number" value={newRoom.floor_number} min={1} onChange={(e) => setNewRoom({ ...newRoom, floor_number: Number(e.target.value) })} />
              </div>
              <button className="bg-text text-surface text-xs tracking-widest uppercase font-semibold hover:bg-text/90 active:scale-95 transition-all shadow-sm w-full py-3 rounded-sm" onClick={handleAddRoom}>
                Build Room
              </button>
            </div>
          </div>

          {/* Rooms table */}
          <div className="bg-surface border border-border rounded-sm shadow-subtle overflow-hidden">
            <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-surface-2/30">
              <h3 className="font-serif font-bold text-lg text-text">Inventory Tracking</h3>
              <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted bg-surface-2 px-3 py-1 border border-border">{rooms.filter(r => r.is_active).length} Active Rooms</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-[10px] font-bold text-text-muted uppercase tracking-[0.1em] bg-surface-2/50 border-b border-border">
                  <tr>
                    <th className="px-6 py-4">Room</th>
                    <th className="px-6 py-4">Category</th>
                    <th className="px-6 py-4">Floor</th>
                    <th className="px-6 py-4">Base Rate</th>
                    <th className="px-6 py-4">30D Occupancy</th>
                    <th className="px-6 py-4 text-center">Status</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rooms.map((r) => (
                    <tr key={r.id} className={`hover:bg-surface-2/30 transition-colors ${!r.is_active ? 'opacity-50 grayscale' : ''}`}>
                      <td className="px-6 py-4 font-mono font-bold text-text">{r.id}</td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-1.5 py-0.5 border border-border text-[9px] font-bold uppercase tracking-[0.1em] bg-surface-2 text-text-muted">
                          {r.category}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-medium text-text-muted">{r.floor_number}</td>
                      <td className="px-6 py-4">
                        {editingRoom === r.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="number" className="w-24 bg-surface border border-accent rounded-sm text-xs px-2 py-1.5 text-text font-mono font-medium outline-none focus:ring-1 focus:ring-accent"
                              value={editRate} onChange={(e) => setEditRate(e.target.value)} autoFocus
                            />
                            <button className="p-1.5 bg-occugreen/10 text-occugreen border border-occugreen/30 hover:bg-occugreen/20 transition-colors" onClick={() => handleSaveRate(r.id)}><Check className="w-3.5 h-3.5" /></button>
                            <button className="p-1.5 bg-occured/10 text-occured border border-occured/30 hover:bg-occured/20 transition-colors" onClick={() => setEditingRoom(null)}><X className="w-3.5 h-3.5" /></button>
                          </div>
                        ) : (
                          <span
                            className="cursor-pointer font-mono font-medium text-text flex items-center gap-2 hover:text-accent transition-colors group"
                            title="Click to edit base rate"
                            onClick={() => { setEditingRoom(r.id); setEditRate(String(r.base_rate)); }}
                          >
                            ₹{r.base_rate.toLocaleString("en-IN")} <Edit2 className="w-3 h-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-16 h-1 bg-border overflow-hidden">
                            <div className={`h-full ${r.stats.occupancy_pct > 70 ? 'bg-occugreen' : r.stats.occupancy_pct > 30 ? 'bg-occuorange' : 'bg-text-muted'}`} style={{ width: `${r.stats.occupancy_pct}%` }} />
                          </div>
                          <span className="text-xs font-mono font-medium text-text-muted">{r.stats.occupancy_pct}%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] border ${r.is_active ? "bg-occugreen/10 text-occugreen border-occugreen/30" : "bg-occured/10 text-occured border-occured/30"}`}>
                          {r.is_active ? "ACTIVE" : "OFF-LINE"}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {r.is_active && (
                          <button
                            className="p-1.5 text-text-muted hover:text-occured hover:bg-occured/10 transition-all border border-transparent hover:border-occured/30"
                            title="Deactivate Room"
                            onClick={() => handleDeactivate(r.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── CALENDAR TAB ── */}
      {tab === "calendar" && (
        <div className="bg-surface border border-border rounded-sm p-6 shadow-subtle min-h-[400px]">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h3 className="font-serif font-bold text-lg text-text">30-Day Master Calendar</h3>
              <p className="text-xs text-text-muted mt-1 tracking-wide">Select any cell to implicitly force or unblock availability routing.</p>
            </div>
            <div className="flex items-center gap-4 text-[9px] font-bold text-text-muted uppercase tracking-widest bg-surface-2 px-4 py-2 border border-border">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-occugreen shadow-sm"/> Available</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-occublue shadow-sm"/> Booked</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-text shadow-sm" /> Hard Block</span>
            </div>
          </div>
          <div className="border border-border/50 bg-surface-2/20 p-2">
            {heatmap ? (
              <HeatmapGrid
                dates={heatmap.dates}
                rows={heatmap.rows}
                compact
                onCellClick={async (cell) => {
                  if (cell.block === "SOFT") { show("Cannot edit a booked slot", "error"); return; }
                  const next = cell.block === "HARD" ? "EMPTY" : "HARD";
                  const label = next === "HARD" ? "Hard block" : "Free up";
                  if (!confirm(`${label} Room ${cell.room} on ${cell.date}?`)) return;
                  try {
                    await patchSlot(cell.id, { block_type: next, reason: "Admin manual edit" });
                    show(`Slot ${next === "HARD" ? "hard-blocked" : "freed"}`, "success");
                    load();
                  } catch (e: unknown) { show(getErrorDetail(e) || "Failed to update slot", "error"); }
                }}
              />
            ) : (
              <div className="py-24 flex flex-col items-center justify-center text-text-muted font-medium text-sm">
                 <RefreshCw className="w-6 h-6 animate-spin mb-3 text-border" />
                 Loading calendar layout...
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── BOOKINGS TAB ── */}
      {tab === "bookings" && (
        <div className="space-y-6">
          <div className="bg-surface border border-border rounded-sm p-6 shadow-subtle">
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
              <div>
                <h3 className="font-serif font-bold text-lg text-text">View Booking Data</h3>
                <p className="text-xs text-text-muted mt-1 tracking-wide">Filter by stay date range. Edit or delete bookings (slots will be re-synced).</p>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                <div className="space-y-1">
                  <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Start</div>
                  <input
                    type="date"
                    className="bg-surface-2 border border-border text-[11px] px-2 py-1.5 font-semibold text-text"
                    value={bookingStart}
                    onChange={(e) => setBookingStart(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest">End</div>
                  <input
                    type="date"
                    className="bg-surface-2 border border-border text-[11px] px-2 py-1.5 font-semibold text-text"
                    value={bookingEnd}
                    onChange={(e) => setBookingEnd(e.target.value)}
                  />
                </div>
                <button
                  className="bg-surface border border-accent/30 shadow-subtle text-text text-xs uppercase tracking-widest font-semibold hover:bg-surface-2 active:scale-95 transition-all px-6 py-3 rounded-sm flex items-center gap-2"
                  onClick={loadBookings}
                  disabled={bookingsLoading}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${bookingsLoading ? "animate-spin text-accent" : "text-accent"}`} />
                  Load
                </button>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-sm shadow-subtle overflow-hidden">
            <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-surface-2/30">
              <h3 className="font-serif font-bold text-lg text-text">Bookings</h3>
              <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted bg-surface-2 px-3 py-1 border border-border">
                {bookings.length} rows
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-[10px] font-bold text-text-muted uppercase tracking-[0.1em] bg-surface-2/50 border-b border-border">
                  <tr>
                    <th className="px-6 py-4">Booking</th>
                    <th className="px-6 py-4">Guest</th>
                    <th className="px-6 py-4">Category</th>
                    <th className="px-6 py-4">Room</th>
                    <th className="px-6 py-4">Check-in</th>
                    <th className="px-6 py-4">Check-out</th>
                    <th className="px-6 py-4">Group</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bookings.map((b) => {
                    const isEditing = editingBookingId === b.id;
                    return (
                      <tr key={b.id} className="hover:bg-surface-2/30 transition-colors">
                        <td className="px-6 py-4 font-mono font-bold text-text">{b.id}</td>
                        <td className="px-6 py-4">
                          {isEditing ? (
                            <input
                              className="w-56 bg-surface border border-accent rounded-sm text-xs px-2 py-1.5 text-text font-medium outline-none focus:ring-1 focus:ring-accent"
                              value={editBooking.guestName}
                              onChange={(e) => setEditBooking({ ...editBooking, guestName: e.target.value })}
                            />
                          ) : (
                            <span className="font-medium text-text">{b.guest_name}</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {isEditing ? (
                            <select
                              className="bg-surface border border-accent rounded-sm text-xs px-2 py-1.5 text-text font-semibold outline-none focus:ring-1 focus:ring-accent"
                              value={editBooking.category}
                              onChange={(e) => setEditBooking({ ...editBooking, category: e.target.value })}
                            >
                              {KNOWN_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 border border-border text-[9px] font-bold uppercase tracking-[0.1em] bg-surface-2 text-text-muted">
                              {String(b.category)}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {isEditing ? (
                            <input
                              className="w-24 bg-surface border border-accent rounded-sm text-xs px-2 py-1.5 text-text font-mono font-medium outline-none focus:ring-1 focus:ring-accent"
                              value={editBooking.roomId}
                              onChange={(e) => setEditBooking({ ...editBooking, roomId: e.target.value })}
                            />
                          ) : (
                            <span className="font-mono font-medium text-text-muted">{b.room_id ?? "-"}</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {isEditing ? (
                            <input
                              type="date"
                              className="bg-surface border border-accent rounded-sm text-xs px-2 py-1.5 text-text font-semibold outline-none focus:ring-1 focus:ring-accent"
                              value={editBooking.checkIn}
                              onChange={(e) => setEditBooking({ ...editBooking, checkIn: e.target.value })}
                            />
                          ) : (
                            <span className="font-mono text-text-muted">{b.check_in}</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {isEditing ? (
                            <input
                              type="date"
                              className="bg-surface border border-accent rounded-sm text-xs px-2 py-1.5 text-text font-semibold outline-none focus:ring-1 focus:ring-accent"
                              value={editBooking.checkOut}
                              onChange={(e) => setEditBooking({ ...editBooking, checkOut: e.target.value })}
                            />
                          ) : (
                            <span className="font-mono text-text-muted">{b.check_out}</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-[10px] font-mono text-text-muted">
                            {b.stay_group_id ? `${b.stay_group_id}${b.segment_index != null ? ` · seg ${b.segment_index}` : ""}` : "-"}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          {isEditing ? (
                            <div className="inline-flex items-center gap-2">
                              <button className="p-1.5 bg-occugreen/10 text-occugreen border border-occugreen/30 hover:bg-occugreen/20 transition-colors" onClick={() => saveBooking(b.id)} title="Save">
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button className="p-1.5 bg-occured/10 text-occured border border-occured/30 hover:bg-occured/20 transition-colors" onClick={cancelEditBooking} title="Cancel">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-2">
                              <button
                                className="p-1.5 text-text-muted hover:text-accent hover:bg-accent/10 transition-all border border-transparent hover:border-accent/30"
                                title="Edit booking"
                                onClick={() => startEditBooking(b)}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                className="p-1.5 text-text-muted hover:text-occured hover:bg-occured/10 transition-all border border-transparent hover:border-occured/30"
                                title="Delete booking"
                                onClick={() => deleteBooking(b.id)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!bookingsLoading && bookings.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-sm text-text-muted font-medium">
                        No bookings found for the selected date range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
