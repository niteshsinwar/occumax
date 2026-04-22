"""
Occumax Backend — Full REST API Test Suite (v3 Stateless)
=========================================================

Tests every endpoint in the new stateless architecture.
"""

import time
import pytest
import httpx
from datetime import date, timedelta

BASE  = "http://localhost:8000"
TODAY = date.today()

def d(offset: int) -> str:
    """Return ISO date string offset days from today."""
    return str(TODAY + timedelta(days=offset))

@pytest.fixture(scope="session")
def client():
    """Single httpx client reused across the entire test session."""
    with httpx.Client(base_url=BASE, timeout=60) as c:
        yield c

@pytest.fixture(scope="session")
def optimise_result(client):
    """Fire T1 optimisation and return the stateless result."""
    r = client.post("/manager/optimise")
    assert r.status_code == 200, f"Optimise failed: {r.text}"
    return r.json()

# ═════════════════════════════════════════════════════════════════════════════
# 1. HEALTH
# ═════════════════════════════════════════════════════════════════════════════

class TestHealth:
    def test_health_200(self, client):
        r = client.get("/health")
        assert r.status_code == 200

    def test_health_status_ok(self, client):
        assert client.get("/health").json()["status"] == "ok"

# ═════════════════════════════════════════════════════════════════════════════
# 2. DASHBOARD
# ═════════════════════════════════════════════════════════════════════════════

class TestDashboard:
    def test_summary_200(self, client):
        assert client.get("/dashboard/summary").status_code == 200

    def test_summary_required_fields(self, client):
        data = client.get("/dashboard/summary").json()
        required = {"total_orphan_nights", "estimated_lost_revenue"}
        missing = required - set(data.keys())
        assert not missing, f"Summary missing fields: {missing}"

    def test_heatmap_200(self, client):
        assert client.get("/dashboard/heatmap").status_code == 200

    def test_heatmap_summary_block_present(self, client):
        hm = client.get("/dashboard/heatmap").json()
        assert isinstance(hm.get("summary"), dict)
        for key in ("total_orphan_nights", "estimated_lost_revenue"):
            assert key in hm["summary"], f"heatmap.summary missing: {key}"

# ═════════════════════════════════════════════════════════════════════════════
# 3. ADMIN
# ═════════════════════════════════════════════════════════════════════════════

class TestAdmin:
    ROOM_ID = f"TST{int(time.time()) % 100_000}"

    def test_list_rooms_200(self, client):
        assert client.get("/admin/rooms").status_code == 200

    def test_add_room_201(self, client):
        r = client.post("/admin/rooms", json={
            "id": self.ROOM_ID,
            "category": "ECONOMY",
            "base_rate": 1500,
            "floor_number": 1,
        })
        assert r.status_code == 201

    def test_slot_patch_hard_block(self, client):
        hm = client.get("/dashboard/heatmap").json()
        slot_id = None
        for row in hm["rows"]:
            for cell in row["cells"]:
                if cell["block_type"] == "EMPTY":
                    slot_id = cell["slot_id"]
                    break
            if slot_id: break
        if not slot_id: pytest.skip("No EMPTY slots")

        r = client.patch(f"/admin/slots/{slot_id}", json={"block_type": "HARD"})
        assert r.status_code == 200
        client.patch(f"/admin/slots/{slot_id}", json={"block_type": "EMPTY"})

    def test_admin_booking_crud(self, client):
        # Create a real booking first via receptionist
        check = client.post("/receptionist/check", json={
            "category": "STANDARD",
            "check_in": d(20),
            "check_out": d(22),
            "guest_name": "Admin Booking CRUD",
        }).json()
        if check["state"] == "NOT_POSSIBLE":
            pytest.skip("No STANDARD room available to create booking")

        confirm = client.post("/receptionist/confirm", json={
            "request": {
                "category": "STANDARD",
                "check_in": d(20),
                "check_out": d(22),
                "guest_name": "Admin Booking CRUD",
            },
            "room_id": check["room_id"],
            "swap_plan": check.get("swap_plan"),
        })
        assert confirm.status_code == 200
        booking_id = confirm.json()["booking_id"]

        # List bookings in a range that includes the stay dates
        r = client.get("/admin/bookings", params={"start": d(19), "end": d(23)})
        assert r.status_code == 200
        rows = r.json()
        assert any(b.get("id") == booking_id for b in rows), "Created booking not in admin list"

        # Update guest name (no slot resync needed)
        r = client.patch(f"/admin/bookings/{booking_id}", json={"guest_name": "Admin Edited"})
        assert r.status_code == 200

        # Delete booking (should free its slots)
        r = client.delete(f"/admin/bookings/{booking_id}")
        assert r.status_code == 200
        assert r.json().get("status") == "deleted"

# ═════════════════════════════════════════════════════════════════════════════
# 4. MANAGER
# ═════════════════════════════════════════════════════════════════════════════

class TestManager:
    def test_optimise_fields(self, client, optimise_result):
        for field in ("gaps_found", "shuffle_count", "converged", "swap_plan", "gaps"):
            assert field in optimise_result, f"OptimiseResult missing: {field}"

    def test_commit_noop_plan(self, client):
        r = client.post("/manager/commit", json={"swap_plan": []})
        assert r.status_code == 200
        assert r.json()["applied"] == 0

    def test_optimise_then_commit(self, client):
        res = client.post("/manager/optimise").json()
        if res["shuffle_count"] == 0:
            pytest.skip("No shuffles found to test commit")
        
        r = client.post("/manager/commit", json={"swap_plan": res["swap_plan"]})
        assert r.status_code == 200
        data = r.json()
        # Total unique bookings moved should match the swap plan length (since it's compressed)
        assert data["applied"] == len(res["swap_plan"])
        assert data["slots_updated"] > 0

# ═════════════════════════════════════════════════════════════════════════════
# 5. RECEPTIONIST
# ═════════════════════════════════════════════════════════════════════════════

class TestReceptionist:
    def test_check_1_night(self, client):
        r = client.post("/receptionist/check", json={
            "category": "STANDARD",
            "check_in": d(15),
            "check_out": d(16),
        })
        assert r.status_code == 200
        assert "state" in r.json()

    def test_confirm_full_flow(self, client):
        check = client.post("/receptionist/check", json={
            "category": "STANDARD",
            "check_in": d(10),
            "check_out": d(12),
            "guest_name": "Test Suite",
        }).json()
        if check["state"] == "NOT_POSSIBLE":
            pytest.skip("No STANDARD room available")
        
        confirm = client.post("/receptionist/confirm", json={
            "request": {
                "category": "STANDARD",
                "check_in": d(10),
                "check_out": d(12),
                "guest_name": "Test Suite",
            },
            "room_id": check["room_id"],
            "swap_plan": check.get("swap_plan"),
        })
        assert confirm.status_code == 200
        assert confirm.json()["status"] == "CONFIRMED"

# ═════════════════════════════════════════════════════════════════════════════
# 6. PHYSICAL CONSTRAINTS
# ═════════════════════════════════════════════════════════════════════════════

class TestConstraints:
    def test_soft_slot_patch_blocked(self, client):
        """Cannot manually patch a SOFT slot (real booking)."""
        check = client.post("/receptionist/check", json={
            "category": "STANDARD", "check_in": d(1), "check_out": d(2),
        }).json()
        if check["state"] == "NOT_POSSIBLE": pytest.skip("No room")
        
        client.post("/receptionist/confirm", json={
            "request": {"category": "STANDARD", "check_in": d(1), "check_out": d(2)},
            "room_id": check["room_id"],
        })
        
        slot_id = f"{check['room_id']}_{d(1)}"
        r = client.patch(f"/admin/slots/{slot_id}", json={"block_type": "HARD"})
        assert r.status_code == 409
        assert "Cannot manually change" in r.json()["detail"]
