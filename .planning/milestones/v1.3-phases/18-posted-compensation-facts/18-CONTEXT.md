---
phase: 18-posted-compensation-facts
status: discussed
created: 2026-06-19
autonomous: true
requirements:
  - COMP-01
  - COMP-02
  - COMP-03
  - COMP-04
  - COMP-05
depends_on:
  - 17-source-registry-access-policy
---

# Phase 18 Context: Posted Compensation Facts

## Goal

Users can inspect structured posted compensation facts derived from job posting salary text, including exact source text, normalized values when safe, confidence, warnings, and legacy raw fallback.

## Product Boundary

Phase 18 owns posted compensation facts only. It does not estimate market ranges, import Eurostat/INE data, compare against profile floors, change scoring/ranking/filtering/apply readiness, or build the final Jobs triage compensation UX.

Phase 20 owns adding compensation summaries to the canonical job list/detail read models and SSE invalidation. Phase 21 owns final Jobs list/drawer presentation. Phase 18 may expose a narrow read-only inspection API so facts are testable and inspectable before broader read-model propagation.

## Ubiquitous Language

- **Posted Compensation Fact**: A persisted value object derived from compensation text present in the job posting or legacy `jobs.salary` field.
- **Source Text**: The exact posting field/text excerpt used to derive the fact. It is bounded text, not the whole job description.
- **Raw Fallback**: The legacy raw salary string shown when no structured parse is available. It is not the normalized source of truth.
- **Parse State**: One of `missing`, `unparseable`, `ambiguous`, or `parsed_range`.
- **Compensation Component**: What the number represents, such as base salary, hourly wage, monthly wage, OTE, bonus, commission, equity, or unknown.
- **Compensation Period**: The cadence the amount applies to, such as hour, month, year, or unknown.
- **Annualization Assumption**: An explicit explanation required before an annualized value is populated.
- **Parse Warning**: A user-facing reason the fact should be treated carefully, such as missing currency, missing period, hourly conversion, OTE, bonus, commission, equity, broad range, one-sided range, or ambiguous numbers.

## Required User Outcomes

1. A user can tell whether a job has no posted salary, unparseable posted salary, ambiguous salary, or a parsed posted range.
2. A user can inspect the exact text that produced each posted compensation fact.
3. A user sees normalized currency, period, component, minimum, maximum, and annualized values only when assumptions are explicit.
4. A user sees confidence and warnings for hourly/monthly/OTE/bonus/commission/equity/broad/one-sided/missing-currency/missing-period cases.
5. A user still sees the legacy raw salary string when no structured fact exists.

## Architecture Decisions

- Model posted compensation as a distinct domain/read value, separate from market estimates and source registry policy.
- Additive only: keep `JobSummary.salary` and existing discovery storage behavior intact.
- Persist parsed facts in a canonical local table before exposing them through any UI-facing read model. Do not compute facts in React.
- Use deterministic parsing with explicit unsupported/ambiguous states; do not call LLMs or external services.
- Keep source text bounded and safe; do not store full descriptions or provider raw payloads in the fact table.
- Prefer a shared contract DTO with discriminated parse state so illegal combinations are avoided in API consumers.
- Use the existing Operations read path only if a web hook is needed for the inspection API; do not build final Jobs triage UI.

## Suggested Delivery Shape

### 18-01 Parser And Persistence

- Add shared posted compensation DTOs and parser value types.
- Add deterministic parser coverage for missing, unparseable, ambiguous, parsed range, hourly, monthly, annual, OTE, bonus, commission, equity, broad range, one-sided range, missing currency, and missing period.
- Add a canonical persistence table for per-job posted compensation facts.
- Backfill facts from existing `jobs.salary` without replacing or deleting that legacy string.

### 18-02 Read API And Inspection Contract

- Add a read-only API endpoint for posted compensation facts by job key or selected jobs.
- Add API/client/port support and tests if the endpoint is used by web tests.
- Document the inspection API and explicitly state that job list/detail projection propagation is Phase 20.

## Out Of Scope

- Market estimates from Eurostat, ESCO, INE, Levels.fyi, Glassdoor, or any other benchmark provider.
- Salary-based ranking, filtering, blockers, apply readiness, or auto-apply behavior.
- Profile-floor comparison.
- Final Jobs list/drawer compensation UX.
- User correction or refresh loop.
- External salary scraping or provider network calls.

## Validation Requirements

- Unit tests for parser state and warning coverage.
- Persistence tests proving raw fallback remains available and structured facts are persisted separately.
- API tests proving safe read-only inspection of posted facts.
- Regression tests proving no fit score, apply readiness, ranking, filtering, or apply mutation paths change.
- `git diff --check`.

## Safety Notes

- Do not run auto-apply, browser submission, mailbox scanning, material regeneration, destructive profile/database actions, or real external scraping.
- Use synthetic salary strings and local temp databases for tests.
