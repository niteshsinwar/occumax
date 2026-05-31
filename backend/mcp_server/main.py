from __future__ import annotations

import logging

from starlette.middleware import Middleware

from mcp_server.security import BearerTokenMiddleware
from mcp_server.tools import create_mcp

logging.basicConfig(level=logging.INFO)


_mcp = create_mcp()

# The dedicated MCP process serves Streamable HTTP at /mcp.
# Run with: uvicorn mcp_server.main:app --host 127.0.0.1 --port 8001
app = _mcp.http_app(
    path="/mcp",
    transport="http",
    middleware=[Middleware(BearerTokenMiddleware)],
)


if __name__ == "__main__":
    _mcp.run(transport="http", host="127.0.0.1", port=8001, path="/mcp")
