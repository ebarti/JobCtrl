# Resume Tailoring Contract

The accepted [transformation](../plans/2026-11-06-python-transformation.md)
replaces per-job writing and layered mandatory judges with composition from
user-approved wording. This is the **target under implementation**, not a
claim of integrated behavior or measured performance.

## Ownership and inputs

Profile owns the full authored baseline, facts, evidence, source attachments,
confirmations, preferences, wording text and user approval. Jobs supplies the
versioned posting. Requirements owns source-bound qualified meanings,
occurrences and equivalence decisions. Fit owns person/evidence qualification,
user corrections and recorded relations between requirements and approved
wording. Resumes consumes those public snapshots to compose and render a
document; it does not read the other features' private tables.

Requirements matches the complete incoming Skills/Professional Experience batch
against the entire active catalog in one source-bound determination.
Education and Languages remain direct job-local demands; they never enter
achievement-wording matching or authoring. The model determines qualified meaning,
equivalence, evidence support and wording coverage from cited sources; retrieval,
word overlap, regexes and hand-tuned prose thresholds cannot decide meaning or
prove novelty. Determinations carry source/version references and persisted
provenance and perform lane/spend preflight. Invalid, stale or unavailable
model results have no lexical fallback.

Profile's current wording, proposed revisions and retained approval history are
different records. Under the 11 November owner correction, one requirement on an
achievement uses one maintained current wording; another maintained expression
needs distinct coverage that cannot reuse or consolidate the current one.
Canonical requirement names label it. Exact user approval or a manual association
does not prove semantic coverage. The
[current-wording decision](../decisions.md#_2026-11-11-requirement-led-current-wording-and-proposed-revisions)
does not itself change the deterministic resume occurrence rule below.

## Deterministic composition

Resumes retains every approved baseline section, role and achievement, including
structured Language / Proficiency entries, and chooses exactly one approved
wording per achievement. Each eligible canonical requirement supplies one policy
point for distinct coverage, followed by complementary depth across achievements
and stable tie-breaking. There is no hidden brevity penalty or silent omission. An
unresolvable layout conflict is reported explicitly. The coverage manifest
records exact selected wording IDs and requirement relationships for the
assembled document.

The unit coefficient is composition policy, never importance metadata attributed
to the posting. Direct Education/Languages demands are outside achievement
wording selection. Tailoring changes only approved achievement wording and
preserves the other baseline sections through Plate and supported exports.

Resumes' public input snapshot includes the relevant maintained current-wording
pins and a job-scoped assignment fingerprint. It binds the job's canonical
requirement IDs, participating Profile achievement IDs and matching assignment
heads, including missing-to-present transitions. An unrelated requirement's
assignment change does not stale this composition. Tailored choices use those
maintained positive-coverage edges, with the authored baseline fallback where
applicable. Earlier approved wording remains history and remains valid for an
already accepted document whose exact bindings are unchanged. A new current
assignment cannot rewrite that document, omit a baseline achievement or add an
extra occurrence of the same achievement.

`composition_freshness` is a pure list/detail projection over the selected
Profile/Requirements/Fit pins and assignment fingerprint. It reports explicit
stale reasons without replacing either draft or accepted pointer. Baseline
currentness still checks Profile but skips Fit/Requirements coverage. Source
freshness, exact approval, mechanical document validity and user acceptance
remain separate facts; no freshness read schedules preparation.

Person fit describes the person and stays separate from document coverage.
Missing approved wording cannot lower factual qualification. A new supported
requirement can prompt a grounded wording proposal, but Profile owns the
proposal and only the user may approve it. Known requirements reuse recorded
decisions; rejected or deferred proposals are not regenerated for every job.
A current section-backed match creates no achievement-wording gap. Existing
approved wording is reused; a new proposal requires an actual unsupported
expression need and factual achievement support. Stylistic variation cannot
justify rewriting already covered content.

## Review and acceptance

Exact approved wording, source identity, revision and structural checks are
mechanical and mandatory. One simple model coherence review of the assembled
resume is advisory; it does not rescore the person or start recursive
repair/polish loops. The user may explicitly accept a mechanically valid,
source-bound document despite a review finding or timeout. Review status,
findings and acceptance are distinct records, so an override never claims that
review passed. A failed or canceled refresh, model call, render or export
preserves the last accepted artifact and its bytes.
Legacy-generation requirement or Fit records cannot establish current
composition readiness. Historical accepted artifacts retain their original
bindings and bytes while a successful explicit refresh establishes current
authority; an ordinary read cannot refresh or replace them.

Baseline-copy/off mode remains available and makes zero resume model calls.
Rendering, editing, review, acceptance and locale export belong to Resumes.
The [materials reference](materials.md) covers provenance and other material
owners; [locale variants](material-locale-variants.md) covers translation.

## Local Application Boundary

HTTP, CLI and durable workers invoke the same Python feature application
services. Feature routes, stores and actions remain under implementation. No
Fastify business writer or JSON-RPC forwarding bridge remains at cutover.

<a id="attempt-loop-and-candidate-selection"></a>
<a id="bounded-persona-diagnostics"></a>
<a id="validation-layers"></a>
The earlier mandatory attempt loop, persona diagnostics and multi-stage judge
are superseded by deterministic composition, mechanical fences and the single
advisory review described above.

## Outreach Draft Gates (Reused Materials Stack)

Outreach is a separate owner. Draft generation or review does not authorize a
send. It must bind its determination to canonical source snapshots, preserve
approved content on failed refresh and require current explicit authorization
for an external action. No particular shared legacy materials implementation is
required.

## Outreach Publication Boundary

Before publishing or approving a draft, Outreach rechecks the exact canonical
inputs and expected revision. A conflicting save or changed source prevents a
stale proposal from replacing the accepted draft. An uncertain external send
is recorded honestly and must not be automatically repeated. See
[security](../developer/security.md) and the
[feature ownership map](domain-model/strategic.md).

## Verification

Proof requires the actual application, API, SQLite, worker and renderer with
controlled external provider/model boundaries and owned synthetic state. Check
complete baseline retention, stable selection, source and approval conflicts,
person-fit independence from wording gaps, review overrides, zero-call off
mode and last-accepted preservation. Completion awaits integrated E2E evidence.
