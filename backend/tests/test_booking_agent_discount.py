"""Booking agent discount gate — no unapproved promotional rates."""

from services.ai.booking_agent import (
    _guest_requests_unapproved_discount,
    _max_approved_discount_pct,
)


def test_discount_ask_without_approved_offer_escalates():
    messages = [{"role": "user", "content": "Can you give me a 15% discount?"}]
    assert _guest_requests_unapproved_discount(messages) is True


def test_discount_ask_with_approved_offer_on_card_allowed():
    messages = [
        {
            "role": "user",
            "content": (
                '[STRUCTURED_STATE]\n{"action_data": {"type": "availability_result", '
                '"data": {"discount_pct": 5.0, "discount_recommended": true}}}'
            ),
        },
        {"role": "user", "content": "Does that include the discount?"},
    ]
    assert _guest_requests_unapproved_discount(messages) is False


def test_extra_discount_ask_escalates_even_when_offer_exists():
    messages = [
        {
            "role": "user",
            "content": (
                '[STRUCTURED_STATE]\n{"action_data": {"type": "split_stay_result", '
                '"data": {"discount_pct": 5.0}}}'
            ),
        },
        {"role": "user", "content": "Can you do a bigger discount than that?"},
    ]
    assert _guest_requests_unapproved_discount(messages) is True


def test_max_approved_discount_from_recovery_menu():
    action_data = {
        "type": "recovery_menu",
        "data": {
            "options": [{"discount_pct": 0}, {"discount_pct": 10}],
            "primary_action_data": {
                "type": "availability_result",
                "data": {"discount_pct": 5},
            },
        },
    }
    assert _max_approved_discount_pct(action_data) == 10.0
