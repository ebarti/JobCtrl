---
phase: 20-canonical-read-model-realtime-api
type: research
status: active
---

# Phase 20 Research

## Codebase Findings

- `packages/contracts/src/schemas.ts` exposes `JobSummary` and `JobDetail`; compensation inspection endpoints already define `PostedCompensationFactResponse` and `MarketCompensationEstimateResponse`.
- `apps/api/src/read-model.ts` maps `job_list_projections` rows to `JobSummary` and detail rows to `JobDetail`. It currently maps only raw `salary`.
- `apps/api/src/projections.ts` owns the TypeScript projection refresh path and mirrors Python projection table schema.
- `workers/automation/src/jobhunter/domain/operations/projections.py`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, and `sqlite_projection_store.py` own the Python projection value objects, builder, and persistence.
- `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` and `sqlite_market_repository.py` persist canonical compensation rows but do not currently emit a compensation-specific job event.
- `apps/web/src/contexts/operations/invalidation-router.ts` has a typed handler map over `DomainEventUnion`; adding an event requires a fixture and handler parity update.

## Design Choice

Use three projection columns:

- `job_list_projections.compensation_summary_json`
- `job_detail_projections.compensation_summary_json`
- `job_detail_projections.compensation_audit_json`

The list projection gets only the compact summary. The detail projection gets both the same summary and a richer audit object. This keeps list payloads scannable while preserving drawer/API inspectability.

## Summary Shape

The summary should be state-first and compact:

- `legacyRawSalary`
- `posted.recordStatus`, `posted.parseState`, `posted.displayRange`, `posted.confidence`, `posted.warningCount`
- `market.recordStatus`, `market.estimateState`, `market.displayRange`, `market.confidenceBand`, `market.sourceCount`, `market.warningCount`
- `warningCount`

## Audit Shape

The audit object should embed separate posted and market response-shaped data:

- `posted: PostedCompensationFactResponse`
- `market: MarketCompensationEstimateResponse`

This reuses the existing safe API mappers and preserves the separation between employer-posted facts and benchmark-derived market estimates.

## Event Shape

Add `CompensationFactsUpdated` with only safe metadata:

- `jobId`
- `changedSections: ("posted" | "market")[]`
- `postedRecordStatus`
- `postedParseState`
- `marketRecordStatus`
- `marketEstimateState`
- `updatedAt`

The event intentionally excludes source text, raw salary excerpts, source snapshots, user compensation preferences, local paths, credentials, and raw provider payloads.

## Verification Focus

- Projection schema upgrades are idempotent.
- TS and Python builders output matching JSON for synthetic canonical rows.
- Existing raw salary remains unchanged.
- Job list/detail API includes structured compensation fields without changing sorting/filtering/readiness/apply dispatch.
- SSE invalidation routes compensation updates to job list/detail and activity.
- Event tests prove unsafe strings do not appear in payloads.
