import asyncio
import json
from datetime import date, datetime, timedelta
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
import os
import re

def shift_date_str(d_str: str, days: int) -> str:
    if not d_str:
        return d_str
    # ISO date only
    if len(d_str) == 10:
        d = date.fromisoformat(d_str)
        return (d + timedelta(days=days)).isoformat()
    # ISO datetime
    try:
        dt = datetime.fromisoformat(d_str)
        return (dt + timedelta(days=days)).isoformat()
    except:
        return d_str

async def main():
    db_url = os.environ.get("DATABASE_URL", "postgresql+asyncpg://niteshsinwar@localhost:5432/occumax")
    print(f"Using DB: {db_url}")
    engine = create_async_engine(db_url)
    
    with open("dump.json", "r") as f:
        data = json.load(f)
        
    tables = ["offers", "slots", "bookings", "rooms", "pricing_recs"]
    
    BAD_CATEGORIES = {"PREMIUM", "STUDIO"}
    SHIFT_DAYS = 2
    
    # Pre-process rows
    valid_rooms = set()
    
    sanitized = {t: [] for t in tables}
    
    # 1. Rooms
    for r in data.get("rooms", []):
        if r.get("category") in BAD_CATEGORIES:
            continue
        if r.get("base_rate"):
            r["base_rate"] = r["base_rate"] / 10.0
        valid_rooms.add(r["id"])
        sanitized["rooms"].append(r)
        
    # 2. Bookings
    for b in data.get("bookings", []):
        if b.get("room_category") in BAD_CATEGORIES:
            continue
        if b.get("assigned_room_id") and b["assigned_room_id"] not in valid_rooms:
            continue
        b["check_in"] = date.fromisoformat(shift_date_str(b["check_in"], SHIFT_DAYS)) if b.get("check_in") else None
        b["check_out"] = date.fromisoformat(shift_date_str(b["check_out"], SHIFT_DAYS)) if b.get("check_out") else None
        
        # created_at might be datetime or None
        c_at_str = shift_date_str(b.get("created_at"), SHIFT_DAYS)
        if c_at_str:
            b["created_at"] = datetime.fromisoformat(c_at_str)
        
        sanitized["bookings"].append(b)
        
    # 3. Slots
    for s in data.get("slots", []):
        if s.get("room_id") not in valid_rooms:
            continue
        if s.get("current_rate") is not None:
            s["current_rate"] = s["current_rate"] / 10.0
        if s.get("floor_rate") is not None:
            s["floor_rate"] = s["floor_rate"] / 10.0
        d_str = shift_date_str(s.get("date"), SHIFT_DAYS)
        s["date"] = date.fromisoformat(d_str) if d_str else None
        sanitized["slots"].append(s)
        
    # 4. Offers
    for o in data.get("offers", []):
        if o.get("category") in BAD_CATEGORIES:
            continue
        if o.get("original_rate") is not None:
            o["original_rate"] = o["original_rate"] / 10.0
        if o.get("discounted_rate") is not None:
            o["discounted_rate"] = o["discounted_rate"] / 10.0
        d_str = shift_date_str(o.get("offer_date"), SHIFT_DAYS)
        o["offer_date"] = date.fromisoformat(d_str) if d_str else None
        
        c_at_str = shift_date_str(o.get("created_at"), SHIFT_DAYS)
        o["created_at"] = datetime.fromisoformat(c_at_str) if c_at_str else None
        sanitized["offers"].append(o)
        
    # 5. Pricing Recs
    for p in data.get("pricing_recs", []):
        if p.get("category") in BAD_CATEGORIES:
            continue
        if p.get("current_rate") is not None:
            p["current_rate"] = p["current_rate"] / 10.0
        if p.get("recommended_rate") is not None:
            p["recommended_rate"] = p["recommended_rate"] / 10.0
        if p.get("floor_rate") is not None:
            p["floor_rate"] = p["floor_rate"] / 10.0
        d_str = shift_date_str(p.get("date"), SHIFT_DAYS)
        p["date"] = date.fromisoformat(d_str) if d_str else None
        
        c_at_str = shift_date_str(p.get("computed_at"), SHIFT_DAYS)
        p["computed_at"] = datetime.fromisoformat(c_at_str) if c_at_str else None
        sanitized["pricing_recs"].append(p)
    
    # Print stats
    print(f"Original stats:")
    for t in tables:
        print(f"  {t}: {len(data.get(t, []))}")
    print(f"Sanitized stats:")
    for t in tables:
        print(f"  {t}: {len(sanitized[t])}")
        
    async with engine.begin() as conn:
        print("Truncating tables...")
        await conn.execute(text("TRUNCATE TABLE offers, slots, bookings, rooms, pricing_recs CASCADE"))
        
        # Insert in correct order to respect foreign keys
        insert_order = ["rooms", "bookings", "slots", "offers", "pricing_recs"]
        for t in insert_order:
            rows = sanitized[t]
            if not rows:
                continue
            
            print(f"Inserting {len(rows)} into {t}...")
            columns = rows[0].keys()
            col_names = ", ".join(columns)
            placeholders = ", ".join(f":{c}" for c in columns)
            query = text(f"INSERT INTO {t} ({col_names}) VALUES ({placeholders})")
            
            await conn.execute(query, rows)
            
    print("Done importing and sanitizing!")

if __name__ == "__main__":
    asyncio.run(main())
