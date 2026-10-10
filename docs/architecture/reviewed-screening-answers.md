# Reviewed Screening Answers

Materials owns source-bound answer drafting and immutable reviewed library
revisions. Apply owns application attempts, versioned question/context records,
review decisions and manual-use attestations. These owners are independent of
locale variants and use exact schema v14 without adding tables or a migration.

## Authorities and Persistence

`domain/materials/screening_answers.py` calls the existing determination service,
claim verifier and separate quality judge. `domain/apply/screening_answers.py`
owns lifecycle decisions. `infrastructure/materials/screening_answers.py` stores
append-only snapshots in the existing indexed `job_events` ledger:

| Entity kind | Identity and content |
| --- | --- |
| `screening_question` | Tenant + question ID; Job ID, distinct application-attempt ID, authored question/context, expected revision, draft/accepted identities, review/manual-use snapshots and exact source bindings |
| `screening_library` | Tenant + library revision ID; accepted origin question/snapshot/answer/review IDs and retained answer/source content, independent of the Job foreign key |
| `screening_failure` | Safe attempted action/question/revision/request-hash/failure-code receipts; no question revision advance or replacement |
| `screening_notification` | Safe `JobUpdated` reference notification; no answer or source text |

Every replacement compares `expectedRevision` inside a write transaction and
appends the accepted library record atomically with its application review.
Idempotency keys are hashed with the tenant; an identical retry returns its
recorded snapshot, while changed payloads are refused. No operation updates an
accepted source artifact or existing ledger revision. Failed model calls retain
blocked semantic-stage receipts and safe failed-attempt ledger receipts without replacing accepted content. An unwritable ledger cannot retain a failure receipt and never changes accepted state to do so. SQLite
errors, source changes and competing completions refuse the replacement.

Bindings retain the profile version/hash, exact version-scoped JSON-pointer fact
identities and values, explicit sensitive-field selection, posting/destination,
posting fingerprint, currently approved material identities/generations/metadata and file SHA-256 (failed candidates are not accepted sources),
and exact question/context/application identity. Sources are read from canonical
saved owners, not browser-submitted profile snapshots. Empty values are excluded;
compatibility-derived profile sections and arbitrary extra JSON are not separate
fact authorities. The canonical password field is excluded from selectable
screening evidence. Materials are bound but their file contents are not sent as
candidate evidence; only deliberately selected profile facts authorize claims.

Library entries retain their immutable originating review snapshot and join its recorded snapshot/answer IDs. If a Job deletion removes its event rows, that retained origin remains the historical authority. Current
and historical answer revisions join persisted determination IDs in the same
tenant and Apply lane, including replaced and rejected drafts.
Reads expose staleness while retaining old text/history, including when current
sources become unavailable. No read-side semantic computation or inferred prose
join supplies authority.

## Model and Review Fences

Drafting persists `screening_context` and `screening_draft` determinations,
followed by the existing `claim_verification` and `artifact_quality` owners.
Editing and reuse also require interpretation, claim verification and quality
judgment. The generator sees minimized selected facts, the exact question and
saved posting/destination context. Unknown sensitive values cannot become
assertions. Source instructions are untrusted data.

Reuse requires exact selected facts and consent, then an explicit model decision
on question meaning and all job-specific claims. Different/uncertain decisions
refuse reuse; there is no lexical similarity/equivalence algorithm. Current
source/version fences run before spend on each uncached call and again before
acceptance. The determination service caches identical inputs and retains
provider/model, lane, schema/prompt versions, input fingerprints, citations and
verdicts. Model diagnostic scores never gate the decision. Draft acceptance is
separate from human approval and from manual-use recording.

## Entry Points and Privacy

`screening_answers` is a registered synchronous Python RPC. The generated GET
and POST endpoint clients consume shared schemas; the API supplies mandatory
workspace/database identity and tenant, and validates returned job/question,
action and revision. CLI `screening read` and `screening write` call the same
owner. Job Detail and Apply Review compose `ScreeningAnswerLibrary` with existing
Operations detail reads, context-owned query/mutation hooks, targeted invalidation
and optimistic question-edit rollback. Screening query keys share the Job Detail
prefix so source-change events invalidate them. The existing `JobUpdated`
notification carries only screening revision references through the normal SSE
handler. Private ledger SSE payloads are reduced to safe references by the API;
general activity contains only event identity/message.

Copy re-reads current sources before using `ClipboardPort`. Local edited text is
kept in the existing context draft store through failures/navigation. Manual use
requires explicit attestation, stores actual used text and its reviewed-answer
identity, and labels a changed text as an unverified user statement. It never
promotes that text into the library, writes profile facts, grants Apply approval,
performs browser form entry or records an application-submitted outcome.

The user workflow is defined in [Screening Answers](../user/screening-answers.md).
