---
phase: 20-canonical-read-model-realtime-api
type: patterns
status: active
---

# Phase 20 Patterns

## Projection Ownership

- Projection builders own JSON shape construction.
- API read-model code deserializes projection JSON and returns `null` on corrupt or absent JSON.
- React must not parse salary text or reconstruct audit facts.
- Python and TypeScript projection builders must stay schema-compatible.

## Contract Style

- Additive fields only.
- Keep discriminated unions precise; range fields belong only to range states.
- Preserve `JobSummary.salary` as a raw string.
- Name posted facts and market estimates separately in every object.

## Safe Data

Allowed in projection/API:

- parse or estimate state
- normalized amounts/currency/period/component when already canonical
- warning/reason codes and safe messages
- bounded posted source excerpts already accepted by Phase 18
- public source metadata already accepted by Phase 19

Not allowed in event payloads, fixtures, logs, or docs:

- profile compensation preferences
- raw benchmark pages
- credentials or provider tokens
- local filesystem paths
- private account/provider payloads
- Glassdoor or Levels.fyi salary observations
- U.S. salary-source data

## Realtime Pattern

- Python compensation repositories persist facts and emit `CompensationFactsUpdated`.
- `job_events` remains the durable SSE source.
- Operations invalidation handler invalidates `jobsKeys.lists(tenantId)` and `jobsKeys.detail(tenantId, jobId)`.
- Activity invalidation is added automatically by the router for non-apply-run events.

## Test Pattern

- Add focused unit/parity tests beside touched surfaces.
- Use synthetic jobs and synthetic public aggregate fixtures only.
- Keep browser/product-path QA for Phase 21 and Phase 22 unless Phase 20 touches visible UI.
