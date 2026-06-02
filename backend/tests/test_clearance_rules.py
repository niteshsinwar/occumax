"""Unit tests for Smart Clearance deterministic rules."""

from datetime import date

from services.pricing.clearance_rules import (
    apply_clearance_rules,
    date_signals_from_context,
    has_adverse_weather,
)


def test_sandwich_forces_discount():
    rate, action, reason = apply_clearance_rules(
        suggested_rate=200.0,
        action="INCREASE",
        reason="AI wanted uplift",
        current_rate=200.0,
        floor_rate=150.0,
        days_until_stay=2,
        has_unsold=True,
        is_sandwich=True,
        occ_pct=70.0,
        day_signals=[],
    )
    assert action == "DISCOUNT"
    assert rate <= 200.0 * 0.9
    assert "sandwich" in reason.lower()


def test_near_term_weather_overrides_event_compression():
    weather = [{"kind": "WEATHER", "title": "Storms", "detail": "severe thunderstorms", "score": 76}]
    event = [{"kind": "EVENT", "title": "Conference week", "detail": "compression", "score": 88}]
    rate, action, _ = apply_clearance_rules(
        suggested_rate=210.0,
        action="INCREASE",
        reason="Conference compression",
        current_rate=200.0,
        floor_rate=150.0,
        days_until_stay=1,
        has_unsold=True,
        is_sandwich=False,
        occ_pct=65.0,
        day_signals=weather + event,
    )
    assert action == "DISCOUNT"
    assert rate < 200.0


def test_far_horizon_allows_ai_hold():
    rate, action, _ = apply_clearance_rules(
        suggested_rate=205.0,
        action="INCREASE",
        reason="Event compression",
        current_rate=200.0,
        floor_rate=150.0,
        days_until_stay=10,
        has_unsold=True,
        is_sandwich=False,
        occ_pct=55.0,
        day_signals=[{"kind": "EVENT", "title": "Conference", "score": 88}],
    )
    assert action == "INCREASE"
    assert rate == 205.0


def test_near_term_event_blocks_increase():
    rate, action, reason = apply_clearance_rules(
        suggested_rate=220.0,
        action="INCREASE",
        reason="Compression",
        current_rate=200.0,
        floor_rate=150.0,
        days_until_stay=3,
        has_unsold=True,
        is_sandwich=False,
        occ_pct=60.0,
        day_signals=[{"kind": "EVENT", "title": "Conference", "score": 88}],
    )
    assert action == "MAINTAIN"
    assert rate == 200.0
    assert "no increase" in reason.lower()


def test_date_signals_from_context_offsets():
    items = [
        {
            "kind": "EVENT",
            "title": "Conf",
            "detail": "",
            "impact_start_offset_days": 1,
            "impact_end_offset_days": 2,
            "factors": [],
        }
    ]
    today = date(2026, 6, 1)
    mapped = date_signals_from_context(items, today)
    assert "2026-06-02" in mapped
    assert "2026-06-03" in mapped
    assert "2026-06-01" not in mapped


def test_has_adverse_weather_keyword():
    assert has_adverse_weather([{"kind": "WEATHER", "title": "Thunderstorms", "score": 40}])
