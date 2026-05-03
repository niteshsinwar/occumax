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
        "sentiment_score": -0.45,
        "sentiment_label": "NEGATIVE",
        "signal": "PENALIZE",
        "review_trend": "declining",
        "avg_user_rating": 2.9,
        "negative_review_pct": 48,
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
            {
                "date": "2026-04-25",
                "type": "positive_update",
                "headline": "Expedia CEO issues public statement committing to full breach remediation by May 15",
                "impact": "LOW",
                "source": "Expedia IR / Skift",
                "detail": (
                    "Remediation roadmap published. Security audit underway. Market confidence "
                    "remains low but the response is seen as a step toward recovery."
                ),
            },
        ],
        "signal_reason": (
            "Active data breach and app outage are suppressing NJ conversion. CEO remediation "
            "statement is a small positive signal but trust remains damaged. Deprioritise for now "
            "— use Priceline or Booking.com instead. Reassess after May 15 remediation target."
        ),
    },

    "Hotels.com": {
        "sentiment_score": -0.28,
        "sentiment_label": "NEGATIVE",
        "signal": "PENALIZE",
        "review_trend": "stable",
        "avg_user_rating": 3.2,
        "negative_review_pct": 38,
        "recent_events": [
            {
                "date": "2026-04-20",
                "type": "data_breach",
                "headline": "Hotels.com affected by Expedia Group API breach — same credential exposure",
                "impact": "HIGH",
                "source": "TechCrunch",
                "detail": "Hotels.com shares Expedia Group infrastructure. Breach impact shared.",
            },
            {
                "date": "2026-04-22",
                "type": "positive_campaign",
                "headline": "Hotels.com launches 'Nights on Us' loyalty push — free night after 5 stays",
                "impact": "MEDIUM",
                "source": "Hotels.com Press",
                "detail": (
                    "New loyalty mechanic targeting repeat NJ/NYC business travelers. "
                    "Partially offsetting breach fallout for returning guests who trust the brand."
                ),
            },
        ],
        "signal_reason": (
            "Breach impact shared with Expedia Group, but new loyalty campaign partially softens "
            "the blow. Still penalised this cycle — use as a secondary fallback for loyalty-segment "
            "guests once breach is resolved."
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
                "headline": "Booking.com launches 'NJ Weekend Escape' — 15% cashback for tri-state guests",
                "impact": "HIGH",
                "source": "Booking.com Press / Skift",
                "detail": (
                    "Targeted at NYC, Long Island, and Philadelphia drive-to market. 15% cashback "
                    "on NJ hotel stays through May 31. Strong demand pull for weekend Deluxe/Suite. "
                    "Expedia outage funneling additional traffic to Booking.com this week."
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
            {
                "date": "2026-04-27",
                "type": "minor_concern",
                "headline": "Booking.com rate parity enforcement letters sent to 200+ US properties",
                "impact": "LOW",
                "source": "Hospitality Net",
                "detail": (
                    "Compliance pressure on hotels offering lower rates on direct channels. "
                    "Minor friction but does not affect guest-facing conversion."
                ),
            },
        ],
        "signal_reason": (
            "Active NJ cashback campaign + Expedia outage traffic routing here makes this the "
            "strongest OTA right now. Minor rate-parity friction is manageable. Prioritise for "
            "weekend leisure and Deluxe/Suite gaps through May."
        ),
    },

    "Priceline": {
        "sentiment_score": 0.32,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "improving",
        "avg_user_rating": 3.9,
        "negative_review_pct": 21,
        "recent_events": [
            {
                "date": "2026-04-10",
                "type": "positive_campaign",
                "headline": "Priceline Express Deals surge — NJ hotels seeing 18% more opaque bookings",
                "impact": "MEDIUM",
                "source": "Phocuswire",
                "detail": (
                    "Opaque Express Deals driving volume for Standard rooms. Good for filling "
                    "low-occupancy weekday gaps — ADR will compress slightly, use selectively."
                ),
            },
            {
                "date": "2026-04-23",
                "type": "positive_update",
                "headline": "Priceline rolls out AI price-match guarantee — boosts consumer trust",
                "impact": "MEDIUM",
                "source": "Skift / Priceline Blog",
                "detail": (
                    "New price-match guarantee is driving stronger app downloads and repeat bookings. "
                    "Particularly effective for Standard and Economy segments where price sensitivity "
                    "is highest. Conversion uplift estimated at +12% for opaque deals."
                ),
            },
            {
                "date": "2026-04-18",
                "type": "minor_concern",
                "headline": "Priceline opaque model draws criticism for ADR compression on NJ mid-market",
                "impact": "LOW",
                "source": "Hotel Management Magazine",
                "detail": "Industry pushback on deep discounting but booking volumes remain healthy.",
            },
        ],
        "signal_reason": (
            "Strong for Standard/Economy weekday gaps where ADR compression is acceptable. "
            "New AI price-match feature boosting consumer confidence. Good secondary choice when "
            "Expedia is penalised — especially for low-occ weekday fills."
        ),
    },

    "Agoda": {
        "sentiment_score": 0.28,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "improving",
        "avg_user_rating": 3.8,
        "negative_review_pct": 22,
        "recent_events": [
            {
                "date": "2026-04-21",
                "type": "positive_campaign",
                "headline": "Agoda partners with Singapore Airlines — NJ hotels added to Asia-Pacific bundles",
                "impact": "MEDIUM",
                "source": "Agoda Press / Travel Weekly",
                "detail": (
                    "Flight+hotel bundle targeting Asia-Pacific business travelers transiting NYC. "
                    "Strong fit for Deluxe and Suite categories with international guests. "
                    "Expected +8% uplift in international bookings for NJ corridor properties."
                ),
            },
            {
                "date": "2026-04-08",
                "type": "minor_concern",
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
            "Singapore Airlines bundle is a genuine demand driver for Asia-Pacific international "
            "guests — good fit for Deluxe/Suite. CS response-time issue is minor. Solid choice "
            "for international segments where Booking.com reach is weaker."
        ),
    },

    "Amadeus": {
        "sentiment_score": 0.40,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "improving",
        "avg_user_rating": 4.2,
        "negative_review_pct": 5,
        "recent_events": [
            {
                "date": "2026-04-24",
                "type": "positive_update",
                "headline": "Amadeus GDS adds 14 NJ pharma/biotech corporate accounts to NJ hotel content feed",
                "impact": "MEDIUM",
                "source": "Amadeus Partner Network / BTN",
                "detail": (
                    "New corporate accounts from J&J, Novartis, and 12 smaller NJ pharma firms "
                    "added to the Amadeus content feed. Direct pipeline for weekday Standard and "
                    "Deluxe corporate demand. Expect +15% GDS weekday bookings in May."
                ),
            },
            {
                "date": "2026-04-15",
                "type": "minor_concern",
                "headline": "Amadeus platform maintenance window causes 4-hour GDS outage",
                "impact": "LOW",
                "source": "Amadeus Status Page",
                "detail": "Scheduled maintenance, fully resolved. No lasting impact on availability.",
            },
        ],
        "signal_reason": (
            "New NJ pharma corporate accounts are a strong demand signal for weekday Standard/Deluxe. "
            "GDS maintenance was minor and resolved. Best channel for Mon–Thu corporate fills — "
            "use as the primary weekday allocation target."
        ),
    },

    "Sabre": {
        "sentiment_score": 0.30,
        "sentiment_label": "NEUTRAL",
        "signal": "NEUTRAL",
        "review_trend": "stable",
        "avg_user_rating": 4.1,
        "negative_review_pct": 7,
        "recent_events": [
            {
                "date": "2026-04-17",
                "type": "positive_update",
                "headline": "Sabre launches SynXis AI rate recommendation tool for mid-market US hotels",
                "impact": "MEDIUM",
                "source": "Sabre Hospitality / Skift",
                "detail": (
                    "SynXis AI tool integrates rate recommendations with GDS inventory. "
                    "Early adopters reporting 9% ADR improvement on corporate bookings. "
                    "Positions Sabre as a tech-forward GDS option for NJ corporate segment."
                ),
            },
            {
                "date": "2026-04-09",
                "type": "minor_concern",
                "headline": "Sabre Q1 earnings miss — investor concern over GDS market share decline",
                "impact": "LOW",
                "source": "Reuters / Bloomberg",
                "detail": (
                    "GDS share slowly declining vs OTA but corporate TMC volumes remain stable. "
                    "No near-term impact on booking availability for hotel partners."
                ),
            },
        ],
        "signal_reason": (
            "SynXis AI tool is a genuine ADR improvement signal for corporate bookings. "
            "Earnings miss is a long-term concern but doesn't affect near-term corporate volume. "
            "Solid secondary GDS option alongside Amadeus for weekday corporate fills."
        ),
    },

    "Direct": {
        "sentiment_score": 0.88,
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
                    "Strong own-brand reputation supports direct rate hold. Zero commission — "
                    "prioritise for high-occ dates and Suite/Deluxe where OTA competition is low."
                ),
            },
            {
                "date": "2026-04-26",
                "type": "positive_campaign",
                "headline": "Hotel direct booking widget now integrated with Google Hotel Ads — CPC model live",
                "impact": "MEDIUM",
                "source": "Google Hotel Ads Dashboard",
                "detail": (
                    "Google Hotel Ads CPC integration driving commission-free direct traffic. "
                    "Estimated 20% increase in direct booking share for Deluxe and Suite categories. "
                    "NYC overflow guests increasingly booking direct via Google search."
                ),
            },
        ],
        "signal_reason": (
            "Zero commission + top Google rating + new Google Hotel Ads integration all point "
            "to direct as the best channel for high-occ and premium categories. "
            "Prioritise for event-adjacent nights, Suite/Deluxe, and any date above 70% occupancy."
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
