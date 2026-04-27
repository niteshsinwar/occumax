"""
Predictive what-if discount simulation for the Pricing tab.

Single-shot Gemini call: given a compact occupancy/rate snapshot, model how
different discount levels affect estimated demand, net ADR, and revenue index,
then pick a recommended scenario for hackathon storytelling.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta

from langchain_google_genai import ChatGoogleGenerativeAI

from config import settings
from core.schemas.pricing import PricingWhatIfAnalysis

logger = logging.getLogger(__name__)

_DISCOUNT_TIERS = (0, 10, 20, 30, 40)


def _finalize_what_if_payload(data: dict) -> dict:
    """
    Coerce Gemini output into shapes that satisfy PricingWhatIfAnalysis.
    Raises ValueError if the payload cannot be salvaged.
    """
    scenarios_raw = data.get("scenarios") or []
    if len(scenarios_raw) != 5:
        raise ValueError("expected 5 scenarios")
    scenarios = []
    for i, tier in enumerate(_DISCOUNT_TIERS):
        row = scenarios_raw[i] if isinstance(scenarios_raw[i], dict) else {}
        dp = int(round(float(row.get("discount_pct", tier))))
        if dp != tier:
            raise ValueError(f"scenario {i}: discount_pct must be {tier}, got {dp}")
        scenarios.append({
            "discount_pct": float(tier),
            "demand_lift_pct": float(row.get("demand_lift_pct", 0)),
            "net_price_index": float(row.get("net_price_index", 100)),
            "revenue_index": float(row.get("revenue_index", 100)),
            "rationale": str(row.get("rationale") or "").strip() or "—",
        })
    ri = int(data.get("recommended_index", 2))
    ri = max(0, min(4, ri))
    out = {
        "headline": str(data.get("headline") or "Predictive discount what-if").strip(),
        "methodology": str(data.get("methodology") or "").strip(),
        "scenarios": scenarios,
        "recommended_index": ri,
    }
    PricingWhatIfAnalysis.model_validate(out)
    return out

_SYSTEM = """\
You are a hotel revenue management AI. Run a *predictive what-if* exercise:

Given the JSON payload with per-category daily occupancy and average rates,
simulate how **different uniform discount levels** (off best available / BAR proxy)
would affect:
- **demand_lift_pct**: expected incremental booking / conversion lift vs baseline (0 = no change)
- **net_price_index**: net ADR vs baseline where baseline = 100 (e.g. 15% discount → ~85 if no mix shift)
- **revenue_index**: expected total room revenue vs baseline where baseline = 100

Rules:
- Output **ONLY** valid JSON (no markdown fences).
- Include **exactly 5** scenarios with these discount_pct values in order: 0, 10, 20, 30, 40
  (meaning 0%, 10%, 20%, 30%, 40% off BAR for the low-occupancy / discount-sensitive slice).
- demand_lift_pct must be non-decreasing as discount increases.
- net_price_index should generally decrease as discount increases.
- revenue_index is your best estimate combining volume + price; pick **recommended_index**
  as the 0-based index (0..4) of the scenario that maximizes expected revenue **without**
  absurd over-discounting (avoid recommending 40% unless clearly justified).
- methodology: 2–3 sentences explaining you used a simplified elasticity model + snapshot context.

Schema:
{
  "methodology": string,
  "scenarios": [
    {
      "discount_pct": number,
      "demand_lift_pct": number,
      "net_price_index": number,
      "revenue_index": number,
      "rationale": string
    }
  ],
  "recommended_index": number,
  "headline": string
}
"""


def _compact_snapshot(snapshot: dict, today: date, max_days: int = 14) -> dict:
    """Reduce snapshot to a small structure for the model."""
    out: dict = {}
    for cat, days in snapshot.items():
        if not isinstance(days, dict):
            continue
        rows = []
        for i in range(max_days):
            d = (today + timedelta(days=i)).isoformat()
            b = days.get(d) or {}
            rows.append({
                "date": d,
                "occ_pct": float(b.get("occ_pct") or 0),
                "avg_rate": float(b.get("avg_rate") or 0),
                "floor_rate": float(b.get("floor_rate") or 0),
                "otb": int(b.get("otb") or 0),
                "total": int(b.get("total") or 0),
            })
        out[str(cat)] = rows
    return out


def _parse_json(text: str) -> dict:
    raw = str(text).strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    if raw.startswith("{") and raw.endswith("}"):
        return json.loads(raw)
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        raise ValueError("no JSON object")
    return json.loads(m.group(0))


def _heuristic_what_if(snapshot: dict, today: date) -> dict:
    """Deterministic fallback ladder when Gemini is unavailable."""
    # crude hotel-wide avg occ for next 14d
    occs: list[float] = []
    for _, days in snapshot.items():
        if not isinstance(days, dict):
            continue
        for i in range(14):
            d = (today + timedelta(days=i)).isoformat()
            b = days.get(d) or {}
            occs.append(float(b.get("occ_pct") or 0))
    avg_occ = sum(occs) / len(occs) if occs else 45.0
    stress = max(0.0, min(1.0, (60.0 - avg_occ) / 60.0))  # higher when occ is low

    scenarios = []
    for d in (0, 10, 20, 30, 40):
        lift = round(stress * d * 0.45 + d * 0.15, 1)
        net_idx = round(100.0 - d * 0.92, 1)
        rev_idx = round((100.0 + lift) * (net_idx / 100.0), 1)
        scenarios.append({
            "discount_pct": float(d),
            "demand_lift_pct": lift,
            "net_price_index": net_idx,
            "revenue_index": rev_idx,
            "rationale": f"Heuristic: low-occupancy stress={stress:.2f}; {d}% discount trades ADR for pickup.",
        })

    # pick best revenue_index among 0..40 ladder
    best_i = max(range(len(scenarios)), key=lambda i: scenarios[i]["revenue_index"])
    payload = {
        "methodology": (
            "Heuristic elasticity fallback: demand lift rises modestly with discount; "
            "net ADR falls roughly one-for-one with discount; revenue index is their product vs baseline 100."
        ),
        "scenarios": scenarios,
        "recommended_index": best_i,
        "headline": f"Recommended ~{int(scenarios[best_i]['discount_pct'])}% discount under heuristic model (avg occ {avg_occ:.0f}%).",
    }
    return _finalize_what_if_payload(payload)


async def run_pricing_what_if(snapshot: dict, today: date) -> dict:
    """
    Returns dict compatible with PricingWhatIfAnalysis Pydantic model.
    """
    compact = _compact_snapshot(snapshot, today, max_days=14)
    payload = {"hotel_snapshot_next_14d_by_category": compact}

    try:
        if not getattr(settings, "GEMINI_API_KEY", None):
            raise RuntimeError("GEMINI_API_KEY not configured")

        model = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            temperature=0.15,
            google_api_key=settings.GEMINI_API_KEY,
        )
        human = json.dumps({"today": today.isoformat(), **payload}, ensure_ascii=False)
        resp = await model.ainvoke([{"role": "system", "content": _SYSTEM}, {"role": "user", "content": human}])
        text = getattr(resp, "content", "") if resp else ""
        if isinstance(text, list):
            text = "".join(
                getattr(b, "text", str(b)) if not isinstance(b, str) else b
                for b in text
            )
        data = _parse_json(text)
        return _finalize_what_if_payload(data)
    except Exception:
        logger.exception("Pricing what-if: Gemini failed; using heuristic ladder.")
        return _heuristic_what_if(snapshot, today)
