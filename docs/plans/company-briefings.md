# Optional company briefings (#1016)

## Validation and bounded design

Validated against `c1d85951d33de1aea9d891f3a52cd824df4a0736` on 2026-10-17.
`SqliteEmployerAnalysisRepository` stores posting-scoped analyses;
`GenerateInterviewPrepUseCase` binds preparation to a job, profile and catalog;
`build_digest` and the web digest read local operational state. None owns a
reusable dated company briefing. Discovery's `Employer` is a name value object,
not a reviewed cross-job company identity. Issue #1016 and Project 7 still
carry proposal/Needs validation state; the current user request authorizes this
bounded implementation independently of that historical intake assessment.

Materials owns the optional artifact; Operations exposes it through existing
job detail, interview and digest reads. The first version uses explicit CLI
configuration and refresh, with read-only web presentation. It adds no digest,
scheduler, search engine, automatic job matching or application action.

- A user confirms each canonical JobId's link to an exact public company URL.
  A stable hash of that URL is the local company key. Names are never identity
  evidence; equal names do not merge companies. A changed saved employer name
  requires a new explicit link confirmation. Companies sharing a hostname can
  use distinct canonical URL paths.
- At most three explicitly selected public pages supply the briefing. One
  explicit refresh opts into anonymous public fetching, bounded requests,
  response bytes, text, redirects, timeouts and existing pacing/request-budget policy.
  No search queries, profile, mail, resume or authenticated browser data are
  inputs. Source URLs reject credentials, queries and fragments.
- A source-bound model determination separates company facts, reported events
  and hypotheses, with uncertainty and verbatim citations. It can require
  identity review instead of accepting ambiguous sources. Mechanical checks
  enforce the schema, source IDs and quotes; they do not decide meaning.
  Job-specific implications remain with role analysis and interview preparation;
  this reference artifact does not alter scoring, generated materials or approvals.
- Immutable accepted snapshots retain source/final URLs, observation times,
  text hashes, cited excerpts and the persisted determination ID/provider/model.
  Seven days is the displayed freshness window, not a factual guarantee.
  Source-configuration changes and failed refreshes are independently visible.
  Read paths never fetch or call a model.
- Existing exact-v14 indexed `job_events` can hold typed company identity,
  job-link, accepted-briefing and refresh-attempt records, following the existing
  revisioned screening ledger pattern. No database migration is needed.
  Acceptance is transactional, checks the current configuration/link revision,
  and preserves the previous accepted snapshot on fetch/model/save failure.
  A company-level lock coalesces simultaneous explicit refreshes; fresh accepted
  input is reused without fetching/spending. A failed attempt has no authority
  to advance the accepted observation clock.

## Verification boundary

Owned synthetic workspaces exercise actual CLI, SQLite and API reads; opposing
model verdicts prove model authority without grading prose. Check missing opt-in,
ambiguous identity, private destinations, bounded fetches, source binding,
provider/budget/schema failures, freshness, concurrent refresh/configuration,
transaction rollback, cross-job reuse and preservation of accepted artifacts.
Inspect rendered Job Detail, Interviews and the existing digest. Report live
provider or public transport proof separately from injected synthetic ports.
