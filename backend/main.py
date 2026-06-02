import logging
import os
import time

# Enforce hotel timezone globally to prevent date-boundary bugs across distributed deployments.
os.environ["TZ"] = "America/New_York"
time.tzset()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from api import admin, dashboard, manager, receptionist, booking, ai, booking_ai, pricing, analytics

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
cors_origins = settings.cors_origins_list()

app = FastAPI(title="Optihost API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Starlette's CORSMiddleware does NOT attach CORS headers to unhandled 500 responses.
# This handler catches them before the middleware strips the headers.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    origin = request.headers.get("origin")
    cors_origin = origin if origin in cors_origins else (cors_origins[0] if cors_origins else "")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers={"Access-Control-Allow-Origin": cors_origin} if cors_origin else None,
    )

app.include_router(dashboard.router)
app.include_router(manager.router)
app.include_router(pricing.router)
app.include_router(receptionist.router)
app.include_router(booking.router)
app.include_router(admin.router)
app.include_router(ai.router)
app.include_router(booking_ai.router)
app.include_router(analytics.router)


@app.on_event("startup")
async def startup():
    logger.info("Optihost started.")


@app.get("/health")
async def health():
    from services.database import AsyncSessionLocal
    from sqlalchemy import text
    try:
        async with AsyncSessionLocal() as db:
            row = await db.execute(text("SELECT version_num FROM alembic_version LIMIT 1"))
            version = row.scalar_one_or_none() or "unknown"
    except Exception:
        version = "unknown"
    return {"status": "ok", "hotel": settings.HOTEL_NAME, "schema_version": version}
