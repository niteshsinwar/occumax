from __future__ import annotations

import os
import secrets

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


MCP_SHARED_SECRET_ENV = "MCP_SHARED_SECRET"
MCP_ALLOW_UNAUTHENTICATED_ENV = "MCP_ALLOW_UNAUTHENTICATED"


def mcp_auth_enabled() -> bool:
    """Return whether MCP requests must provide an Authorization bearer token."""
    if os.getenv(MCP_ALLOW_UNAUTHENTICATED_ENV, "").lower() in {"1", "true", "yes"}:
        return False
    return True


def get_mcp_secret() -> str | None:
    return os.getenv(MCP_SHARED_SECRET_ENV)


class BearerTokenMiddleware:
    """
    Minimal ASGI bearer-token guard for the dedicated MCP process.

    This intentionally lives outside the main FastAPI app so the MCP package can
    stay isolated and be deployed as its own uvicorn process.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"} or not mcp_auth_enabled():
            await self.app(scope, receive, send)
            return

        expected = get_mcp_secret()
        if not expected:
            response = JSONResponse(
                status_code=503,
                content={
                    "error": "MCP_SHARED_SECRET is not configured",
                    "detail": "Set MCP_SHARED_SECRET or MCP_ALLOW_UNAUTHENTICATED=true for local-only testing.",
                },
            )
            await response(scope, receive, send)
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        auth = headers.get("authorization", "")
        prefix = "Bearer "
        supplied = auth[len(prefix):] if auth.startswith(prefix) else ""

        if not supplied or not secrets.compare_digest(supplied, expected):
            response = JSONResponse(
                status_code=401,
                content={"error": "Unauthorized MCP request"},
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)

