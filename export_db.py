import asyncio
import json
from datetime import date, datetime
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

class DateTimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (date, datetime)):
            return obj.isoformat()
        return super().default(obj)

async def main():
    engine = create_async_engine("postgresql+asyncpg://niteshsinwar@localhost:5432/occumax")
    tables = ["rooms", "bookings", "slots", "pricing_recs", "offers"]
    data = {}
    
    async with engine.begin() as conn:
        for t in tables:
            res = await conn.execute(text(f"SELECT * FROM {t}"))
            rows = [dict(r._mapping) for r in res.fetchall()]
            data[t] = rows
            
    with open("dump.json", "w") as f:
        json.dump(data, f, cls=DateTimeEncoder)
    print("Exported to dump.json")

asyncio.run(main())
