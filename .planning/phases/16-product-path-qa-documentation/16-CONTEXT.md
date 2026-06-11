---
phase: 16-product-path-qa-documentation
status: ready_for_planning
created: 2026-06-11
---

# Phase 16 Context: Product-Path QA + Documentation

## Phase Boundary

Phase 16 verifies the v1.2 milestone from the user's product paths and records final acceptance evidence. It should not introduce new product features unless verification finds a blocking defect.

## Acceptance Scope

- Phase 13 shared apply-audit contract remains the source of truth for readiness, blockers, and eligibility.
- Phase 14 Jobs drawer proves ranking rationale, readiness, blockers, eligibility concerns, and Apply Review handoff.
- Phase 15 Apply Review proves rendered resume focus, claim pin/no-provenance states, source-to-tailored detail, grounding/risk labels, and full audit fallback.
- Documentation and QA checklists reflect the new behavior narrowly.

## Safety Boundaries

- Do not run auto-apply.
- Do not submit applications.
- Do not scan mailboxes.
- Do not regenerate or replace materials.
- Do not start worker-backed jobs.
- Do not expose profile data, resumes, PDFs, logs, SQLite contents, OAuth data, or secrets in committed artifacts.

