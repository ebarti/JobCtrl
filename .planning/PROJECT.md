# JobHunter — Grounded Resume Tailoring

## What This Is

JobHunter is a local-first job-search automation app (TypeScript API + React/Vite web + Python Temporal worker) that runs a discovery → enrichment → scoring → tailoring → cover → apply pipeline over local SQLite and generated artifacts. This milestone makes **resume tailoring** the product's flagship feature: every tailored resume is deeply reasoned about the target job, grounded in canonical profile evidence, governed by explicit tailoring rules, written in an authentic human voice, and fully inspectable bullet-by-bullet inside the app.

## Core Value

A user can trust every line of a tailored resume — because each bullet traces, visibly, to a real profile fact *and* a specific job requirement, with the reasoning and the transform rule that produced it on display.

## Requirements

### Validated

<!-- Inferred from existing codebase (.planning/codebase/) — shipped and relied upon. -->

- ✓ Discovery pipeline scrapes jobs from external boards (python-jobspy) — existing
- ✓ Enrichment verifies and snapshots postings — existing
- ✓ Scoring evaluates job fit with LLM + scoring policy — existing
- ✓ Resume tailoring stage (`tailor`) generates resume artifacts + audit evidence via the Materials context — existing
- ✓ Cover-letter generation stage (`cover`) — existing
- ✓ Apply stage runs browser/agent submission automation — existing
- ✓ JSON-RPC tailoring actions: `tailor_job`, `retailor_job`, `retailor_current_policy` — existing
- ✓ Tailoring rationale surfaced in the UI (PR #139) — existing, but insufficient
- ✓ PDF rendering of generated materials (LaTeX + Playwright HTML paths) — existing
- ✓ Projection-backed read model, SSE realtime, audit/event backbone (`job_events`) — existing
- ✓ Profile import + canonical profile data store — existing
- ✓ Materials / apply-review / artifacts web surfaces — existing

### Active

<!-- This milestone's scope. Hypotheses until shipped and validated. -->

**Pillar A — Deep job/employer understanding (first-class, inspectable stage)**

- [ ] A dedicated job-analysis step reasons about the role from the *employer's* perspective and produces a structured "ideal candidate" understanding (what the role actually is, what the employer is looking for)
- [ ] The analysis distinguishes must-have vs nice-to-have requirements and captures priorities/weighting
- [ ] Keyword identification is **reasoned and reproducible** — replacing today's flakey, random extraction — with each keyword tied to evidence in the job description
- [ ] The employer analysis is **persisted** and exposed as an inspectable artifact that drives all downstream tailoring

**Pillar B — Grounded tailoring with per-bullet provenance**

- [ ] Tailoring decisions are anchored to **both** canonical profile evidence and specific job requirements
- [ ] Every resume bullet records: the profile evidence it came from, the job requirement it serves, the transform type applied, and a human-readable rationale ("chose this because…, worded it like this because…")
- [ ] Provenance is persisted as canonical audit data (computed at generation time against the actual generated text), not inferred after the fact

**Pillar C — Granular tailoring controls**

- [ ] Tailoring is governed by explicit, finer-grained rules — e.g. rephrasing always allowed, invention permitted only for closely-related experience, never fabricate metrics/dates
- [ ] The governing rule/level is recorded **per decision** so the user can see what policy produced each bullet

**Pillar D — Human-authentic voice (explicit goal)**

- [ ] Output actively avoids the "reeks like AI" smell: de-buzzword, vary bullet structure, sound like a real person rather than generic LLM prose

**Pillar E — Inspector UI (this milestone)**

- [ ] The materials / apply-review surface exposes the employer analysis (requirements, priorities, reasoned keywords) in the app
- [ ] The surface shows per-bullet provenance so the user can see *why* the resume came out the way it did
- [ ] Inspection is wired through the existing contracts/projection/read-model/frontend boundaries (no UI masking of missing audit data)

### Out of Scope

<!-- Explicit boundaries with reasoning to prevent re-adding. -->

- Cover-letter tailoring overhaul — **deferred**; this milestone is resume-only. (The new employer analysis is shared upstream, so cover letters can adopt it in a later milestone.)
- Formal eval / quality-measurement harness (golden fixtures + scored rubrics) — **deferred this milestone by explicit choice.** Noted tension: it is the most direct cure for "inconsistent quality / flakey," so it remains the top candidate for the next milestone. Existing persona/judge scoring stays as the quality gate for now.
- Hosted/multi-tenant/auth changes — out of scope; remains local-first single-user.
- Other pipeline stages (discovery, enrichment, scoring, apply) — unchanged except where they must feed the new tailoring inputs.

## Context

- **Single-user, local-first.** Source of truth is local SQLite + generated artifacts under `~/.jobhunter`. Per project convention, migrations are rip-and-replace — the flakey keyword extraction can be **replaced outright**, with no compatibility shims or strangler paths to preserve.
- **Existing tailoring lives in the Materials bounded context** (Python `domain/materials/`, `materials/activities.py`, `infrastructure/materials/`), invoked via the `tailor` stage in `pipeline/runner.py` and the `tailor_job` / `retailor_*` JSON-RPC methods.
- **Auditability is a first-class repo discipline.** CLAUDE.md mandates that every displayed claim have an explicit source of truth, keyword coverage be computed against actual generated text, and re-tailor/retry must never destroy the current reviewable artifact. This milestone leans directly into that discipline.
- **Tech-debt to respect:** projection ownership is duplicated TS↔Python; legacy wide-table fallbacks exist; material artifact records can be synthesized from sibling files. New audit/provenance data must be canonical and DB-backed, not file-heuristic.
- **Cross-cutting change surface (per architecture map):** new data shapes touch `packages/contracts/`, `apps/api/` (read-model/projections/local-actions/RPC), Python `domain/materials` + `infrastructure/materials` + projections, and the web `materials`/`apply-review` contexts — kept in sync per the documented architecture rules.

## Constraints

- **Tech stack**: TypeScript (Fastify, better-sqlite3, Zod, React 19, Vite, TanStack Router/Query/Table/Form, Tailwind) + Python ≥3.11 (Typer, Temporal SDK, httpx, Playwright, pypdf) — Why: existing monorepo; no new runtime unless justified.
- **LLM-backed**: tailoring and the new job analysis are LLM-driven; default to the latest capable Claude models, keep provider selection explicit, mind latency/cost budgets (existing 180s client timeout).
- **Local-first boundaries**: loopback API, local-origin mutation guards, sensitive artifacts under `~/.jobhunter` — Why: never expose profile/resume/job data; never commit generated artifacts.
- **Architecture discipline**: follow DDD/hexagonal backend conventions and the frontend bounded-context/ports/invalidation conventions in CLAUDE.md and docs — Why: keep the architecture intact.
- **Audit integrity**: provenance/coverage must be computed at generation time against the real generated resume text and persisted canonically — Why: CLAUDE.md root-cause/auditability discipline forbids inferred or masked audit data.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Add a first-class, persisted, inspectable job/employer analysis stage | Shallow job understanding is the root cause of flakey keywords and generic output; fix it upstream | — Pending |
| Per-bullet provenance (evidence × requirement × transform × rationale) | "Grounded" and "inspectable" are the same thing — a visible decision trail | — Pending |
| Granular tailoring rules recorded per decision | User wants rephrase-vs-invent governed precisely and traceably | — Pending |
| Human-authentic voice as an explicit requirement | "Reeks like AI" must be targeted directly, not assumed away | — Pending |
| Build the inspector UI this milestone | Trust requires the user to *see* the reasoning in-app | — Pending |
| Resume only; defer cover letters + eval harness | Keep scope tight; eval harness is the planned next step | — Pending |
| Replace flakey keyword extraction outright (no shims) | Single-user, rip-and-replace project convention | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-08 after initialization*
