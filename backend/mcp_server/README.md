# Occumax Receptionist MCP

Self-contained MCP server for exposing receptionist booking tools to ChatGPT,
OpenAI agents, and other MCP clients.

## Local install

Use a separate environment from the main REST API if possible:

```bash
cd backend
python -m venv .venv-mcp
. .venv-mcp/bin/activate
pip install -r requirements.txt
pip install -r mcp_server/requirements-mcp.txt
```

## Run

```bash
cd backend
export MCP_SHARED_SECRET="replace-with-a-long-random-token"
uvicorn mcp_server.main:app --host 127.0.0.1 --port 8001
```

The MCP endpoint is:

```text
http://127.0.0.1:8001/mcp
```

On Oracle, route the public same-domain path to this process:

```text
https://<same-domain>/mcp -> http://127.0.0.1:8001/mcp
```

## Authentication

Every MCP request must include:

```text
Authorization: Bearer <MCP_SHARED_SECRET>
```

For local-only testing without auth:

```bash
export MCP_ALLOW_UNAUTHENTICATED=true
```

Do not use unauthenticated mode in production.

## Tool policy

Read tools may be used proactively. Write tools require `confirm_write=true`.

`confirm_split_stay` intentionally refuses mixed-category split confirmations in
MCP v1 because the current core controller persists one category for all split
segments. Mixed-category split stays can still be recommended through
`find_split_stay_flex`.

