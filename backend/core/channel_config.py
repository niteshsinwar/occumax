"""
Single source of truth for booking channel partners and commission rates.

All code that needs OTA partner names or commission rates must import
from here — never define these lists independently elsewhere.
"""

from __future__ import annotations

OTA_PARTNERS: list[dict] = [
    {"name": "Expedia",     "commission_pct": 18},
    {"name": "Hotels.com",  "commission_pct": 18},
    {"name": "Booking.com", "commission_pct": 18},
    {"name": "Priceline",   "commission_pct": 18},
    {"name": "Travelocity", "commission_pct": 18},
    {"name": "Orbitz",      "commission_pct": 18},
]

GDS_PARTNERS: list[dict] = []

DIRECT_SOURCES: list[dict] = [
    {"name": "Direct Hotel Front Desk", "commission_pct": 0},
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
