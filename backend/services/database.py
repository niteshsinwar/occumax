from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from config import settings

engine = create_async_engine(settings.DATABASE_URL, echo=False, pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def create_tables():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Phase 2 columns — ADD COLUMN IF NOT EXISTS is idempotent on PostgreSQL
        for stmt in [
            "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stay_group_id  VARCHAR",
            "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS segment_index  INTEGER DEFAULT 0",
            "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_pct   FLOAT   DEFAULT 0.0",
            "ALTER TABLE slots    ADD COLUMN IF NOT EXISTS floor_rate     FLOAT   DEFAULT 0.0",
        ]:
            await conn.execute(text(stmt))
