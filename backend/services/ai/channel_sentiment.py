"""
Mock channel partner sentiment data — US market (New Jersey / NYC-metro).

Simulates data pulled from:
  - OTA partner portals (Expedia Partner Central, Booking.com Extranet Pulse)
  - News aggregators (TechCrunch, WSJ, Skift, Phocuswire)
  - Social listening (Trustpilot, App Store/Play Store reviews, Twitter/X)

Each partner entry:
  sentiment_score    : float -1.0 (very negative) → +1.0 (very positive)
  sentiment_label    : POSITIVE / NEUTRAL / NEGATIVE / CRITICAL
  signal             : PREFER / NEUTRAL / PENALIZE / AVOID
  review_trend       : improving / stable / declining
  avg_user_rating    : float out of 5.0
  negative_review_pct: % of reviews in last 30 days rated ≤2 stars
  recent_events      : news items that drove the current sentiment
  signal_reason      : plain-English allocation guidance for this partner
"""

CHANNEL_SENTIMENT: dict[str, dict] = {
    "Expedia": {
        "sentiment_score": -0.48,
        "sentiment_label": "NEGATIVE",
        "signal": "PENALIZE",
        "review_trend": "declining",
        "avg_user_rating": 2.8,
        "negative_review_pct": 51,
        "recent_events": [
            {
                "date": "2026-04-20",
                "type": "data_breach",
                "headline": "Expedia Group confirms API credential leak exposing 4.2M booking records",
                "impact": "CRITICAL",
                "source": "Wired / TechCrunch",
                "detail": (
                    "Leaked data includes guest names, travel itineraries, and partial payment tokens. "
                    "FTC opened inquiry. Conversion rates estimated -28% week-on-week as guests "
                    "avoid saving card details on platform. Hotels.com (Expedia Group) also affected."
                ),
            },
            {
                "date": "2026-04-16",
                "type": "negative_review_surge",
                "headline": "Expedia app crashes during MetLife Stadium concert search — 22K complaints",
                "impact": "HIGH",
                "source": "Trustpilot / App Store",
                "detail": (
                    "App outage during high-traffic event search window caused mass booking failures. "
                    "NJ/NYC metro guests pivoted to Booking.com and Priceline. Trust damage acute "
                    "for event-adjacent weekend bookings."
                ),
            },
        ],
        "signal_reason": (
            "Active data breach + app outage during MetLife event weekend. Trust erosion will "
            "suppress NJ conversion. Deprioritise and route volume to Booking.com or Priceline "
            "until breach is resolved — especially for event-adjacent dates."
        ),
    },

    "Hotels.com": {
        "sentiment_score": -0.40,
        "sentiment_label": "NEGATIVE",
        "signal": "PENALIZE",
        "review_trend": "declining",
        "avg_user_rating": 3.0,
        "negative_review_pct": 44,
        "recent_events": [
            {
                "date": "2026-04-20",
                "type": "data_breach",
                "headline": "Hotels.com affected by Expedia Group API breach — same credential exposure",
                "impact": "HIGH",
                "source": "TechCrunch",
                "detail": "Hotels.com shares Expedia Group infrastructure. Breach impact shared.",
            },
        ],
        "signal_reason": (
            "Shares Expedia Group breach impact. Avoid alongside Expedia until incident resolved."
        ),
    },

    "Booking.com": {
        "sentiment_score": 0.68,
        "sentiment_label": "POSITIVE",
        "signal": "PREFER",
        "review_trend": "improving",
        "avg_user_rating": 4.5,
        "negative_review_pct": 9,
        "recent_events": [
            {
                "date": "2026-04-19",
                "type": "positive_campaign",
                "headline": "Booking.com launches 'NJ Weekend Escape' campaign — 15% cashback for tri-state guests",
                "impact": "HIGH",
                "source": "Booking.com Press / Skift",
                "detail": (
                    "Targeted at NYC, Long Island, and Philadelphia drive-to market. 15% cashback "
                    "on NJ hotel stays through May 31. Strong demand pull for weekend Deluxe/Suite. "
                    "Expedia outage is funneling additional traffic to Booking.com this week."
                ),
            },
            {
                "date": "2026-04-14",
                "type": "positive_review_trend",
                "headline": "Booking.com earns 4.5★ on Trustpilot — best US hotel OTA rating in 2026",
                "impact": "MEDIUM",
                "source": "Trustpilot / Phocuswire",
                "detail": "Improved instant refund policy and 24/7 US support driving strong ratings.",
            },
        ],
        "signal_reason": (
            "Active NJ cashback campaign targeting drive-to leisure + Expedia outage routing "
            "additional traffic here. Prioritise for Standard/Deluxe weekend gaps and Suite "
            "event-adjacent dates. Best OTA platform rating in market right now."
        ),
    },

    "Priceline": {
        "sentiment_score": 0.20,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "stable",
        "avg_user_rating": 3.7,
        "negative_review_pct": 24,
        "recent_events": [
            {
                "date": "2026-04-10",
                "type": "positive_campaign",
                "headline": "Priceline Express Deals surge — NJ hotels seeing 18% more opaque bookings",
                "impact": "MEDIUM",
                "source": "Phocuswire",
                "detail": (
                    "Priceline's opaque Express Deals driving volume for Standard rooms "
                    "at discounted rates. Good for filling low-occupancy weekday gaps but "
                    "ADR will compress — use selectively."
                ),
            },
        ],
        "signal_reason": (
            "Opaque deals filling Standard weekday gaps — use for low-occ dates where "
            "compressed ADR is acceptable. Avoid for high-occ or event-adjacent nights."
        ),
    },

    "Agoda": {
        "sentiment_score": 0.15,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "stable",
        "avg_user_rating": 3.5,
        "negative_review_pct": 27,
        "recent_events": [
            {
                "date": "2026-04-08",
                "type": "negative_review_surge",
                "headline": "Agoda US customer support response times hit 8+ days — complaints spike",
                "impact": "LOW",
                "source": "ConsumerAffairs / Twitter/X",
                "detail": (
                    "Slow CS resolution affects post-stay sentiment but not pre-booking conversion "
                    "materially. Viable for international guests transiting NYC."
                ),
            },
        ],
        "signal_reason": (
            "Slow CS complaints don't suppress bookings significantly. Maintain standard allocation "
            "for international guests — Agoda's Asia-Pacific audience overlaps with NJ corporate visitors."
        ),
    },

    "Amadeus": {
        "sentiment_score": 0.22,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "stable",
        "avg_user_rating": 4.1,
        "negative_review_pct": 6,
        "recent_events": [],
        "signal_reason": (
            "No notable events. GDS channel is stable — primary route for pharma/finance "
            "corporate travel management accounts. Use for weekday Standard/Deluxe gaps."
        ),
    },

    "Sabre": {
        "sentiment_score": 0.18,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "stable",
        "avg_user_rating": 4.0,
        "negative_review_pct": 5,
        "recent_events": [],
        "signal_reason": "No notable events. GDS fallback for corporate accounts.",
    },

    "Direct": {
        "sentiment_score": 1.0,
        "sentiment_label": "POSITIVE",
        "signal": "PREFER",
        "review_trend": "improving",
        "avg_user_rating": 4.7,
        "negative_review_pct": 4,
        "recent_events": [
            {
                "date": "2026-04-17",
                "type": "positive_review_trend",
                "headline": "Hotel Google profile hits 4.7★ — #2 mid-market property in NJ",
                "impact": "MEDIUM",
                "source": "Google Business",
                "detail": (
                    "Strong own-brand reputation supports direct rate hold. "
                    "Zero commission — prioritise for high-occ dates and Suite/Deluxe where "
                    "OTA competition is low. NYC overflow guests often book direct when searching "
                    "NJ last-minute."
                ),
            },
        ],
        "signal_reason": (
            "Zero commission + #2 Google rating in NJ mid-market. Prioritise direct for "
            "high-occ dates, event-adjacent nights, and Suite/Deluxe where OTA adds no value."
        ),
    },
}


def get_sentiment(partner_name: str) -> dict:
    """
    Return sentiment data for a partner. Case-insensitive lookup.
    Falls back to a neutral default for unknown partners.
    """
    key = partner_name.strip()
    data = CHANNEL_SENTIMENT.get(key) or next(
        (v for k, v in CHANNEL_SENTIMENT.items() if k.lower() == key.lower()), None
    )
    if data is None:
        return {
            "partner": key,
            "sentiment_score": 0.0,
            "sentiment_label": "NEUTRAL",
            "signal": "NEUTRAL",
            "review_trend": "stable",
            "avg_user_rating": None,
            "negative_review_pct": None,
            "recent_events": [],
            "signal_reason": "No sentiment data available for this partner.",
        }
    return {"partner": key, **data}
