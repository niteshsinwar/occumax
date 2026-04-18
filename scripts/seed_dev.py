"""
Seed realistic hotel data into dev or local environment via API.

Usage:
  python3 scripts/seed_dev.py             # seeds Dev server
  python3 scripts/seed_dev.py local       # seeds localhost:8000

What it seeds:
  1. 21 rooms across 6 categories (Economy → Suite)
  2. 50+ forward bookings with realistic channel mix (OTA / Direct / Walk-in)
  3. 18 months of analytics history at realistic Pune market fill rates
"""
import sys
import json
import random
import requests
from datetime import date, timedelta
from typing import Optional

TARGET = sys.argv[1] if len(sys.argv) > 1 else "dev"
BASE = "http://localhost:8000/api" if TARGET == "local" else "https://161.118.164.30.nip.io/api"

TODAY = date.today()

print(f"Target : {TARGET}  ({BASE})")
print(f"Today  : {TODAY}\n")


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def post(path, body):
    try:
        r = requests.post(f"{BASE}{path}", json=body, timeout=15)
        if r.status_code not in (200, 201):
            print(f"  FAIL {path}: {r.status_code} {r.text[:200]}")
            return None
        return r.json()
    except Exception as e:
        print(f"  ERROR {path}: {e}")
        return None


def get(path):
    try:
        r = requests.get(f"{BASE}{path}", timeout=15)
        if r.status_code != 200:
            print(f"  FAIL GET {path}: {r.status_code}")
            return None
        return r.json()
    except Exception as e:
        print(f"  ERROR GET {path}: {e}")
        return None


def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


# ── 1. ROOMS ──────────────────────────────────────────────────────────────────

ROOMS = [
    # Floor 1 — Economy (budget travellers, price-sensitive)
    {"id": "101", "category": "ECONOMY",  "base_rate": 2200, "floor_number": 1},
    {"id": "102", "category": "ECONOMY",  "base_rate": 2200, "floor_number": 1},
    {"id": "103", "category": "ECONOMY",  "base_rate": 2400, "floor_number": 1},
    {"id": "104", "category": "ECONOMY",  "base_rate": 2400, "floor_number": 1},
    {"id": "105", "category": "ECONOMY",  "base_rate": 2600, "floor_number": 1},
    {"id": "106", "category": "ECONOMY",  "base_rate": 2600, "floor_number": 1},
    # Floor 2 — Standard (IT corridor weekday market)
    {"id": "201", "category": "STANDARD", "base_rate": 3800, "floor_number": 2},
    {"id": "202", "category": "STANDARD", "base_rate": 3800, "floor_number": 2},
    {"id": "203", "category": "STANDARD", "base_rate": 4000, "floor_number": 2},
    {"id": "204", "category": "STANDARD", "base_rate": 4000, "floor_number": 2},
    {"id": "205", "category": "STANDARD", "base_rate": 4200, "floor_number": 2},
    # Floor 3 — Deluxe (mid-market, OTA sweet spot)
    {"id": "301", "category": "DELUXE",   "base_rate": 5800, "floor_number": 3},
    {"id": "302", "category": "DELUXE",   "base_rate": 5800, "floor_number": 3},
    {"id": "303", "category": "DELUXE",   "base_rate": 6200, "floor_number": 3},
    {"id": "304", "category": "DELUXE",   "base_rate": 6200, "floor_number": 3},
    # Floor 4 — Premium (corporate accounts + GDS)
    {"id": "401", "category": "PREMIUM",  "base_rate": 8500, "floor_number": 4},
    {"id": "402", "category": "PREMIUM",  "base_rate": 9000, "floor_number": 4},
    {"id": "403", "category": "PREMIUM",  "base_rate": 9500, "floor_number": 4},
    # Floor 5 — Studio (extended stay, families)
    {"id": "501", "category": "STUDIO",   "base_rate": 7200, "floor_number": 5},
    {"id": "502", "category": "STUDIO",   "base_rate": 7800, "floor_number": 5},
    # Floor 6 — Suite (luxury, direct + Agoda international)
    {"id": "601", "category": "SUITE",    "base_rate": 15000, "floor_number": 6},
    {"id": "602", "category": "SUITE",    "base_rate": 18000, "floor_number": 6},
]


def seed_rooms():
    print("── 1. Rooms ──────────────────────────────────────────────────────")
    existing = {r["id"] for r in (get("/admin/rooms") or [])}
    created = skipped = 0
    for room in ROOMS:
        if room["id"] in existing:
            skipped += 1
            continue
        r = requests.post(f"{BASE}/admin/rooms", json=room, timeout=15)
        if r.status_code in (200, 201):
            print(f"  + {room['id']}  {room['category']:<10}  ₹{room['base_rate']:,}")
            created += 1
        else:
            print(f"  FAIL {room['id']}: {r.status_code} {r.text[:80]}")
    print(f"  {created} created, {skipped} already existed\n")


# ── 2. BOOKINGS ───────────────────────────────────────────────────────────────

# Channel mix for forward bookings — mirrors Pune market
_CHANNEL_MIX = [
    ("Direct",      None,           40),
    ("Walk-in",     None,           10),
    ("MakeMyTrip",  "MakeMyTrip",   20),
    ("Goibibo",     "Goibibo",      12),
    ("Agoda",       "Agoda",         8),
    ("Booking.com", "Booking.com",   5),
    ("Amadeus",     "Amadeus",       5),
]
_MIX_LABELS   = [x[0] for x in _CHANNEL_MIX]
_MIX_CHANNELS = [x[1] for x in _CHANNEL_MIX]
_MIX_WEIGHTS  = [x[2] for x in _CHANNEL_MIX]

rng = random.Random(42)


def _pick_channel() -> tuple[str, Optional[str]]:
    choice = rng.choices(range(len(_MIX_LABELS)), weights=_MIX_WEIGHTS, k=1)[0]
    label   = _MIX_LABELS[choice]
    partner = _MIX_CHANNELS[choice]
    if label == "Direct":
        return "DIRECT", None
    if label == "Walk-in":
        return "WALKIN", None
    return "OTA" if label not in ("Amadeus", "Sabre", "Travelport") else "GDS", partner


def book(category: str, check_in: str, check_out: str, guest: str) -> Optional[str]:
    r = requests.post(f"{BASE}/receptionist/check", json={
        "category": category, "check_in": check_in,
        "check_out": check_out, "guest_name": guest,
    }, timeout=15)

    if r.status_code != 200:
        print(f"  skip  {category} {check_in}→{check_out}: HTTP {r.status_code}")
        return None

    result = r.json()
    state = result.get("state", "")
    if "INFEASIBLE" in state or "UNAVAILABLE" in state or "NOT_POSSIBLE" in state:
        print(f"  unavail {category} {check_in}→{check_out}: {state}")
        return None

    room_id = result.get("room_id")
    if not room_id:
        print(f"  no room  {category} {check_in}→{check_out}: {state}")
        return None

    ch, partner = _pick_channel()
    confirmed = post("/receptionist/confirm", {
        "request": {
            "category": category, "check_in": check_in,
            "check_out": check_out, "guest_name": guest,
            "channel": ch, "channel_partner": partner,
        },
        "room_id": room_id,
        "swap_plan": result.get("swap_plan"),
    })
    if confirmed:
        bid = confirmed.get("booking_id") or confirmed.get("id", "?")
        src = partner or ch
        print(f"  + {guest:<24} {category:<10} {check_in}→{check_out}  {src:<14} [{bid}]")
        return bid
    return None


# Forward bookings — realistic Pune hotel demand pattern
BOOKINGS = [
    # Economy — high-volume budget segment (mostly OTA / walk-in)
    ("ECONOMY",  d(1),  d(3),  "Priya Sharma"),
    ("ECONOMY",  d(1),  d(4),  "Carlos Mendes"),
    ("ECONOMY",  d(4),  d(7),  "Ravi Kumar"),
    ("ECONOMY",  d(5),  d(8),  "Yuki Tanaka"),
    ("ECONOMY",  d(8),  d(11), "Amara Okafor"),
    ("ECONOMY",  d(8),  d(10), "Lee Hyun"),
    ("ECONOMY",  d(11), d(14), "Rahul Gupta"),
    ("ECONOMY",  d(12), d(15), "Fatima Al-Rashid"),
    ("ECONOMY",  d(2),  d(5),  "Nina Petrov"),
    ("ECONOMY",  d(9),  d(12), "Tariq Hussain"),
    ("ECONOMY",  d(15), d(18), "James Obi"),
    ("ECONOMY",  d(16), d(19), "Sofia Rossi"),
    ("ECONOMY",  d(3),  d(6),  "Anjali Singh"),
    ("ECONOMY",  d(13), d(16), "Mohammed Al-Farsi"),
    # Standard — IT corridor weekday corporate
    ("STANDARD", d(1),  d(4),  "Emma Johansson"),
    ("STANDARD", d(1),  d(3),  "Kwame Asante"),
    ("STANDARD", d(4),  d(7),  "Valentina Cruz"),
    ("STANDARD", d(5),  d(8),  "Arjun Nair"),
    ("STANDARD", d(8),  d(12), "Olga Morozova"),
    ("STANDARD", d(9),  d(13), "Ben Harrington"),
    ("STANDARD", d(2),  d(5),  "Isabel Ferreira"),
    ("STANDARD", d(13), d(16), "Akira Yamamoto"),
    ("STANDARD", d(14), d(17), "Samuel Oduya"),
    ("STANDARD", d(17), d(19), "Deepak Menon"),
    ("STANDARD", d(6),  d(9),  "Chloe Martin"),
    # Deluxe — OTA sweet spot, leisure + corporate mix
    ("DELUXE",   d(1),  d(5),  "Alexandra Popescu"),
    ("DELUXE",   d(1),  d(3),  "Robert Chen"),
    ("DELUXE",   d(4),  d(8),  "Fatou Diallo"),
    ("DELUXE",   d(6),  d(9),  "Nadia Karim"),
    ("DELUXE",   d(9),  d(13), "Lars Eriksson"),
    ("DELUXE",   d(10), d(14), "Zara Ahmed"),
    ("DELUXE",   d(2),  d(4),  "Tomasz Kowalski"),
    ("DELUXE",   d(14), d(17), "David Okonkwo"),
    ("DELUXE",   d(15), d(18), "Mei Lin Wang"),
    ("DELUXE",   d(7),  d(11), "Pablo Rodriguez"),
    # Premium — corporate + GDS accounts
    ("PREMIUM",  d(1),  d(5),  "Victoria Blackwood"),
    ("PREMIUM",  d(2),  d(6),  "Alexander Volkov"),
    ("PREMIUM",  d(6),  d(10), "Isabelle Dupont"),
    ("PREMIUM",  d(7),  d(11), "Hiroshi Tanaka"),
    ("PREMIUM",  d(11), d(15), "Elena Sokolova"),
    ("PREMIUM",  d(12), d(16), "Marcus Williams"),
    ("PREMIUM",  d(16), d(19), "Ananya Krishnan"),
    # Studio — extended stay, families
    ("STUDIO",   d(1),  d(6),  "Liam O'Brien"),
    ("STUDIO",   d(2),  d(5),  "Camille Lefebvre"),
    ("STUDIO",   d(6),  d(10), "Aiko Suzuki"),
    ("STUDIO",   d(7),  d(11), "Ethan Goldstein"),
    ("STUDIO",   d(11), d(15), "Priya Iyer"),
    ("STUDIO",   d(12), d(16), "Björn Lindqvist"),
    ("STUDIO",   d(16), d(19), "Sun Wei"),
    # Suite — luxury, mostly direct + Agoda international
    ("SUITE",    d(2),  d(6),  "Lord Ashworth"),
    ("SUITE",    d(3),  d(7),  "Contessa Romano"),
    ("SUITE",    d(8),  d(12), "Sheikh Al-Maktoum"),
    ("SUITE",    d(9),  d(13), "Lady Pemberton"),
    ("SUITE",    d(13), d(17), "Baron Von Richter"),
    ("SUITE",    d(14), d(18), "Prince Nikolai"),
]


def seed_bookings():
    print("── 2. Forward bookings ───────────────────────────────────────────")
    ok = fail = 0
    for category, ci, co, guest in BOOKINGS:
        bid = book(category, ci, co, guest)
        if bid:
            ok += 1
        else:
            fail += 1
    print(f"\n  {ok} confirmed, {fail} skipped/unavailable\n")


# ── 3. ANALYTICS HISTORY ─────────────────────────────────────────────────────

def seed_analytics():
    print("── 3. Analytics history ──────────────────────────────────────────")

    # Year 1 — 18 months back to 1 month back (strong history for AI/pace/forecast)
    r1 = post("/admin/seed-analytics-history", {
        "start": (TODAY - timedelta(days=540)).isoformat(),
        "end":   (TODAY - timedelta(days=31)).isoformat(),
        "fill_pct": 71,
    })
    if r1:
        print(f"  Y-1 window: {json.dumps(r1)[:120]}")

    # Recent 30 days — slightly lower fill (shoulder season signal)
    r2 = post("/admin/seed-analytics-history", {
        "start": (TODAY - timedelta(days=30)).isoformat(),
        "end":   (TODAY - timedelta(days=1)).isoformat(),
        "fill_pct": 58,
    })
    if r2:
        print(f"  Recent 30d: {json.dumps(r2)[:120]}")
    print()


# ── MAIN ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    seed_rooms()
    seed_bookings()
    seed_analytics()
    print("Done.")
