"""
Analytics endpoints smoke tests (requires live server).

Run with:
    cd backend
    pytest -k analytics -v
"""

from __future__ import annotations

import pytest
import httpx
from datetime import date, timedelta

BASE = "http://localhost:8000"
TODAY = date.today()


def d(offset: int) -> str:
    return str(TODAY + timedelta(days=offset))


@pytest.fixture(scope="session")
def client():
    with httpx.Client(base_url=BASE, timeout=60) as c:
        yield c


class TestAnalytics:
    def test_occupancy_forecast_200(self, client):
        r = client.get("/analytics/occupancy-forecast", params={
            "start": d(0),
            "end": d(14),
            "as_of": d(0),
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert "series" in body
        assert isinstance(body["series"], list)

    def test_pace_200(self, client):
        r = client.get("/analytics/pace", params={
            "start": d(0),
            "end": d(14),
            "as_of": d(0),
            "max_lead_days": 14,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert "series" in body
        assert isinstance(body["series"], list)

    def test_event_insights_200(self, client):
        r = client.get("/analytics/event-insights", params={
            "start": d(0),
            "end": d(7),
            "as_of": d(0),
        })
        assert r.status_code == 200, r.text
        body = r.json()
        for key in ("los_histogram", "arrival_weekday_histogram"):
            assert key in body
