"""
Seed realistic hotel data into dev environment via API only (Tier 2 agent).
Run: python3 scripts/seed_dev.py
"""
import requests
import json
from datetime import date, timedelta
from typing import Optional

BASE = "http://161.118.164.30/api"

TODAY = date(2026, 4, 18)


def post(path, body):
    r = requests.post(f"{BASE}{path}", json=body, timeout=10)
    if r.status_code not in (200, 201):
        print(f"  FAIL {path}: {r.status_code} {r.text[:200]}")
        return None
    return r.json()


def get(path):
    r = requests.get(f"{BASE}{path}", timeout=10)
    if r.status_code != 200:
        print(f"  FAIL GET {path}: {r.status_code}")
        return None
    return r.json()


# ── 1. ROOMS ──────────────────────────────────────────────────────────────────

ROOMS = [
    # Floor 1 — Economy
    {"id": "101", "category": "ECONOMY", "base_rate": 62, "floor_number": 1},
    {"id": "102", "category": "ECONOMY", "base_rate": 62, "floor_number": 1},
    {"id": "103", "category": "ECONOMY", "base_rate": 65, "floor_number": 1},
    {"id": "104", "category": "ECONOMY", "base_rate": 65, "floor_number": 1},
    {"id": "105", "category": "ECONOMY", "base_rate": 68, "floor_number": 1},
    {"id": "106", "category": "ECONOMY", "base_rate": 68, "floor_number": 1},
    # Floor 2 — Standard
    {"id": "201", "category": "STANDARD", "base_rate": 88, "floor_number": 2},
    {"id": "202", "category": "STANDARD", "base_rate": 88, "floor_number": 2},
    {"id": "203", "category": "STANDARD", "base_rate": 92, "floor_number": 2},
    {"id": "204", "category": "STANDARD", "base_rate": 92, "floor_number": 2},
    {"id": "205", "category": "STANDARD", "base_rate": 96, "floor_number": 2},
    # Floor 3 — Deluxe
    {"id": "301", "category": "DELUXE", "base_rate": 135, "floor_number": 3},
    {"id": "302", "category": "DELUXE", "base_rate": 135, "floor_number": 3},
    {"id": "303", "category": "DELUXE", "base_rate": 145, "floor_number": 3},
    {"id": "304", "category": "DELUXE", "base_rate": 145, "floor_number": 3},
    # Floor 4 — Premium
    {"id": "401", "category": "PREMIUM", "base_rate": 185, "floor_number": 4},
    {"id": "402", "category": "PREMIUM", "base_rate": 195, "floor_number": 4},
    {"id": "403", "category": "PREMIUM", "base_rate": 205, "floor_number": 4},
    # Floor 5 — Studio
    {"id": "501", "category": "STUDIO", "base_rate": 158, "floor_number": 5},
    {"id": "502", "category": "STUDIO", "base_rate": 165, "floor_number": 5},
    # Floor 6 — Suite
    {"id": "601", "category": "SUITE", "base_rate": 310, "floor_number": 6},
    {"id": "602", "category": "SUITE", "base_rate": 340, "floor_number": 6},
]


def seed_rooms():
    print("\n── Creating rooms ──")
    existing = {r["id"] for r in (get("/admin/rooms") or [])}
    created = 0
    for room in ROOMS:
        if room["id"] in existing:
            print(f"  skip {room['id']} (exists)")
            continue
        r = requests.post(f"{BASE}/admin/rooms", json=room, timeout=10)
        if r.status_code in (200, 201):
            print(f"  + {room['id']} {room['category']} ${room['base_rate']}")
            created += 1
        else:
            print(f"  FAIL {room['id']}: {r.status_code} {r.text[:100]}")
    print(f"  {created} rooms created, {len(existing)} already existed")


# ── 2. BOOKINGS ───────────────────────────────────────────────────────────────

def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


def book(category: str, check_in: str, check_out: str, guest: str) -> Optional[str]:
    """Check availability then confirm. Returns booking id or None."""
    r = requests.post(f"{BASE}/receptionist/check", json={
        "category": category,
        "check_in": check_in,
        "check_out": check_out,
        "guest_name": guest,
    }, timeout=10)

    if r.status_code == 400:
        print(f"  skip {category} {check_in}→{check_out}: {r.json().get('detail','')}")
        return None
    if r.status_code != 200:
        print(f"  FAIL check {category}: {r.status_code} {r.text[:100]}")
        return None

    result = r.json()
    state = result.get("state", "")
    if "INFEASIBLE" in state or "UNAVAILABLE" in state:
        print(f"  unavail {category} {check_in}→{check_out}: {state}")
        return None

    room_id = result.get("room_id")
    swap_plan = result.get("swap_plan")

    if not room_id:
        print(f"  no room_id for {category} {check_in}→{check_out}: {state}")
        return None

    confirmed = post("/receptionist/confirm", {
        "request": {
            "category": category,
            "check_in": check_in,
            "check_out": check_out,
            "guest_name": guest,
        },
        "room_id": room_id,
        "swap_plan": swap_plan,
    })
    if confirmed:
        bid = confirmed.get("id") or confirmed.get("booking_id", "?")
        print(f"  + {guest:<22} {category:<10} {check_in} → {check_out}  room {room_id}  [{bid}]")
        return bid
    return None


BOOKINGS = [
    # ── Economy block (6 rooms, days 1-19 to stay within 20-day window) ──
    ("ECONOMY", d(1),  d(3),  "Priya Sharma"),
    ("ECONOMY", d(1),  d(4),  "Carlos Mendes"),
    ("ECONOMY", d(4),  d(7),  "Priya Sharma"),
    ("ECONOMY", d(5),  d(8),  "Yuki Tanaka"),
    ("ECONOMY", d(8),  d(11), "Amara Okafor"),
    ("ECONOMY", d(8),  d(10), "Lee Hyun"),
    ("ECONOMY", d(12), d(15), "Fatima Al-Rashid"),
    ("ECONOMY", d(11), d(14), "Rahul Gupta"),
    ("ECONOMY", d(16), d(19), "Sofia Rossi"),
    ("ECONOMY", d(15), d(18), "James Obi"),
    ("ECONOMY", d(2),  d(5),  "Nina Petrov"),
    ("ECONOMY", d(9),  d(12), "Tariq Hussain"),
    # ── Standard block (5 rooms) ────────────────────────────────────────
    ("STANDARD", d(1),  d(4),  "Emma Johansson"),
    ("STANDARD", d(1),  d(3),  "Kwame Asante"),
    ("STANDARD", d(5),  d(8),  "Emma Johansson"),
    ("STANDARD", d(4),  d(7),  "Valentina Cruz"),
    ("STANDARD", d(9),  d(13), "Arjun Nair"),
    ("STANDARD", d(8),  d(12), "Olga Morozova"),
    ("STANDARD", d(14), d(17), "Ben Harrington"),
    ("STANDARD", d(13), d(16), "Akira Yamamoto"),
    ("STANDARD", d(2),  d(5),  "Isabel Ferreira"),
    ("STANDARD", d(17), d(19), "Samuel Oduya"),
    # ── Deluxe block (4 rooms) ──────────────────────────────────────────
    ("DELUXE", d(1),  d(5),  "Alexandra Popescu"),
    ("DELUXE", d(1),  d(3),  "Robert Chen"),
    ("DELUXE", d(6),  d(9),  "Alexandra Popescu"),
    ("DELUXE", d(4),  d(8),  "Fatou Diallo"),
    ("DELUXE", d(10), d(14), "Lars Eriksson"),
    ("DELUXE", d(9),  d(13), "Nadia Karim"),
    ("DELUXE", d(15), d(18), "David Okonkwo"),
    ("DELUXE", d(14), d(17), "Zara Ahmed"),
    ("DELUXE", d(2),  d(4),  "Tomasz Kowalski"),
    # ── Premium block (3 rooms) ─────────────────────────────────────────
    ("PREMIUM", d(1),  d(5),  "Victoria Blackwood"),
    ("PREMIUM", d(2),  d(6),  "Alexander Volkov"),
    ("PREMIUM", d(6),  d(10), "Victoria Blackwood"),
    ("PREMIUM", d(7),  d(11), "Isabelle Dupont"),
    ("PREMIUM", d(11), d(15), "Hiroshi Tanaka"),
    ("PREMIUM", d(12), d(16), "Elena Sokolova"),
    ("PREMIUM", d(16), d(19), "Marcus Williams"),
    # ── Studio block (2 rooms) ──────────────────────────────────────────
    ("STUDIO", d(1),  d(6),  "Liam O'Brien"),
    ("STUDIO", d(2),  d(5),  "Camille Lefebvre"),
    ("STUDIO", d(7),  d(11), "Liam O'Brien"),
    ("STUDIO", d(6),  d(10), "Aiko Suzuki"),
    ("STUDIO", d(12), d(16), "Ethan Goldstein"),
    ("STUDIO", d(11), d(15), "Priya Iyer"),
    ("STUDIO", d(16), d(19), "Björn Lindqvist"),
    # ── Suite block (2 rooms) ───────────────────────────────────────────
    ("SUITE", d(2),  d(6),  "Lord Ashworth"),
    ("SUITE", d(3),  d(7),  "Contessa Romano"),
    ("SUITE", d(8),  d(12), "Sheikh Al-Maktoum"),
    ("SUITE", d(9),  d(13), "Lady Pemberton"),
    ("SUITE", d(14), d(18), "Prince Nikolai"),
    ("SUITE", d(13), d(17), "Baron Von Richter"),
]


def seed_bookings():
    print("\n── Creating bookings ──")
    ok = 0
    fail = 0
    for category, ci, co, guest in BOOKINGS:
        bid = book(category, ci, co, guest)
        if bid:
            ok += 1
        else:
            fail += 1
    print(f"\n  {ok} bookings confirmed, {fail} failed/unavailable")


# ── 3. ANALYTICS HISTORY ─────────────────────────────────────────────────────

def seed_analytics():
    print("\n── Seeding analytics history ──")
    result = post("/admin/seed-analytics-history", {
        "start": (TODAY - timedelta(days=90)).isoformat(),
        "end": (TODAY - timedelta(days=1)).isoformat(),
        "fill_pct": 68,
    })
    if result:
        print(f"  Analytics history seeded: {json.dumps(result)[:120]}")


# ── MAIN ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"Seeding dev DB via {BASE}")
    print(f"Reference date: {TODAY}")
    seed_rooms()
    seed_bookings()
    seed_analytics()
    print("\nDone.")
