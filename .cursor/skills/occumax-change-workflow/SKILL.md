---
name: occumax-change-workflow
description: Project-only workflow for the Occumax monorepo (React/Vite/TypeScript/Tailwind, FastAPI/SQLAlchemy/async PostgreSQL, optional Gemini/LangGraph AI, Vercel). Use when the user requests code changes in this repository or when editing techspec.md. Do not treat as a global default for other workspaces.
---

# Occumax change workflow

## Scope

This skill lives under **`.cursor/skills/` in this repository** and applies **only to Occumax / this workspace**. Do not copy it to personal Cursor skills as a generic engineering default unless the user explicitly wants that for other projects.

## Before writing code

1. Read the repository root **`techspec.md`** for architecture, stack, paths, API surface, configuration, deployment, and contributor caveats. Treat it as the primary orientation doc; verify details in code when contracts or persistence change.
2. Infer the **minimal scope** that satisfies the ask. Prefer extending existing routers, controllers, services, and UI patterns over introducing new layers.

## Clarifying questions (required)

Before implementing non-trivial requests, ask enough **clarifying questions** that the following are explicit or safely defaulted:

- Expected behavior, inputs/outputs, and acceptance criteria (including error/empty states).
- Which surfaces are in scope (frontend only, backend only, API contract, DB shape, env vars, Vercel).
- Backward compatibility and migration expectations for existing data or clients.

**Stop condition**: Proceed only when the ask is unambiguous or the user has approved reasonable assumptions you stated explicitly.

If the request is already precise (single file, obvious bug, copy-paste error), a short confirmation is enough.

## Architecture and scope guardrails

- **Do not** make sweeping architectural changes (new frameworks, large folder moves, wholesale rewrites, broad abstraction renames) unless the user explicitly requests them.
- If an **architectural change** would materially improve the solution (new service boundary, schema strategy, deployment model, replacing a library), **outline the recommendation** with trade-offs, then **ask for confirmation** before implementing.
- Keep diffs **focused** on what the user asked for; avoid drive-by refactors.

## Stack reference (summary)

Full detail lives in **`techspec.md`**. At a glance:

- **Frontend**: `frontend/` — Vite, React 19, TypeScript, Tailwind, React Router; API via `frontend/src/api/client.ts`.
- **Backend**: `backend/` — FastAPI, SQLAlchemy 2 async, Pydantic settings, services under `backend/services/` (algorithm, AI, database).
- **Data**: PostgreSQL; startup/bootstrap behavior documented in `techspec.md`.
- **AI** (optional paths): Gemini via LangGraph/LangChain as described in `techspec.md`.
- **Deploy**: Vercel monorepo patterns in root `vercel.json` and `backend/vercel.json` (see `techspec.md`).

Match existing naming, imports, and layering in the touched area.

## After implementing a change

**Update `techspec.md`** in the same change set whenever the change alters anything contributors rely on, including:

- Repository layout, request path, or major file responsibilities.
- API routes, request/response shapes, or auth/CORS behavior.
- Data model, migrations/bootstrap strategy, or important DB caveats.
- Configuration keys, defaults, or environment variables.
- Local dev, testing, or deployment steps.
- Known product/implementation caveats called out in the spec.

**How to update**:

- Adjust the relevant numbered sections and tables so they stay accurate.
- For meaningful work, add a **short dated bullet** under **section 12 (Changelog)** (newest first), per the instructions already in `techspec.md` section 12.1.
- Do not let `techspec.md` contradict the code; prefer concise bullets over long prose.

Purely cosmetic or typo-only edits that do not affect contributor understanding may skip a changelog line, but the document must remain truthful.

## Verification

- Run or point to the tests/commands the project already uses (see `techspec.md` sections 8–9) when your change touches behavior.
- If you cannot run tests in the environment, say what should be run locally.
