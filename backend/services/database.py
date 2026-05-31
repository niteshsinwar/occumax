import ssl as _ssl
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from config import settings

# asyncpg doesn't accept sslmode= query param — strip it and pass an SSL context.
# Aiven uses a self-signed CA chain, so we disable cert verification (encryption
# is still enforced; only hostname/chain verification is skipped).
_db_url = settings.DATABASE_URL
_connect_args: dict = {}
_needs_ssl = False
for _param in ("sslmode=require", "sslmode=verify-full", "sslmode=verify-ca", "sslmode=prefer"):
    if f"?{_param}" in _db_url:
        _db_url = _db_url.replace(f"?{_param}", "")
        _needs_ssl = True
    elif f"&{_param}" in _db_url:
        _db_url = _db_url.replace(f"&{_param}", "")
        _needs_ssl = True

if _needs_ssl:
    _ssl_ctx = _ssl.create_default_context(cafile=settings.DB_SSL_CA_FILE or None)
    if not settings.DB_SSL_VERIFY:
        _ssl_ctx.check_hostname = False
        _ssl_ctx.verify_mode = _ssl.CERT_NONE
    _connect_args["ssl"] = _ssl_ctx

engine = create_async_engine(_db_url, echo=False, pool_pre_ping=True, connect_args=_connect_args)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
