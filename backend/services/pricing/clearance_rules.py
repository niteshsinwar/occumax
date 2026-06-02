"""
Deterministic Smart Clearance rules applied after AI pricing synthesis.

Encodes operator intent: near-term unsold nights and sandwich gaps should clear,
even when citywide event signals suggest compression. Lead time and inventory
state take precedence over bullish context scores.
"""

from __future__ import annotations

from datetime import date, timedelta

# Days from analysis anchor (inclusive): 0 = tonight
NEAR_TERM_MAX_DAYS = 4
HOLD_WINDOW_MIN_DAYS = 7

SANDWICH_MIN_DISCOUNT_PCT = 12.0
NEAR_TERM_WEATHER_DISCOUNT_PCT = 10.0
NEAR_TERM_WEAK_OCC_DISCOUNT_PCT = 6.0
WEAK_CATEGORY_OCC_PCT = 45.0
ACTION_THRESHOLD_PCT = 2.0


def round_rate_5(rate: float) -> float:
    return round(rate / 5) * 5


def reconcile_action(suggested: float, current: float) -> str:
    if current <= 0:
        return "MAINTAIN"
    if suggested > current * (1 + ACTION_THRESHOLD_PCT / 100):
        return "INCREASE"
    if suggested < current * (1 - ACTION_THRESHOLD_PCT / 100):
        return "DISCOUNT"
    return "MAINTAIN"


def date_signals_from_context(context_items: list[dict] | None, today: date) -> dict[str, list[dict]]:
    """Map ISO date -> active context signals (mirrors pricing_agent._context_payload)."""
    date_signals: dict[str, list[dict]] = {}
    for item in context_items or []:
        if not isinstance(item, dict):
            continue
        start_offset = max(0, min(60, int(item.get("impact_start_offset_days") or 0)))
        end_raw = item.get("impact_end_offset_days")
        end_offset = max(start_offset, min(60, int(end_raw if end_raw is not None else start_offset)))
        signal = {
            "kind": str(item.get("kind") or "").strip(),
            "severity": str(item.get("severity") or "").strip(),
            "title": str(item.get("title") or "").strip(),
            "detail": str(item.get("detail") or "").strip()[:240],
            "score": _composite_score(item),
        }
        for delta in range(start_offset, end_offset + 1):
            d = (today + timedelta(days=delta)).isoformat()
            date_signals.setdefault(d, []).append(signal)
    return date_signals


def _composite_score(item: dict) -> int:
    factors = item.get("factors") or []
    weight_sum = 0.0
    score_sum = 0.0
    for factor in factors:
        if not isinstance(factor, dict):
            continue
        weight = max(0.0, min(1.0, float(factor.get("weight") or 0.0)))
        score = max(0.0, min(100.0, float(factor.get("score") or 0.0)))
        weight_sum += weight
        score_sum += score * weight
    return round(score_sum / weight_sum) if weight_sum > 0 else 0


def has_adverse_weather(signals: list[dict]) -> bool:
    for s in signals:
        if str(s.get("kind", "")).upper() != "WEATHER":
            continue
        score = int(s.get("score") or 0)
        text = f"{s.get('title', '')} {s.get('detail', '')}".lower()
        if score >= 55 or any(k in text for k in ("storm", "thunder", "rain", "severe", "adverse")):
            return True
    return False


def has_event_compression(signals: list[dict]) -> bool:
    return any(str(s.get("kind", "")).upper() == "EVENT" for s in signals)


def apply_target_discount(current: float, floor: float, min_discount_pct: float) -> float:
    target = current * (1 - min_discount_pct / 100)
    if floor > 0:
        target = max(target, floor)
    return round_rate_5(target)


def apply_clearance_rules(
    *,
    suggested_rate: float,
    action: str,
    reason: str,
    current_rate: float,
    floor_rate: float,
    days_until_stay: int,
    has_unsold: bool,
    is_sandwich: bool,
    occ_pct: float,
    day_signals: list[dict],
) -> tuple[float, str, str]:
    """
    Adjust AI suggestion using inventory lead time and signal precedence.
    Returns (suggested_rate, action, reason).
    """
    if not has_unsold or current_rate <= 0:
        return suggested_rate, reconcile_action(suggested_rate, current_rate), reason

    adverse = has_adverse_weather(day_signals)
    event = has_event_compression(day_signals)
    rate = suggested_rate
    note = ""

    if is_sandwich:
        rate = min(rate, apply_target_discount(current_rate, floor_rate, SANDWICH_MIN_DISCOUNT_PCT))
        note = "Clearance rule: sandwich night — discount to fill stranded gap."
    elif days_until_stay <= NEAR_TERM_MAX_DAYS and adverse:
        rate = min(rate, apply_target_discount(current_rate, floor_rate, NEAR_TERM_WEATHER_DISCOUNT_PCT))
        note = (
            "Clearance rule: near-term unsold night with adverse weather — discount to capture demand."
        )
        if event:
            note += " (Overrides event-week compression for unsold inventory.)"
    elif days_until_stay <= NEAR_TERM_MAX_DAYS and occ_pct < WEAK_CATEGORY_OCC_PCT:
        rate = min(rate, apply_target_discount(current_rate, floor_rate, NEAR_TERM_WEAK_OCC_DISCOUNT_PCT))
        note = "Clearance rule: near-term weak pickup — rate support to stimulate bookings."
    elif days_until_stay <= NEAR_TERM_MAX_DAYS and event:
        if rate > current_rate * (1 + ACTION_THRESHOLD_PCT / 100) or action == "INCREASE":
            rate = round_rate_5(current_rate)
            note = "Clearance rule: near-term unsold during event week — hold BAR, no increase."
    elif days_until_stay >= HOLD_WINDOW_MIN_DAYS:
        # Far horizon: trust AI compression/hold unless sandwich (handled above)
        pass

    final_action = reconcile_action(rate, current_rate)
    if note:
        reason = f"{note} {reason}".strip()
    return rate, final_action, reason
