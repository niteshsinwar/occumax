import axios from "axios";

const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

export const api = axios.create({ baseURL: BASE });


// Dashboard
export const getHeatmap = () => api.get("/dashboard/heatmap");
export const getOccupancyForecast = (params: { start: string; end: string; as_of: string }) =>
  api.get("/analytics/occupancy-forecast", { params });
export const dashboardOptimisePreview = (body: { start: string; end: string; categories: string[] }) =>
  api.post("/dashboard/optimise-preview", body);
export const dashboardSandwichPlaybook = (body: { start: string; end: string; categories: string[]; discount_pct?: number | null }) =>
  api.post("/dashboard/sandwich-playbook", body);
export const dashboardCommitShuffle = (swapPlan: any[]) => api.post("/dashboard/commit-shuffle", { swap_plan: swapPlan });
export const dashboardOptimiseKNightPreview = (body: { start: string; end: string; categories: string[]; target_nights: number }) =>
  api.post("/dashboard/optimise-k-night-preview", body);
export const dashboardScorecard = (body: {
  start: string;
  end: string;
  categories: string[];
  k_nights?: number[];
  swap_plan?: any[] | null;
}) => api.post("/dashboard/scorecard", body);

export const dashboardRecoveryEstimate = (body: {
  start: string;
  end: string;
  categories: string[];
  swap_plan?: any[] | null;
}) => api.post("/dashboard/recovery-estimate", body);
export const getPace = (params: { start: string; end: string; as_of: string; max_lead_days?: number }) =>
  api.get("/analytics/pace", { params });
export const getEventInsights = (params: { start: string; end: string; as_of: string; category?: string | null }) =>
  api.get("/analytics/event-insights", { params });

// Manager
export const fireOptimise = () => api.post("/manager/optimise");
export const commitPlan = (swapPlan: any[]) => api.post("/manager/commit", { swap_plan: swapPlan });

// Receptionist
export const checkAvailability = (body: {
  category: string;
  check_in: string;
  check_out: string;
  guest_name?: string;
}) => api.post("/receptionist/check", body);

export const confirmBooking = (body: {
  request: { category: string; check_in: string; check_out: string; guest_name?: string; channel?: string; channel_partner?: string | null };
  room_id: string;
  swap_plan?: unknown[];
}) => api.post("/receptionist/confirm", body);

export const findSplitStay = (body: {
  category: string; check_in: string; check_out: string; guest_name?: string;
}) => api.post("/receptionist/find-split", body);

export const findSplitStayFlex = (body: {
  category: string; check_in: string; check_out: string; guest_name?: string;
}) => api.post("/receptionist/find-split-flex", body);

export const listBookings = () => api.get("/receptionist/bookings");

export const confirmSplitStay = (body: {
  guest_name:      string;
  category:        string;
  discount_pct:    number;
  channel?:        string;
  channel_partner?: string | null;
  segments: {
    room_id: string; floor: number;
    check_in: string; check_out: string;
    nights: number; base_rate: number; discounted_rate: number;
  }[];
}) => api.post("/receptionist/confirm-split", body);

export const channelAllocate = (body: {
  booking_source: string;
  category: string;
  check_in: string;
  check_out: string;
  room_count: number;
}) => api.post("/manager/channel-allocate", body);

// AI Agent
export const getAiContext = () => api.get("/ai/context");
export const sendAiMessage = (messages: { role: string; content: string }[], hotelContext?: string) =>
  api.post("/ai/chat", { messages, hotel_context: hotelContext ?? null });

// Pricing AI
export const analysePricing = () => api.get("/manager/pricing/analyse");
export const commitPricing  = (items: { category: string; date: string; new_rate: number }[]) =>
  api.post("/manager/pricing/commit", { items });

export const getRevenueSummary = (as_of?: string) =>
  api.get("/analytics/revenue-summary", as_of ? { params: { as_of } } : undefined);

export const getChannelPerformance = (params?: { as_of?: string; window_days?: number; start?: string; end?: string; categories?: string[] }) =>
  api.get("/analytics/channel-performance", params ? { params } : undefined);

export const getChannelRecommendations = () =>
  api.get("/manager/channel-recommend");

// Slot patch (shared across Dashboard, Manager, Admin)
export const patchSlot = (slot_id: string, body: { block_type: "EMPTY" | "HARD"; reason?: string }) =>
  api.patch(`/admin/slots/${slot_id}`, body);

// Admin
export const adminListRooms     = () => api.get("/admin/rooms");
export const adminAddRoom       = (body: { id: string; category: string; base_rate: number; floor_number: number }) =>
  api.post("/admin/rooms", body);
export const adminUpdateRoom    = (id: string, body: { category?: string; base_rate?: number; floor_number?: number; is_active?: boolean }) =>
  api.patch(`/admin/rooms/${id}`, body);
export const adminDeleteRoom    = (id: string) => api.delete(`/admin/rooms/${id}`);
export const adminListCategories = () => api.get("/admin/categories");
export const getChannelPartners = () => api.get("/admin/channel-partners");
export const adminSeedAnalyticsHistory = (body: { start: string; end: string; fill_pct: number }) =>
  api.post("/admin/seed-analytics-history", body);

export const adminListBookings = (params?: { start?: string; end?: string }) =>
  api.get("/admin/bookings", params ? { params } : undefined);
export const adminUpdateBooking = (bookingId: string, body: { guest_name?: string; room_id?: string; check_in?: string; check_out?: string; category?: string }) =>
  api.patch(`/admin/bookings/${bookingId}`, body);
export const adminDeleteBooking = (bookingId: string) =>
  api.delete(`/admin/bookings/${bookingId}`);
