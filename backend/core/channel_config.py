"""
Single source of truth for booking channel partners and commission rates.

All code that needs OTA/GDS partner names or commission rates must import
from here — never define these lists independently elsewhere.
"""

from __future__ import annotations

OTA_PARTNERS: list[dict] = [
    {"name": "MakeMyTrip",  "commission_pct": 18},
    {"name": "Goibibo",     "commission_pct": 18},
    {"name": "Agoda",       "commission_pct": 18},
    {"name": "Booking.com", "commission_pct": 18},
    {"name": "Expedia",     "commission_pct": 18},
]

GDS_PARTNERS: list[dict] = [
    {"name": "Amadeus",     "commission_pct": 10},
    {"name": "Sabre",       "commission_pct": 10},
    {"name": "Travelport",  "commission_pct": 10},
]

DIRECT_SOURCES: list[dict] = [
    {"name": "Direct",  "commission_pct": 0},
    {"name": "Walk-in", "commission_pct": 0},
]

# Pre-built sets for O(1) membership checks
OTA_PARTNER_NAMES: frozenset[str] = frozenset(p["name"] for p in OTA_PARTNERS)
GDS_PARTNER_NAMES: frozenset[str] = frozenset(p["name"] for p in GDS_PARTNERS)

# Ordered name lists (used by seed_history weighted sampling)
OTA_PARTNER_NAMES_LIST: list[str] = [p["name"] for p in OTA_PARTNERS]
GDS_PARTNER_NAMES_LIST: list[str] = [p["name"] for p in GDS_PARTNERS]

# Commission lookup by partner name
COMMISSION_BY_PARTNER: dict[str, float] = {
    **{p["name"]: p["commission_pct"] / 100 for p in OTA_PARTNERS},
    **{p["name"]: p["commission_pct"] / 100 for p in GDS_PARTNERS},
    **{p["name"]: 0.0 for p in DIRECT_SOURCES},
}
