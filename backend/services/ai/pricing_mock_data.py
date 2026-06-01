"""
Mock external data for the pricing multi-call AI strategy.

Real DB data (occupancy, rates, bookings) is fetched live.
External signals (weather, events, market news, historical) use realistic
NJ/NYC metro mock data so the AI receives rich context without live APIs.
"""

from __future__ import annotations

from datetime import date, timedelta


def get_weather_forecast(start_date: date, days: int = 20) -> list[dict]:
    """Return mock NJ weather forecast for the analysis window."""
    # Realistic NJ June 2026 weather — driven by day-of-week and seasonal norms
    BASE_PATTERNS: list[dict] = [
        {"condition": "Sunny", "temp_f": 72, "weekend_modifier": 1.0},
        {"condition": "Partly Cloudy", "temp_f": 68, "weekend_modifier": 0.9},
        {"condition": "Sunny", "temp_f": 70, "weekend_modifier": 1.0},
        {"condition": "Cloudy", "temp_f": 64, "weekend_modifier": 0.8},
        {"condition": "Light Rain", "temp_f": 61, "weekend_modifier": 0.7},
        {"condition": "Clear", "temp_f": 66, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 74, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 76, "weekend_modifier": 1.0},
        {"condition": "Thunderstorms", "temp_f": 65, "weekend_modifier": 0.6},
        {"condition": "Clear", "temp_f": 68, "weekend_modifier": 1.0},
        {"condition": "Partly Cloudy", "temp_f": 70, "weekend_modifier": 0.9},
        {"condition": "Sunny", "temp_f": 73, "weekend_modifier": 1.0},
        {"condition": "Clear", "temp_f": 72, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 75, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 77, "weekend_modifier": 1.0},
        {"condition": "Partly Cloudy", "temp_f": 70, "weekend_modifier": 0.9},
        {"condition": "Clear", "temp_f": 68, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 72, "weekend_modifier": 1.0},
        {"condition": "Clear", "temp_f": 74, "weekend_modifier": 1.0},
        {"condition": "Partly Cloudy", "temp_f": 71, "weekend_modifier": 0.9},
        {"condition": "Sunny", "temp_f": 73, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 78, "weekend_modifier": 1.0},
        {"condition": "Clear", "temp_f": 76, "weekend_modifier": 1.0},
        {"condition": "Partly Cloudy", "temp_f": 69, "weekend_modifier": 0.9},
        {"condition": "Thunderstorms", "temp_f": 62, "weekend_modifier": 0.6},
        {"condition": "Clear", "temp_f": 67, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 71, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 79, "weekend_modifier": 1.0},
        {"condition": "Sunny", "temp_f": 81, "weekend_modifier": 1.0},
        {"condition": "Partly Cloudy", "temp_f": 74, "weekend_modifier": 0.9},
    ]

    forecast = []
    for i in range(min(days, len(BASE_PATTERNS))):
        d = start_date + timedelta(days=i)
        p = BASE_PATTERNS[i % len(BASE_PATTERNS)]
        is_weekend = d.weekday() >= 5
        demand_note = (
            "Strong leisure drive-to demand — NJ shore weekend opener"
            if is_weekend and p["condition"] in ("Sunny", "Clear") and p["temp_f"] >= 70
            else "Moderate leisure demand" if is_weekend and p["condition"] == "Partly Cloudy"
            else "Reduced leisure demand — poor outdoor conditions" if is_weekend and p["condition"] in ("Light Rain", "Thunderstorms")
            else "Corporate demand inelastic to weather" if not is_weekend
            else "Normal demand"
        )
        forecast.append({
            "date": d.isoformat(),
            "day_of_week": d.strftime("%A"),
            "condition": p["condition"],
            "temp_f": p["temp_f"],
            "is_weekend": is_weekend,
            "demand_note": demand_note,
        })
    return forecast


def get_events_for_window(start_date: date, days: int = 20) -> list[dict]:
    """Return mock NJ/NYC-area events calendar for the analysis window."""
    # Fixed 2026 events — realistic NJ demand drivers
    FIXED_EVENTS = [
        {
            "name": "Rutgers Spring Commencement",
            "date": "2026-06-16",
            "end_date": "2026-06-17",
            "location": "Rutgers University, New Brunswick NJ",
            "type": "graduation",
            "demand_impact": "very_high",
            "note": "Families travel from across US — Suites/Deluxe fill 7-10 days ahead; rate-inelastic",
        },
        {
            "name": "MetLife Stadium — Taylor Swift Eras Tour Night 1",
            "date": "2026-06-08",
            "end_date": "2026-06-08",
            "location": "MetLife Stadium, East Rutherford NJ",
            "type": "stadium_concert",
            "demand_impact": "high",
            "note": "Large concert — Deluxe/Suite 1-2 nights surrounding event; OTA surge expected",
        },
        {
            "name": "MetLife Stadium — Taylor Swift Eras Tour Night 2",
            "date": "2026-06-09",
            "end_date": "2026-06-09",
            "location": "MetLife Stadium, East Rutherford NJ",
            "type": "stadium_concert",
            "demand_impact": "high",
            "note": "Back-to-back concert weekend — extended stay bookings; Deluxe/Suite premium",
        },
        {
            "name": "NJ Convention & Expo Center — Pharma Summit",
            "date": "2026-06-13",
            "end_date": "2026-06-14",
            "location": "Edison NJ",
            "type": "conference",
            "demand_impact": "medium",
            "note": "Mid-week pharma/biotech conference — Standard/Deluxe corporate block; rate-inelastic",
        },
        {
            "name": "Princeton University Commencement",
            "date": "2026-07-02",
            "end_date": "2026-07-02",
            "location": "Princeton NJ",
            "type": "graduation",
            "demand_impact": "medium",
            "note": "Lead-in demand starts late June — families book Standard/Deluxe in advance",
        },
        {
            "name": "Memorial Day Weekend",
            "date": "2026-06-23",
            "end_date": "2026-06-26",
            "location": "NJ (holiday)",
            "type": "holiday",
            "demand_impact": "high",
            "note": "Shore season opener — peak leisure demand, early check-ins; strong OTA pickup",
        },
        {
            "name": "Asbury Park Spring Music Fest",
            "date": "2026-06-10",
            "end_date": "2026-06-11",
            "location": "Asbury Park NJ",
            "type": "music_festival",
            "demand_impact": "medium",
            "note": "Weekend leisure spike — drive-to guests; Standard/Studio demand boost",
        },
    ]

    window_end = start_date + timedelta(days=days)
    events_in_window = []
    for ev in FIXED_EVENTS:
        ev_date = date.fromisoformat(ev["date"])
        # Include events with lead-in demand (up to 3 days before)
        if start_date <= ev_date < window_end + timedelta(days=3):
            events_in_window.append({**ev, "days_from_today": (ev_date - start_date).days})
    return events_in_window


def get_market_news() -> list[dict]:
    """Return mock NJ/NYC hotel market news and travel trend headlines."""
    return [
        {
            "headline": "NYC hotel ADR hits $487 average — NJ overflow demand at 3-year high",
            "source": "STR Market Flash",
            "impact": "positive",
            "note": "NYC rate spike drives overflow guests to NJ; bookings arrive 1-3 days out via OTA",
        },
        {
            "headline": "Spring leisure travel up 14% YoY in NYC metro per TSA checkpoint data",
            "source": "TSA/STR Combined Report",
            "impact": "positive",
            "note": "Leisure segment outperforming; weekend demand strong through June",
        },
        {
            "headline": "Expedia flash sale period ending — direct hotel selling window reopening",
            "source": "OTA Channel Intelligence",
            "impact": "neutral",
            "note": "Post-flash-sale period favors direct hotel selling; hold rates on Deluxe/Suite",
        },
        {
            "headline": "NJ pharma corridor hiring surge — extended-stay corporate demand up Q2",
            "source": "CoStar NJ Market Report",
            "impact": "positive",
            "note": "J&J, Sanofi, Novartis headcount growth; mid-week Standard/Deluxe demand structural",
        },
        {
            "headline": "Priceline flash-deal inventory thinning for NJ market in June",
            "source": "Priceline Partner Network Alert",
            "impact": "positive",
            "note": "Less OTA discounting pressure on Standard; room to hold BAR or slight increase",
        },
        {
            "headline": "NJ shore towns booked 80%+ for Fourth of July — spillover to inland hotels",
            "source": "NJ Division of Tourism",
            "impact": "positive",
            "note": "Shore overflow creates late-arriving leisure demand in week preceding Fourth of July",
        },
        {
            "headline": "Google Travel Trends: 'hotels near Rutgers graduation' searches +340% WoW",
            "source": "Google Travel Insights",
            "impact": "very_positive",
            "note": "Graduation demand well-signaled; families booking Suites/Deluxe 10+ days out",
        },
    ]


def get_historical_trends() -> dict:
    """Return mock 2-year historical booking data for the same time period."""
    return {
        "period": "June weeks 2024 and 2025",
        "source": "2-year internal PMS history (mock)",
        "by_category": {
            "ECONOMY": {
                "avg_occ_pct_2024": 58.2,
                "avg_occ_pct_2025": 63.1,
                "avg_adr_2024": 89.0,
                "avg_adr_2025": 96.5,
                "yoy_occ_growth": 8.4,
                "yoy_adr_growth": 8.4,
                "peak_days": ["Friday", "Saturday"],
                "note": "Steady growth; price-sensitive OTA segment dominates",
            },
            "STANDARD": {
                "avg_occ_pct_2024": 67.4,
                "avg_occ_pct_2025": 72.8,
                "avg_adr_2024": 139.0,
                "avg_adr_2025": 151.0,
                "yoy_occ_growth": 8.0,
                "yoy_adr_growth": 8.6,
                "peak_days": ["Thursday", "Friday", "Saturday"],
                "note": "Corporate Mon-Thu + leisure Fri-Sun; graduation weekends spike to 95%+",
            },
            "STUDIO": {
                "avg_occ_pct_2024": 61.0,
                "avg_occ_pct_2025": 65.3,
                "avg_adr_2024": 155.0,
                "avg_adr_2025": 168.0,
                "yoy_occ_growth": 7.0,
                "yoy_adr_growth": 8.4,
                "peak_days": ["Friday", "Saturday", "Sunday"],
                "note": "Extended-stay + leisure mix; packages outperform flat rates",
            },
            "DELUXE": {
                "avg_occ_pct_2024": 71.2,
                "avg_occ_pct_2025": 76.5,
                "avg_adr_2024": 229.0,
                "avg_adr_2025": 249.0,
                "yoy_occ_growth": 7.4,
                "yoy_adr_growth": 8.7,
                "peak_days": ["Friday", "Saturday"],
                "note": "Event-driven demand spikes sharply; graduation + MetLife overlap = 95%+ occ",
            },
            "SUITE": {
                "avg_occ_pct_2024": 74.8,
                "avg_occ_pct_2025": 79.3,
                "avg_adr_2024": 369.0,
                "avg_adr_2025": 399.0,
                "yoy_occ_growth": 6.0,
                "yoy_adr_growth": 8.1,
                "peak_days": ["Friday", "Saturday", "Sunday"],
                "note": "Graduation families book Suites 2+ weeks out; luxury leisure growing segment",
            },
            "PREMIUM": {
                "avg_occ_pct_2024": 68.5,
                "avg_occ_pct_2025": 73.1,
                "avg_adr_2024": 299.0,
                "avg_adr_2025": 325.0,
                "yoy_occ_growth": 6.7,
                "yoy_adr_growth": 8.7,
                "peak_days": ["Thursday", "Friday", "Saturday"],
                "note": "Corporate + high-end leisure mix; rate-inelastic mid-week demand",
            },
        },
        "key_observations": [
            "June graduation season (Rutgers) consistently delivers highest occupancy of Q2",
            "MetLife Stadium events add +18-25% ADR for Deluxe/Suite on event nights",
            "Fourth of July weekend produces 3rd highest revenue week of the year",
            "NYC overflow bookings arrive 1-2 days out — keep last-minute OTA inventory priced at premium",
            "Pharma conference season (June-Jul) fills mid-week Standard inventory predictably",
        ],
    }
