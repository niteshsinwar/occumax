import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from services.database import create_tables
from api import admin, dashboard, manager, receptionist, ai, pricing, analytics

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Occumax API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Starlette's CORSMiddleware does NOT attach CORS headers to unhandled 500 responses.
# This handler catches them before the middleware strips the headers.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "error": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"},
    )

app.include_router(dashboard.router)
app.include_router(manager.router)
app.include_router(pricing.router)
app.include_router(receptionist.router)
app.include_router(admin.router)
app.include_router(ai.router)
app.include_router(analytics.router)


@app.on_event("startup")
async def startup():
    await create_tables()
    logger.info("Occumax started — database tables verified.")


@app.get("/health")
async def health():
    return {"status": "ok", "hotel": settings.HOTEL_NAME}
