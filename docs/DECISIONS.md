# Decisions

This file records architectural decisions. Keep entries short, dated, and
append-only unless a decision is superseded.

## 2026-05-01: Local-First Before SaaS Hardening

Status: accepted

Decision: validate JobHunter as a reliable local product before building hosted
multi-tenant infrastructure.

Rationale:

- the automation loop is the core product risk
- local SQLite and local artifacts already exist
- hosted auth, billing, tenancy, object storage, and deployment would distract
  from proving the workflow

Consequences:

- local data remains in `~/.jobhunter`
- SaaS hardening belongs in `docs/BACKLOG.md`
- local safety and reliability tests gate near-term work

## 2026-05-01: TypeScript Product API, Python Workers

Status: accepted

Decision: use a TypeScript product API for frontend-facing local JSON contracts
and keep Python for automation workers.

Rationale:

- the frontend and product API benefit from shared TypeScript contracts
- Python already owns the automation implementation
- this avoids rewriting discovery, scoring, tailoring, PDF, and apply logic
  before the product is locally validated

Consequences:

- `services/api` owns the local TypeScript API
- `packages/contracts` owns shared DTOs and the typed client
- `src/jobhunter` remains the automation engine

## 2026-05-02: Fastify For The Local API

Status: accepted

Decision: use Fastify for the local TypeScript API.

Rationale:

- small local service surface
- fast startup
- straightforward route registration
- compatible with schema-first request/response validation

Consequences:

- do not introduce SaaS-scale framework structure yet
- revisit the framework only if hosted product modules require it

## 2026-05-02: React With Vite For The Frontend

Status: accepted

Decision: use React with Vite for the local web UI.

Rationale:

- existing UI complexity has outgrown generated Python strings
- React gives a cleaner path for dashboard, jobs, artifacts, profile, and style
  editing flows
- Vite keeps local development fast

Consequences:

- Node.js `>=20.19.0` is required
- `apps/web` owns the React app
- `npm test` must include web typecheck and build

## 2026-05-02: Loopback API Binding By Default

Status: accepted

Decision: the local TypeScript API refuses non-loopback bind hosts unless the
user explicitly opts in.

Rationale:

- the API exposes local job, profile, and artifact metadata
- CORS does not protect against non-browser clients on the same network

Consequences:

- default host is `127.0.0.1`
- remote bind requires `JOBHUNTER_API_ALLOW_REMOTE_BIND=1`

## 2026-05-02: Stage State Is The Operational Source Of Truth

Status: accepted

Decision: `job_stage_states` should drive UI/API truth, retries, next
actions, failure state, and blocked state.

Rationale:

- wide nullable columns made stage progress hard to inspect and retry
- per-stage state makes failures actionable
- legacy fields remain useful for migration and fallback

Consequences:

- read paths materialize and hydrate stage rows
- retry operations target one stage
- tests must cover legacy-to-explicit state parity

## 2026-05-03: Copyable Commands Stay, Buttons Use Structured Actions

Status: accepted

Decision: keep copyable CLI commands in the UI, but make primary action buttons
call structured local action endpoints.

Rationale:

- copyable commands are useful for transparency and manual debugging
- button behavior should not depend on shell parsing
- long-running actions need explicit action status

Consequences:

- local UI actions use TypeScript API action endpoints
- Python action wrappers return structured JSON-safe results
