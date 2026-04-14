export type BlockType = "HARD" | "SOFT" | "EMPTY";
export type RoomCategory = "DELUXE" | "SUITE" | "STUDIO" | "STANDARD" | "PREMIUM" | "ECONOMY";


export interface HeatmapCell {
  slot_id: string;
  room_id: string;
  date: string;
  block_type: BlockType;
  category: RoomCategory;
  current_rate: number;
  booking_id: string | null;
}

export interface HeatmapRow {
  room_id: string;
  category: RoomCategory;
  base_rate: number;
  cells: HeatmapCell[];
}

export interface HeatmapSummary {
  total_orphan_nights: number;
  estimated_lost_revenue: number;
}

export interface HeatmapResponse {
  dates: string[];
  rows: HeatmapRow[];
  summary: HeatmapSummary;
}



export interface SwapStep {
  from_room: string;
  to_room: string;
  booking_id: string;
  dates: string[];
}


export interface ComparisonCell {
  date: string;
  before_type: BlockType;
  before_booking: string | null;
  after_type: BlockType;
  after_booking: string | null;
}

export interface ComparisonRow {
  room_id: string;
  role: "TARGET" | "RECEIVES";
  booking_id_received: string | null;
  cells: ComparisonCell[];
}

export interface ComparisonTable {
  dates: string[];
  rows: ComparisonRow[];
  summary?: string[];
}

export interface Alternative {
  type: "ADJACENT_DATE" | "ALT_CATEGORY";
  category: string;
  room_id: string;
  check_in: string;
  check_out: string;
  message: string;
}

export interface ShuffleResult {
  state: "DIRECT_AVAILABLE" | "SHUFFLE_POSSIBLE" | "NOT_POSSIBLE";
  room_id: string | null;
  message: string;
  swap_plan: SwapStep[] | null;
  comparison: ComparisonTable | null;
  infeasible_dates: string[] | null;
  alternatives: Alternative[] | null;
}

// ── Phase 2: split-stay types ──────────────────────────────────────────────

export interface SplitSegment {
  room_id:         string;
  floor:           number;
  check_in:        string;
  check_out:       string;
  nights:          number;
  base_rate:       number;
  discounted_rate: number;
}

export interface SplitStayResult {
  state:        "SPLIT_POSSIBLE" | "NOT_POSSIBLE";
  segments:     SplitSegment[];
  discount_pct: number;
  total_nights: number;
  total_rate:   number;
  message:      string;
}

export interface SplitStayConfirm {
  guest_name:   string;
  category:     RoomCategory;
  discount_pct: number;
  segments:     SplitSegment[];
}

export interface GapInfo {
  room_id: string;
  category: string;
  date_range: string;
  gap_length: number;
  shuffle_plan: SwapStep[];
}

export interface OptimiseResult {
  gaps_found: number;
  shuffle_count: number;
  converged: boolean;   // gaps exist but structurally unfixable
  fully_clean: boolean; // zero orphan gaps in current state
  swap_plan: SwapStep[];
  gaps: GapInfo[];
}

// ── Pricing AI types ───────────────────────────────────────────────────────

export interface PricingRecommendation {
  category: string;
  date: string;
  current_rate: number;
  suggested_rate: number;
  change_pct: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  occupancy_pct: number;
  otb: number;
  floor_rate: number;
}

export interface PricingAnalyseResponse {
  hotel_name: string;
  analysis_date: string;
  recommendations: PricingRecommendation[];
  summary: string;
}

export interface PricingCommitItem {
  category: string;
  date: string;
  new_rate: number;
}

export interface PricingCommitResult {
  updated: number;
  skipped: number;
}

// ── Analytics (forecast + pace) ─────────────────────────────────────────────

export interface OccupancyPoint {
  date: string;
  total_rooms: number;
  occupied_rooms_actual: number | null;
  occupied_rooms_on_books: number | null;
  expected_occ_pct: number;
  expected_occ_low_pct: number;
  expected_occ_high_pct: number;
}

export interface OccupancySeries {
  category: RoomCategory | null;
  points: OccupancyPoint[];
}

export interface OccupancyForecastResponse {
  start: string;
  end: string;
  as_of: string;
  series: OccupancySeries[];
}

export interface PacePoint {
  lead_days: number;
  on_books_rooms: number;
  on_books_occ_pct: number;
  expected_on_books_rooms: number;
  expected_on_books_occ_pct: number;
}

export interface PaceSeries {
  category: RoomCategory | null;
  stay_start: string;
  stay_end: string;
  points: PacePoint[];
}

export interface PaceResponse {
  as_of: string;
  series: PaceSeries[];
}

