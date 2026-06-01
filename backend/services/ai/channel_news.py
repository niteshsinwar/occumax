"""
Mock channel partner news/campaign data — US market (New Jersey / NYC-metro).

Simulates data pulled from:
  - OTA partner portals (Expedia Partner Central, Hotels.com Partner Hub, Booking.com Extranet Pulse)
  - News aggregators (TechCrunch, WSJ, Skift, Phocuswire)

Each partner entry:
  news_score         : news-derived float -1.0 → +1.0
  news_label         : POSITIVE / NEUTRAL / NEGATIVE / CRITICAL
  signal             : PREFER / NEUTRAL / PENALIZE / AVOID
  recent_events      : date-aware OTA news/campaign items that drove the signal
  signal_reason      : plain-English allocation guidance for this partner
"""

from __future__ import annotations

import copy
from datetime import date

CHANNEL_NEWS: dict[str, dict] = {
    "Expedia": {
        "news_score": -0.45,
        "news_label": "NEGATIVE",
        "signal": "PENALIZE",
        "recent_events": [
            {
                "date": "2026-05-08",
                "start_date": "2026-05-08",
                "end_date": "2026-05-09",
                "type": "partner_connectivity",
                "headline": "Expedia reports one-day partner API downtime",
                "impact": "HIGH",
                "source": "Expedia Partner Central status feed",
                "detail": (
                    "Inventory and rate updates may be delayed during the downtime window. "
                    "Avoid incremental slot pushes until partner connectivity stabilises."
                ),
            },
            {
                "date": "2026-05-09",
                "start_date": "2026-05-09",
                "end_date": "2026-05-15",
                "type": "recovery_watch",
                "headline": "Expedia recovery window begins after API downtime",
                "impact": "MEDIUM",
                "source": "Expedia Partner Central status feed",
                "detail": (
                    "Connectivity is expected to improve after June 9, but monitor conversion "
                    "before restoring normal allocation volume."
                ),
            },
        ],
        "signal_reason": (
            "API downtime is active on June 8 and creates partner-health risk. Deprioritize Expedia "
            "for incremental pushes this run; use Booking.com, Priceline, or Travelocity when their "
            "campaign windows overlap the gap dates."
        ),
    },

    "Hotels.com": {
        "news_score": -0.28,
        "news_label": "NEGATIVE",
        "signal": "PENALIZE",
        "recent_events": [
            {
                "date": "2026-05-05",
                "start_date": "2026-05-05",
                "end_date": "2026-05-20",
                "type": "positive_campaign",
                "headline": "Hotels.com loyalty campaign active in US market",
                "impact": "MEDIUM",
                "source": "Hotels.com Partner Hub",
                "detail": "Loyalty promotion targets repeat US hotel shoppers through June 20.",
            },
            {
                "date": "2026-05-08",
                "start_date": "2026-05-08",
                "end_date": "2026-05-09",
                "type": "infrastructure_watch",
                "headline": "Hotels.com monitoring shared Expedia Group connectivity",
                "impact": "MEDIUM",
                "source": "Hotels.com Partner Hub",
                "detail": (
                    "Hotels.com campaign remains active, but shared Expedia Group infrastructure "
                    "warrants watch status during the Expedia downtime window."
                ),
            },
        ],
        "signal_reason": (
            "Loyalty campaign is active through June 20, but shared Expedia Group connectivity makes "
            "Hotels.com a watch partner while Expedia downtime is active."
        ),
    },

    "Booking.com": {
        "news_score": 0.58,
        "news_label": "POSITIVE",
        "signal": "PREFER",
        "recent_events": [
            {
                "date": "2026-05-08",
                "start_date": "2026-05-08",
                "end_date": "2026-05-15",
                "type": "positive_campaign",
                "headline": "Booking.com Northeast Weekend Escape campaign starts",
                "impact": "HIGH",
                "source": "Booking.com Extranet Pulse",
                "detail": (
                    "Campaign targets US leisure shoppers for weekend and short-stay hotel bookings "
                    "from June 8 through June 15."
                ),
            },
        ],
        "signal_reason": (
            "Booking.com campaign is active June 8-15 and news impact is positive. Prioritize when "
            "recommended stay dates overlap that campaign and historical channel data supports it."
        ),
    },

    "Priceline": {
        "news_score": 0.32,
        "news_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "recent_events": [
            {
                "date": "2026-05-10",
                "start_date": "2026-05-10",
                "end_date": "2026-05-13",
                "type": "positive_campaign",
                "headline": "Priceline weekday opaque-rate promotion starts",
                "impact": "MEDIUM",
                "source": "Priceline Partner Network",
                "detail": (
                    "Opaque-rate promotion is active June 10-13 and is best suited for "
                    "price-sensitive Standard/Economy gaps."
                ),
            },
            {
                "date": "2026-05-01",
                "start_date": "2026-05-01",
                "end_date": "2026-05-31",
                "type": "positive_update",
                "headline": "Priceline price-match messaging active in June",
                "impact": "MEDIUM",
                "source": "Skift / Priceline Blog",
                "detail": (
                    "June price-match messaging supports conversion for price-sensitive travelers. "
                    "Use where net yield still clears the hotel's floor."
                ),
            },
            {
                "date": "2026-05-03",
                "start_date": "2026-05-03",
                "end_date": "2026-05-31",
                "type": "minor_concern",
                "headline": "Priceline opaque model carries ADR compression risk",
                "impact": "LOW",
                "source": "Hotel Management Magazine",
                "detail": "Industry pushback on deep discounting but booking volumes remain healthy.",
            },
        ],
        "signal_reason": (
            "Strong for Standard/Economy weekday gaps where ADR compression is acceptable. "
            "New AI price-match feature boosting consumer confidence. Good secondary choice when "
            "Expedia is penalized — especially for low-occ weekday fills."
        ),
    },

    "Travelocity": {
        "news_score": 0.24,
        "news_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "recent_events": [
            {
                "date": "2026-05-13",
                "start_date": "2026-05-13",
                "end_date": "2026-05-16",
                "type": "positive_campaign",
                "headline": "Travelocity US package leisure campaign starts",
                "impact": "MEDIUM",
                "source": "Travelocity Partner Update",
                "detail": (
                    "Package leisure promotion is active June 13-16. Use as a supplemental OTA "
                    "when gap dates overlap the campaign window."
                ),
            },
        ],
        "signal_reason": (
            "Travelocity has a June 13-16 package campaign. Use as a secondary OTA when the date "
            "overlap is strong and keep volume moderate because news impact is neutral."
        ),
    },

    "Orbitz": {
        "news_score": 0.18,
        "news_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "recent_events": [
            {
                "date": "2026-05-14",
                "start_date": "2026-05-14",
                "end_date": "2026-05-21",
                "type": "positive_update",
                "headline": "Orbitz Rewards-led US leisure campaign starts",
                "impact": "MEDIUM",
                "source": "Orbitz Partner Update",
                "detail": (
                    "Rewards-led shoppers are targeted for short hotel stays from June 14-21."
                ),
            },
            {
                "date": "2026-05-01",
                "start_date": "2026-05-01",
                "end_date": "2026-05-31",
                "type": "minor_concern",
                "headline": "Orbitz mobile conversion trails larger OTA partners",
                "impact": "LOW",
                "source": "Internal OTA pulse",
                "detail": "Search volume is healthy, but mobile booking conversion remains secondary.",
            },
        ],
        "signal_reason": (
            "Orbitz rewards campaign starts June 14. Use as a tertiary OTA for overlapping short-stay "
            "gaps when higher-performing partners are already covered."
        ),
    },
}


def _event_active(event: dict, today: date) -> bool:
    try:
        start = date.fromisoformat(str(event.get("start_date") or event.get("date")))
        end = date.fromisoformat(str(event.get("end_date") or event.get("date")))
    except (TypeError, ValueError):
        return False
    return start <= today <= end


def get_partner_news(partner_name: str, today: date | None = None) -> dict:
    """
    Return date-aware OTA news/campaign data for a partner. Case-insensitive lookup.
    Falls back to a neutral default for unknown partners.
    """
    key = partner_name.strip()
    data = CHANNEL_NEWS.get(key) or next(
        (v for k, v in CHANNEL_NEWS.items() if k.lower() == key.lower()), None
    )
    if data is None:
        return {
            "partner": key,
            "news_score": 0.0,
            "news_label": "NEUTRAL",
            "signal": "NEUTRAL",
            "recent_events": [],
            "signal_reason": "No OTA news/campaign data available for this partner.",
        }

    payload = {"partner": key, **copy.deepcopy(data)}
    if today is None:
        return payload

    events = [e for e in payload.get("recent_events", []) if isinstance(e, dict)]
    active_events = [e for e in events if _event_active(e, today)]
    payload["recent_events"] = active_events
    payload["inactive_events"] = events

    if not active_events:
        payload["news_score"] = 0.0
        payload["news_label"] = "NEUTRAL"
        payload["signal"] = "NEUTRAL"
        payload["signal_reason"] = (
            f"No active OTA campaign or partner-health issue for {key} on {today.isoformat()}. "
            "Use live inventory gaps and historical channel performance as the primary ranking signals."
        )
        return payload

    if any(str(e.get("type")) in {"partner_connectivity", "infrastructure_watch"} for e in active_events):
        payload["signal"] = "PENALIZE"
        payload["news_label"] = "NEGATIVE"
        payload["signal_reason"] = (
            f"Active partner-health risk for {key} on {today.isoformat()}; use safer OTA alternatives "
            "unless this partner materially outperforms on the target dates."
        )
    elif any(str(e.get("type")).startswith("positive") for e in active_events):
        payload["signal"] = "PREFER"
        payload["news_label"] = "POSITIVE"
        payload["signal_reason"] = (
            f"Active OTA campaign/update for {key} overlaps {today.isoformat()}; prefer this partner "
            "when inventory gaps and historical performance also support it."
        )
    return payload
