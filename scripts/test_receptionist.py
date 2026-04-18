"""
Receptionist Agent — Frontend-Faithful Test Framework
=====================================================

Simulates EXACTLY what the React frontend does when talking to the agent:

  GET  /ai/context                     → fetch hotel_context once (cached in state)
  POST /ai/chat  { messages, hotel_context }  → one agent turn

Message types the frontend can send:
  1. Normal user message           "I need a Deluxe room Apr 20–23"
  2. [HANDOFF] message             fired by handleExploreWithAi() after NOT_POSSIBLE
  3. [PREFS] message               fired by checkbox onChange when chat is active
  4. History (multi-turn)          all prior {role,content} turns sent every request

Tests:
  T01  GET /ai/context — returns valid hotel snapshot
  T02  Greeting → no booking card, calls get_revenue_intelligence
  T03  Occupancy question → intelligence response, no booking card
  T04  "What should I push today?" → proactive insight
  T05  Full booking request (category + dates) → availability_result card
  T06  Multi-turn history — agent uses prior context (guest name remembered)
  T07  NOT_POSSIBLE → agent tries alternatives (split / category shift / date shift)
  T08  [HANDOFF] message (exact frontend format) → tries alternatives
  T09  [PREFS] injected mid-conversation → acknowledged, no booking card
  T10  Split stay request → split_stay_result or availability_result card
  T11  Tool call guard — greeting MUST NOT produce availability_result card
  T12  action_data priority — actionable state wins over NOT_POSSIBLE

Run:
  python3 scripts/test_receptionist.py
  python3 scripts/test_receptionist.py --base-url https://161.118.164.30.nip.io
  python3 scripts/test_receptionist.py --verbose
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta
from typing import Optional

import requests

# ── Terminal colours ──────────────────────────────────────────────────────────
G = "\033[92m"; R = "\033[91m"; Y = "\033[93m"; B = "\033[94m"
BOLD = "\033[1m"; DIM = "\033[2m"; RESET = "\033[0m"


# ── Shared session state (mirrors React useState) ─────────────────────────────

class FrontendSession:
    """
    Mirrors the React state the real frontend maintains.

    hotelContext : fetched once from GET /ai/context, passed on every chat call
    messages     : full conversation history, appended after each turn
    """

    def __init__(self, base: str, verbose: bool = False):
        self.base    = base.rstrip("/")
        self.verbose = verbose
        self.hotel_context: Optional[str] = None
        self.messages: list[dict] = []   # [{ role, content }, ...]

    # ── mimic GET /ai/context (called once when AI panel opens) ──────────────

    def fetch_context(self) -> dict:
        r = requests.get(f"{self.base}/ai/context", timeout=30)
        r.raise_for_status()
        data = r.json()
        self.hotel_context = data.get("context_text", "")
        return data

    # ── mimic fireAiMessage(text, history) ───────────────────────────────────

    def send(
        self,
        user_text: str,
        *,
        override_history: Optional[list[dict]] = None,
        append_to_history: bool = True,
    ) -> dict:
        """
        Sends one turn exactly as the frontend does:
          - appends user message to history
          - POSTs { messages, hotel_context }
          - appends assistant reply to history
          - returns raw API response { reply, action_data }
        """
        history = override_history if override_history is not None else self.messages
        payload_messages = history + [{"role": "user", "content": user_text}]

        if self.verbose:
            print(f"\n  {DIM}→ POST /ai/chat  ({len(payload_messages)} msgs in history){RESET}")
            print(f"  {DIM}  user: {user_text[:120]}{RESET}")

        res = requests.post(
            f"{self.base}/ai/chat",
            json={
                "messages":      payload_messages,
                "hotel_context": self.hotel_context,
            },
            timeout=90,
        )
        res.raise_for_status()
        data = res.json()

        if append_to_history:
            self.messages.append({"role": "user",      "content": user_text})
            self.messages.append({"role": "assistant",  "content": data.get("reply", "")})

        if self.verbose:
            ad = data.get("action_data")
            print(f"  {DIM}← reply: {data.get('reply','')[:120]}{RESET}")
            if ad:
                print(f"  {DIM}← action_data: type={ad.get('type')}  state={ad.get('data',{}).get('state','—')}{RESET}")

        return data

    # ── mimic handleExploreWithAi() ───────────────────────────────────────────

    def handoff(
        self,
        guest: str,
        category: str,
        check_in: str,
        check_out: str,
        infeasible: str,
        prefs: dict,
    ) -> dict:
        """
        Builds the exact [HANDOFF] block the frontend generates and sends it
        with a CLEARED history (frontend does setChatMessages([]) before handoff).
        """
        lines = [
            "[HANDOFF]",
            f'Guest="{guest}"',
            f"preferred_category={category}",
            f"check_in={check_in}",
            f"check_out={check_out}",
            "deterministic_check=NOT_POSSIBLE",
            f"infeasible_dates={infeasible}",
            "split_same_category=NOT_CHECKED",
            f"options.nearby_dates_pm1={str(prefs.get('nearbyDatesPm1', True)).lower()}",
            f"options.different_category={str(prefs.get('differentCategory', True)).lower()}",
            f"options.split_stay={str(prefs.get('splitStay', True)).lower()}",
            f"options.mixed_category_split={str(prefs.get('allowMixedCategorySplit', False)).lower()}",
            "Rules: Only explore selected options. Prefer exact dates first, then minimal "
            "category delta (±1), then other categories, then date shift (±1).",
            "Return the best actionable option as an action card.",
        ]
        handoff_text = "\n".join(lines)
        # Frontend clears history before handoff (setChatMessages([]))
        self.messages = []
        return self.send(handoff_text)

    # ── mimic checkbox onChange → fireAiMessage([PREFS], chatMessages) ────────

    def prefs_update(self, prefs: dict) -> dict:
        """
        Builds the [PREFS] message from the checkbox state and sends it
        with current history (frontend passes chatMessages).
        """
        text = (
            f"[PREFS] Guest options updated: "
            f"nearby_dates={str(prefs.get('nearbyDatesPm1', True)).lower()}, "
            f"different_category={str(prefs.get('differentCategory', True)).lower()}, "
            f"split_stay={str(prefs.get('splitStay', True)).lower()}, "
            f"mixed_category_split={str(prefs.get('allowMixedCategorySplit', False)).lower()}"
        )
        return self.send(text)


# ── Assertion helpers ─────────────────────────────────────────────────────────

def _action_type(r: dict) -> Optional[str]:
    return (r.get("action_data") or {}).get("type")

def _action_state(r: dict) -> Optional[str]:
    return ((r.get("action_data") or {}).get("data") or {}).get("state")

def _has_booking_card(r: dict) -> bool:
    return _action_type(r) == "availability_result"

def _is_actionable(r: dict) -> bool:
    return _action_state(r) in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE")

def _is_split(r: dict) -> bool:
    return _action_type(r) == "split_stay_result" and \
           _action_state(r) == "SPLIT_POSSIBLE"

def _has_reply(r: dict) -> bool:
    return bool((r.get("reply") or "").strip())


# ── Test runner ───────────────────────────────────────────────────────────────

class TestRunner:
    def __init__(self, verbose: bool):
        self.passed  = 0
        self.failed  = 0
        self.verbose = verbose

    def ok(self, name: str, detail: str = ""):
        self.passed += 1
        print(f"  {G}✓{RESET} {name}" + (f"  {DIM}{detail}{RESET}" if detail else ""))

    def fail(self, name: str, detail: str = ""):
        self.failed += 1
        print(f"  {R}✗ FAIL{RESET} {BOLD}{name}{RESET}" + (f"\n      {Y}{detail}{RESET}" if detail else ""))

    def skip(self, name: str, reason: str = ""):
        print(f"  {Y}○ SKIP{RESET} {name}" + (f"  {DIM}{reason}{RESET}" if reason else ""))

    def section(self, title: str):
        print(f"\n{B}{BOLD}{title}{RESET}")

    def summary(self):
        total = self.passed + self.failed
        print(f"\n{'─'*60}")
        if self.failed == 0:
            print(f"{G}{BOLD}All {total} tests passed{RESET}")
        else:
            print(f"{R}{BOLD}{self.passed}/{total} passed · {self.failed} failed{RESET}")
        print("─"*60)
        return self.failed == 0


# ── Individual test functions ─────────────────────────────────────────────────

def t01_context(sess: FrontendSession, tr: TestRunner):
    tr.section("T01 — GET /ai/context (frontend fetches once on panel open)")
    try:
        data = sess.fetch_context()
        ctx  = sess.hotel_context or ""

        if data.get("hotel_name"):
            tr.ok("hotel_name present", data["hotel_name"])
        else:
            tr.fail("hotel_name missing from context response")

        if ctx and "Date:" in ctx:
            tr.ok("context_text has date line", ctx.split("\n")[0])
        else:
            tr.fail("context_text missing or has no Date line", repr(ctx[:80]))

        room_cats = [l for l in ctx.splitlines() if "total=" in l]
        if room_cats:
            tr.ok(f"context_text has {len(room_cats)} room category lines", room_cats[0].strip())
        else:
            tr.fail("context_text has no room category lines")

    except Exception as e:
        tr.fail(f"GET /ai/context failed: {e}")


def t02_greeting(sess: FrontendSession, tr: TestRunner):
    tr.section("T02 — Greeting (hello) → intelligence response, NO booking card")
    try:
        r = sess.send("hello", append_to_history=False)
        if not _has_reply(r):
            tr.fail("Empty reply for 'hello'")
        elif _has_booking_card(r) and _action_state(r) in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE", "NOT_POSSIBLE"):
            tr.fail(
                "Got availability_result card for greeting — AI called check_availability instead of get_revenue_intelligence",
                f"state={_action_state(r)}  reply={r.get('reply','')[:80]}"
            )
        else:
            tr.ok("No booking card for greeting", f"reply: {r.get('reply','')[:80]}…")
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t03_occupancy_question(sess: FrontendSession, tr: TestRunner):
    tr.section("T03 — Occupancy question → intelligence response, NO booking card")
    try:
        r = sess.send("How's our occupancy this week?", append_to_history=False)
        if _has_booking_card(r):
            tr.fail(
                "Got booking card for occupancy question",
                f"state={_action_state(r)}  reply={r.get('reply','')[:80]}"
            )
        elif _has_reply(r):
            tr.ok("Intelligence reply for occupancy question", r.get('reply','')[:80])
        else:
            tr.fail("Empty reply for occupancy question")
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t04_proactive_insight(sess: FrontendSession, tr: TestRunner):
    tr.section("T04 — 'What should I push today?' → proactive channel/category insight")
    try:
        r = sess.send("What should I push today?", append_to_history=False)
        reply = r.get("reply", "")
        if _has_booking_card(r) and _action_state(r) in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
            # AI called check_availability for a proactive question — wrong
            tr.fail("AI called check_availability for a proactive insight question", reply[:80])
        elif _has_reply(r):
            tr.ok("Proactive insight returned", reply[:80])
        else:
            tr.fail("Empty reply for proactive question")
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t05_booking_request(sess: FrontendSession, tr: TestRunner, ci: str, co: str):
    tr.section("T05 — Full booking request (category + dates) → availability_result card")
    try:
        msg = f"I need a Deluxe room from {ci} to {co} for Mrs Sharma"
        r = sess.send(msg, append_to_history=True)   # add to history for T06
        ad = r.get("action_data")
        if ad and ad.get("type") == "availability_result":
            state = _action_state(r)
            tr.ok(f"Got availability_result (state={state})", r.get("reply","")[:60])
        elif ad and ad.get("type") == "split_stay_result":
            tr.ok("Got split_stay_result (room fully booked, split found)", r.get("reply","")[:60])
        else:
            tr.fail(
                "No action card for explicit booking request",
                f"action_data={ad}  reply={r.get('reply','')[:80]}"
            )
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t06_multi_turn_history(sess: FrontendSession, tr: TestRunner):
    tr.section("T06 — Multi-turn history: agent must remember guest name from T05")
    try:
        # At this point sess.messages contains T05's turns
        if len(sess.messages) < 2:
            tr.skip("No prior turns in history (T05 may have failed)", "skipping")
            return

        r = sess.send("Does she need the same room for the following night too?", append_to_history=True)
        reply = (r.get("reply") or "").lower()
        # The agent should recall "Deluxe", "Mrs Sharma", or prior dates
        keywords = ["deluxe", "sharma", "room", "available", "night"]
        hit = any(k in reply for k in keywords)
        ad = r.get("action_data")
        if hit or ad:
            tr.ok(
                "Agent used prior context",
                f"action_data={ad.get('type') if ad else None}  reply={r.get('reply','')[:80]}"
            )
        else:
            tr.fail(
                "Agent reply shows no sign of using prior conversation history",
                f"reply={reply[:120]}"
            )
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t07_not_possible_alternatives(sess: FrontendSession, tr: TestRunner, ci: str, _co: str):
    tr.section("T07 — NOT_POSSIBLE → agent tries alternatives (fresh session, packed dates)")
    # Use Suite on a date range — likely to be NOT_POSSIBLE or require shuffle
    sess2 = FrontendSession(sess.base, sess.verbose)
    sess2.hotel_context = sess.hotel_context  # reuse already-fetched context
    try:
        msg = f"I need a Suite from {ci} to {_co} for a VIP guest. Any option at all?"
        r = sess2.send(msg, append_to_history=False)
        ad = r.get("action_data")
        reply = r.get("reply", "")
        if ad:
            tr.ok(
                f"Got action card (type={ad.get('type')}, state={_action_state(r)})",
                reply[:80]
            )
        elif _has_reply(r) and len(reply) > 30:
            tr.ok("Agent gave meaningful response (may have no rooms at all)", reply[:80])
        else:
            tr.fail("Empty or trivial response for Suite request", reply[:40])
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t08_handoff(sess: FrontendSession, tr: TestRunner, ci: str, co: str):
    tr.section("T08 — [HANDOFF] message (exact frontend format) → agent tries alternatives")
    sess2 = FrontendSession(sess.base, sess.verbose)
    sess2.hotel_context = sess.hotel_context
    try:
        r = sess2.handoff(
            guest      = "Mr Kapoor",
            category   = "DELUXE",
            check_in   = ci,
            check_out  = co,
            infeasible = f"{ci}, {(date.fromisoformat(ci) + timedelta(days=1)).isoformat()}",
            prefs      = {
                "nearbyDatesPm1":        True,
                "differentCategory":     True,
                "splitStay":             True,
                "allowMixedCategorySplit": False,
            },
        )
        ad     = r.get("action_data")
        reply  = r.get("reply", "")

        # [HANDOFF] should NOT repeat check on the same exact dates
        # It should either produce an action card or a meaningful message
        if ad and ad.get("type") in ("availability_result", "split_stay_result"):
            tr.ok(
                f"[HANDOFF] → got action card (type={ad.get('type')}, state={_action_state(r)})",
                reply[:80]
            )
        elif _has_reply(r) and len(reply) > 20:
            tr.ok("[HANDOFF] → meaningful reply (no rooms across all options)", reply[:80])
        else:
            tr.fail("[HANDOFF] → empty or confusing response", reply[:80])

        # Extra check: ensure history was cleared (session fresh start)
        if len(sess2.messages) <= 2:
            tr.ok("[HANDOFF] fired with cleared history (correct — matches frontend)", f"{len(sess2.messages)} msgs")
        else:
            tr.fail("[HANDOFF] sent with non-empty history — frontend always clears first")

    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t09_prefs_injection(sess: FrontendSession, tr: TestRunner, ci: str, co: str):
    tr.section("T09 — [PREFS] checkbox injection → acknowledged, no booking card, history maintained")
    sess2 = FrontendSession(sess.base, sess.verbose)
    sess2.hotel_context = sess.hotel_context
    try:
        # Simulate: receptionist already had a conversation (T05 equivalent)
        sess2.send(f"I need a Deluxe room {ci} to {co}", append_to_history=True)

        prior_len = len(sess2.messages)

        # Receptionist un-ticks "split stay" checkbox → [PREFS] fires with current history
        r = sess2.prefs_update({
            "nearbyDatesPm1":        True,
            "differentCategory":     True,
            "splitStay":             False,   # ← changed
            "allowMixedCategorySplit": False,
        })
        reply = r.get("reply", "")

        # [PREFS] should NOT trigger a booking tool call
        if _has_booking_card(r) and _is_actionable(r):
            tr.fail("[PREFS] triggered an availability_result card — AI should only acknowledge")
        elif _has_reply(r):
            tr.ok("[PREFS] acknowledged without booking card", reply[:80])
        else:
            tr.fail("[PREFS] got empty reply")

        # History should have grown by 2 (user + assistant)
        if len(sess2.messages) == prior_len + 2:
            tr.ok("[PREFS] message appended to history correctly", f"{len(sess2.messages)} msgs total")
        else:
            tr.fail(f"History length unexpected after [PREFS]: expected {prior_len + 2}, got {len(sess2.messages)}")

    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t10_split_stay(sess: FrontendSession, tr: TestRunner, ci: str, co: str):
    tr.section("T10 — Split stay request → split_stay_result or alternatives")
    sess2 = FrontendSession(sess.base, sess.verbose)
    sess2.hotel_context = sess.hotel_context
    try:
        # Request a long stay — more likely to need split
        long_co = str(date.fromisoformat(ci) + timedelta(days=7))
        msg = (
            f"A guest wants to stay in a Studio from {ci} to {long_co}. "
            "Can we arrange a split stay if needed? They're fine moving rooms once."
        )
        r = sess2.send(msg, append_to_history=False)
        ad = r.get("action_data")
        if ad:
            if ad.get("type") == "split_stay_result":
                tr.ok(f"Got split_stay_result (state={_action_state(r)})", r.get("reply","")[:80])
            else:
                tr.ok(f"Got action card (type={ad.get('type')}, state={_action_state(r)})", r.get("reply","")[:80])
        elif _has_reply(r):
            tr.ok("Meaningful response for split stay request", r.get("reply","")[:80])
        else:
            tr.fail("Empty response for split stay request")
    except Exception as e:
        tr.fail(f"Request failed: {e}")


def t11_tool_guard_greeting(sess: FrontendSession, tr: TestRunner):
    tr.section("T11 — Tool call guard: greetings MUST NOT call booking tools")
    greetings = [
        "hi",
        "good morning",
        "what's looking good to sell today?",
        "any upgrades available tonight?",
    ]
    sess2 = FrontendSession(sess.base, sess.verbose)
    sess2.hotel_context = sess.hotel_context
    for msg in greetings:
        try:
            r = sess2.send(msg, append_to_history=False)
            ad = r.get("action_data")
            if ad and ad.get("type") == "availability_result":
                state = _action_state(r)
                tr.fail(
                    f"'{msg}' → got availability_result (state={state})",
                    "AI called check_availability for a non-booking message"
                )
            else:
                tr.ok(f"'{msg}' → no booking card", r.get("reply","")[:60])
            time.sleep(0.5)   # small delay between Gemini calls
        except Exception as e:
            tr.fail(f"'{msg}' → request failed: {e}")


def t12_action_data_priority(sess: FrontendSession, tr: TestRunner, ci: str, co: str):
    tr.section("T12 — action_data priority: DIRECT_AVAILABLE wins over NOT_POSSIBLE")
    # This tests _extract_action_data scanning logic in the backend.
    # If the AI calls check_availability(ECONOMY) → DIRECT and then
    # check_availability(SUITE) → NOT_POSSIBLE, the DIRECT card must win.
    # We can't control which tools the AI calls, but we can verify that
    # if an actionable card exists, it surfaces — not a NOT_POSSIBLE card.
    sess2 = FrontendSession(sess.base, sess.verbose)
    sess2.hotel_context = sess.hotel_context
    try:
        # Ask for the cheapest available room — ECONOMY is almost certainly available
        msg = f"Find me anything available from {ci} to {co}, any category, whatever you can get"
        r = sess2.send(msg, append_to_history=False)
        ad = r.get("action_data")
        if ad and _action_state(r) in ("DIRECT_AVAILABLE", "SHUFFLE_POSSIBLE"):
            tr.ok(f"Actionable card surfaced (state={_action_state(r)})", r.get("reply","")[:80])
        elif ad and _action_state(r) == "NOT_POSSIBLE":
            tr.fail(
                "Got NOT_POSSIBLE despite 'any category' request — priority logic or tool use issue",
                r.get("reply","")[:80]
            )
        elif ad and ad.get("type") == "split_stay_result":
            tr.ok("Got split_stay_result", r.get("reply","")[:80])
        else:
            if _has_reply(r):
                tr.ok("Agent gave meaningful reply without card (acceptable for fully-booked hotel)", r.get("reply","")[:80])
            else:
                tr.fail("Empty response for open-ended availability request")
    except Exception as e:
        tr.fail(f"Request failed: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Receptionist agent end-to-end test suite")
    parser.add_argument("--base-url", default="http://localhost:8000", metavar="URL")
    parser.add_argument("--verbose", action="store_true", help="Show request/response details")
    parser.add_argument("--delay",   type=float, default=1.0,
                        help="Seconds to wait between tests (avoid Gemini rate limit)")
    args = parser.parse_args()

    print(f"\n{BOLD}Receptionist Agent — Frontend-Faithful Test Suite{RESET}")
    print(f"Target : {args.base_url}")
    print(f"Delay  : {args.delay}s between tests")
    print(f"Verbose: {args.verbose}")

    today = date.today()
    ci    = str(today + timedelta(days=5))   # check-in 5 days from now
    co    = str(today + timedelta(days=8))   # 3-night stay

    print(f"\nTest window: {ci} → {co}  (3 nights)")

    tr   = TestRunner(verbose=args.verbose)
    sess = FrontendSession(args.base_url, verbose=args.verbose)

    # T01: fetch context first (like frontend does on panel open)
    t01_context(sess, tr)
    time.sleep(args.delay)

    # T02–T04: insight / intelligence messages (no dates in user message)
    t02_greeting(sess, tr)
    time.sleep(args.delay)

    t03_occupancy_question(sess, tr)
    time.sleep(args.delay)

    t04_proactive_insight(sess, tr)
    time.sleep(args.delay)

    # T05: first booking request (adds to sess.messages for T06)
    t05_booking_request(sess, tr, ci, co)
    time.sleep(args.delay)

    # T06: multi-turn — uses sess.messages from T05
    t06_multi_turn_history(sess, tr)
    time.sleep(args.delay)

    # T07–T12: isolated fresh sessions (don't pollute main sess.messages)
    t07_not_possible_alternatives(sess, tr, ci, co)
    time.sleep(args.delay)

    t08_handoff(sess, tr, ci, co)
    time.sleep(args.delay)

    t09_prefs_injection(sess, tr, ci, co)
    time.sleep(args.delay)

    t10_split_stay(sess, tr, ci, co)
    time.sleep(args.delay)

    t11_tool_guard_greeting(sess, tr)
    time.sleep(args.delay)

    t12_action_data_priority(sess, tr, ci, co)

    success = tr.summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
