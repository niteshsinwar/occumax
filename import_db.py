import asyncio
import json
from datetime import date, datetime
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
import os

async def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set!")
        return
        
    engine = create_async_engine(db_url)
    
    with open("dump.json", "r") as f:
        data = json.load(f)
        
    tables = ["offers", "slots", "bookings", "rooms", "pricing_recs"]
    
    async with engine.begin() as conn:
        print("Truncating tables...")
        # Disable constraints to allow easy truncate
        await conn.execute(text("TRUNCATE TABLE offers, slots, bookings, rooms, pricing_recs CASCADE"))
        
        for t in reversed(tables): # rooms, bookings, slots, offers
            rows = data.get(t, [])
            if not rows:
                continue
            
            print(f"Inserting {len(rows)} into {t}...")
            # For each row, build parameterized query
            columns = rows[0].keys()
            col_names = ", ".join(columns)
            placeholders = ", ".join(f":{c}" for c in columns)
            
            query = text(f"INSERT INTO {t} ({col_names}) VALUES ({placeholders})")
            
            # Executemany equivalent
            await conn.execute(query, rows)
            
    print("Done importing!")

asyncio.run(main())
