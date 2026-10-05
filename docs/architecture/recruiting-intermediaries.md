# Recruiting Intermediaries

JobCtrl records where a posting was found and its reported employer, but the
inspected contracts do not separately record a publishing agency and its claimed
client. This investigation proposes an additive, evidence-bearing relationship
without changing job identity, application targets, or supervised actions.

**Read this if** you need to distinguish agency and direct employer postings or
scope a future implementation.

Owning investigation: [JobCtrl issue #953](https://github.com/ebarti/JobCtrl/issues/953).
This is a design deliverable, not an implemented capability or an issue closeout.
Source inspection and measurements use baseline
`67b4175aa2d9e8f96e62da545886b1e8712bf691` on 2026-10-05.
No external posting, provider, research fetch, outreach send or application was
exercised. Source links below pin that baseline.

## Current implementation

This section describes inspected code. Only executions in **Synthetic evidence**
are measured results; source inspection alone does not establish runtime QA.

| Existing owner | Inspected responsibility and boundary |
| --- | --- |
| [Source and Employer](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/value_objects.py) and [Job](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/aggregate.py) | `Source.board` is the posting platform; `Employer.name` is the reported hiring company and defaults to `Unknown`. Job identity is `(TenantId, JobId)`; posting URL is a locator. A scraped company label is a source-reported fact, not verified legal employer identity. |
| [ScrapedJobPosting](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/ports/discovery.py) | Carries board, employer, metadata, source registry/native IDs, canonical URL and applicant tracking system (ATS) kind. No separate publishing-intermediary or claimed-client field. |
| [DiscoverJobsUseCase](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/use_cases.py) | Checks canonical/native/observation ownership first. After a miss, invokes content matching only if the incoming employer passes the guard. Existing ownership adds observations and duplicate-link audit evidence; it does not create an agency–client relationship. |
| [SqliteJobRepository.find_content_owner](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_repository.py) | Stores `company` separately from `site`; absent company hydrates as `Unknown`, never from board or URL. Content candidates are tenant-scoped with normalized title/company equality, guarded on both employers. Compares listing and enriched descriptions, preserving `fingerprint` versus `shingle` basis. |
| [job_content_identity.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/job_content_identity.py) | Normalizes case, whitespace, Unicode and description formatting. Fingerprint hashes title, company and description; incomplete inputs return no key. Substantial matching uses five-token shingles, at least 80 tokens and Jaccard similarity ≥ 0.83; exact normalized descriptions also match. The employer guard excludes a finite set of sentinel/platform labels. Accepting a name does not verify a hiring employer. |
| [scorer.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/scoring/scorer.py) | Same-content score reuse includes company and caps normalized description at 6,000 characters. A separate reference-repost route selects an existing direct score by normalized title and nonempty location, without comparing company or description. Both reuse paths check criteria/profile versions. `_persist_reused_score` copies a score to the destination JobId; it does not merge jobs or persist a client relationship. |
| [ExtractionResult](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/enrichment/services.py) and [enrichment repository](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/enrichment/sqlite_repository.py) | Extraction returns success, full description and best-effort application URL; no intermediary/client/contact relationship fields. The repository persists application URL in `job_enrichments` and retains a lookup alias in `job_application_locators`. |
| [ManualCaptureProvenance](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/source_registry.py) and [PostingContentSnapshot](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/enrichment/snapshot_value_objects.py) | Manual provenance retains originating URL, time, mode and capture-tool metadata; `capture_client` means the capture tool, not a hiring client. Posting snapshots retain source ID, extraction tier, description hash, apply URL, capture time and evidence strings; they do not carry a full-description field. These are potential evidence anchors, not relationship records. |
| [build_jd_snapshot / AnalyzeJobUseCase](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/materials/analyze_use_case.py) and [EmployerAnalysis](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/materials/analysis.py) | Analysis consumes title plus full description (listing fallback), verbatim and uncapped, hashes that snapshot and validates evidence spans before saving a generation. It describes posting requirements for scoring/tailoring; its name does not establish an agency–client relationship. A failed refresh does not become a new accepted analysis. |
| [Contact aggregate](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/contact/aggregate.py) and [contact value objects](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/contact/value_objects.py) | Tenant-owned Contact links to an employer and/or JobId, with roles including recruiter. Each attribute requires provenance: source kind/reference, capture method/time, confidence and user confirmation. Attribute values are sensitive canonical contact data. Employer string/recruiter role does not establish a client relationship. |
| [ContactResearchSourcePolicy](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/contact/source_policy.py) | Allows user entry/import and opted-in unauthenticated public pages. Default public access is denied; protected URLs route to manual capture; local/private literal targets and unmodeled categories are rejected. Bypass, authentication and autonomous broad discovery are constrained. Policy authorization does not prove an actual fetch. |
| [Python contact projections](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py) and [TypeScript projections](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/projections.ts) | Both contact rebuild functions scope queries to a tenant and carry employer/JobId, role, counts and provenance without attribute values. Cross-runtime parity execution remains pending below. |
| [API contacts](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/contacts.ts) and [routes](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/server.ts) | List/detail reads use projections and tenant-filtered canonical attribute reads. `getContactDetail` returns attribute values with provenance; summary display names read canonical attributes. Value-free projections/events do not mean value-free API responses. API uses the local tenant constant; future relationships must not introduce cross-tenant joins. |
| [API outreach](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/outreach.ts) and [draft gates](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/contact/outreach_gates.py) | Approval requires a candidate draft and persisted passing gates. Rejection preserves an approved draft. `logOutreachSend` records a user-asserted send only over an approved draft; it opens no transport. Accepting a relationship must not approve a draft or create a send log. |
| [Application feedback/review](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/application-feedback.ts) | Approval checks bind materials generation, profile version and current target URL. Target reads join canonical enrichment by tenant/JobId with existing posting-URL fallback. Preserve [application URL authority](application-url-authority.md); relationship evidence is not a target authority. |

### Observed gaps and implications

An agency can occupy the reported employer field even when a client is the
actual hiring organization. The negative label-list guard accepts a synthetic
agency. Agency versus client names produce different fingerprints even with
identical title/description, and the SQL company filter prevents content matching.
Keeping those source facts distinct is compatible with current behavior, but it
provides no structured way to show who claims to recruit for whom.

The reference-repost predicate strips a narrow trailing code such as ` - SYN123`,
requires at least three title tokens and matching nonempty normalized location,
and strips trailing `(Remote)`/`(Hybrid)` location markers. Source inspection of
`_is_reference_repost_candidate` also requires no existing application target and
no recognized ATS identity on the repost. `_preferred_direct_score_for_repost`
searches other nondeleted jobs in the same tenant with a target or recognized ATS,
orders recognized ATS first then newest score, and returns the first matching
score whose criteria/profile versions agree. Company and rewritten description
are not checked. Two different clients with the same role and city both pass the
isolated predicate. This is an ambiguity in heuristic score consistency, not
proof of equivalence, client identity, representation rights or a dedup link.
The complete selector, score persistence and ambiguous multi-candidate execution
were not run at this checkpoint.

Neither the inspected posting DTO nor extraction result contains a relationship
observation, confidential-client status or conflict-resolution record. Contact
and posting provenance provide useful seams. Do not synthesize relationships
from a score, title, location, source domain or contact employer.

## Synthetic evidence

All labels and URLs below are synthetic. The probe writes only an in-memory
SQLite fixture, reads repository source and prints safe results. It makes no
network requests. Run from the repository root with Python 3.11 or newer.
Measured interpreter: CPython 3.14.7; Node checks used 26.9.0.

### Reproducible intake, SQL and contact probe

```bash
uv --project workers/automation run --locked --all-extras --no-sync python - <<'PY'
import ast
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path('workers/automation/src').resolve()))
from jobctrl.domain import job_content_identity as identity
from jobctrl.domain.contact.source_policy import ContactResearchSourcePolicy
from jobctrl.domain.contact.value_objects import ContactAttribute, ContactFactProvenance
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.ports.discovery import ContentOwnerMatch

root = Path('workers/automation/src/jobctrl')
env = dict(vars(identity), JobId=JobId, ContentOwnerMatch=ContentOwnerMatch)

def isolated(path, name, owner=None):
    tree = ast.parse(path.read_text())
    nodes = tree.body
    if owner:
        nodes = next(n for n in nodes if isinstance(n, ast.ClassDef) and n.name == owner).body
    node = next(n for n in nodes if isinstance(n, ast.FunctionDef) and n.name == name)
    future = ast.parse('from __future__ import annotations').body[0]
    exec(compile(ast.Module(body=[future, node], type_ignores=[]), str(path), 'exec'), env)
    return env[name]

fingerprint = identity.job_content_fingerprint
base = dict(title='Head of Platform Engineering', company='Client Alpha',
            description='Build reliable platform services with Python.')
print('fingerprint normalized:', fingerprint(**base) == fingerprint(
    title=' HEAD OF PLATFORM ENGINEERING ', company='client alpha',
    description='**Build** reliable platform services with Python.'))
print('fingerprint agency/client:', fingerprint(**base) == fingerprint(
    **dict(base, company='Synthetic Agency')))
labels = ['Unknown', 'LinkedIn', 'Workday', 'User-mediated capture', 'Synthetic Agency']
print('employer guard:', [identity.is_genuine_employer_identity(x) for x in labels])
same = isolated(root / 'scoring/scorer.py', '_same_reference_repost_opportunity')
repost = dict(title=base['title'] + ' - SYN123', company='Synthetic Agency',
              location='Test City (Remote)', description='Rewritten agency copy')
direct = dict(base, location='Test City')
print('predicate clients Alpha/Beta:', [same(repost, dict(direct, company=c))
                                      for c in ['Client Alpha', 'Client Beta']])
print('predicate other location:', same(repost, dict(direct, location='Other City')))
print('predicate no suffix:', same(dict(repost, title=base['title']), direct))

# The actual SQL method on a reduced in-memory fixture, not runtime admission.
find = isolated(root / 'infrastructure/discovery/sqlite_repository.py',
                'find_content_owner', owner='SqliteJobRepository')
conn = sqlite3.connect(':memory:')
conn.row_factory = sqlite3.Row
conn.executescript('''
CREATE TABLE jobs (tenant_id TEXT, job_id TEXT, url TEXT, title TEXT,
 company TEXT, description TEXT, full_description TEXT, discovered_at TEXT, site TEXT);
CREATE TABLE job_enrichments (tenant_id TEXT, job_id TEXT, full_description TEXT);
CREATE TABLE jobctrl_deleted_jobs (tenant_id TEXT, job_id TEXT, restored_at TEXT, deleted_at TEXT);
''')
owner_id = '00000000-0000-4000-8000-000000000001'
conn.execute('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
             ('synthetic-a', owner_id, 'https://board.example/jobs/1', base['title'],
              base['company'], base['description'], None, '2026-10-05', 'LinkedIn'))
repo = SimpleNamespace(_conn=conn)
def match(tenant='synthetic-a', company=base['company']):
    return find(repo, tenant, title=base['title'], company=company,
                description=base['description'])
print('SQL same employer:', match().basis, match().job_id == owner_id)
print('SQL different employer:', match(company='Client Beta'))
print('SQL agency employer:', match(company='Synthetic Agency'))
print('SQL other tenant:', match(tenant='synthetic-b'))
print('SQL fallback labels:', [match(company=c) for c in labels[:4]])
conn.execute('INSERT INTO job_enrichments VALUES (?, ?, ?)',
             ('synthetic-a', owner_id, 'Expanded detail. ' + base['description']))
print('SQL enriched owner/listing:', match().basis)
conn.close()

try:
    ContactAttribute('attr-1', 'note', 'synthetic value', None)
except ValueError:
    print('contact missing provenance: ValueError')
provenance = ContactFactProvenance('user_entered', 'synthetic:note-1',
                                 captured_at='2026-10-05T00:00:00Z', user_confirmed=True)
print('contact provenance:', sorted(provenance.to_dict()))
for category, url, domains in [
    ('public_web_page', 'https://agency.example/team', ()),
    ('public_web_page', 'https://agency.example/team', ('agency.example',)),
    ('public_web_page', 'https://agency.example/login', ('agency.example',)),
    ('public_web_page', 'http://127.0.0.1/team', ('127.0.0.1',)),
    ('account_scraping', 'https://agency.example/team', ('agency.example',)),
    ('user_entered', '', ()), ('user_imported_list', '', ()),
]:
    verdict = ContactResearchSourcePolicy(domain_allowlist=domains).authorize(category=category, url=url)
    print('source policy:', category, url or '(no URL)', verdict.value)
PY
```

This executes actual domain identity/contact policy classes. It extracts the
scorer predicate and repository SQL method through the abstract syntax tree
(AST), preserving their bodies, to avoid importing unavailable infrastructure
dependencies. The SQL method receives a reduced three-table fixture and an object
carrying its connection. This is not full Discovery execution, exact-schema
runtime admission, migration proof, full scoring, contact projection execution
or permission to research these URLs. Seeded `site = LinkedIn` does not enter
the SQL employer key.

Observed stdout (exit 0):

```text
fingerprint normalized: True
fingerprint agency/client: False
employer guard: [False, False, False, False, True]
predicate clients Alpha/Beta: [True, True]
predicate other location: False
predicate no suffix: False
SQL same employer: fingerprint True
SQL different employer: None
SQL agency employer: None
SQL other tenant: None
SQL fallback labels: [None, None, None, None]
SQL enriched owner/listing: fingerprint
contact missing provenance: ValueError
contact provenance: ['capture_method', 'captured_at', 'confidence', 'source_kind', 'source_ref', 'user_confirmed']
source policy: public_web_page https://agency.example/team rejected
source policy: public_web_page https://agency.example/team allowed
source policy: public_web_page https://agency.example/login manual_capture_required
source policy: public_web_page http://127.0.0.1/team rejected
source policy: account_scraping https://agency.example/team rejected
source policy: user_entered (no URL) allowed
source policy: user_imported_list (no URL) allowed
```

SQL results demonstrate same-employer content-owner lookup across a synthetic
board locator, separation for another employer/agency, tenant isolation,
fallback-label rejection and continued listing matching after enrichment.
They do not measure job merging, observation persistence or event counts.
Policy results are decisions only: entry/import do not fetch, and an allowed
public URL was not fetched. The provenance probe checks the mandatory object and
serialized fields; it does not prove every producer scrubs source references.

### Locked fixtures: inspected, execution pending

These are existing synthetic test assertions, **not observed passing results**.
They define broader reproduction after controller dependency preparation. No
fixture was redirected at personal state.

| Inspected owner | Required cases and assertions |
| --- | --- |
| [test_discovery_identity.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_identity.py) | `collapses_jobspy_job_rediscovered_by_canonical_source`: one Job, two source observations, fingerprint link confidence 0.95. `collapses_reworded_cross_source_description` and `matches_fresh_listing_against_enriched_owner`: same-employer matching. `does_not_merge_distinct_employers_behind_manual_capture_board` and `does_not_merge_distinct_employers_behind_workday_fallback_board`: two jobs, no duplicate link despite shared board/boilerplate. Native precedence/divergent descriptions also have cases. Names omit the common `test_discover_jobs_use_case_` prefix. |
| [test_scorer.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_scorer.py) | `test_score_job_by_url_reuses_direct_score_for_reference_repost` (parameterized recovery) and `test_run_scoring_reuses_direct_score_for_reference_repost_without_llm`: differing reported employers and rewritten descriptions; assertions expect direct score 9, zero scripted LLM calls and success/stage evidence. Same-content reuse and failed-analysis refresh cases are also present. These assertions do not verify a client relationship. |
| [test_contact_provenance.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_contact_provenance.py) | Required source reference, source-kind/capture-method allowlists and serialized provenance. |
| [test_contact_research_source_policy.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_contact_research_source_policy.py) | Default denial, opt-in public source, protected/manual capture, private/local target rejection, authentication/bypass constraints, entry/import without fetch and availability. |
| [test_contact_projection_parity.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_contact_projection_parity.py) | Loads [contact_projection_parity.json](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/packages/domain-types/test/fixtures/contact_projection_parity.json) into an in-memory exact-v7 compatibility schema, rebuilds two tenants and excludes sensitive attribute values. This historical fixture is not proof of current-runtime schema admission. |

Attempted from the repository root:

```bash
qa_dir=$(mktemp -d /tmp/jobctrl-953-qa.XXXXXX)
uv --project workers/automation run --locked --all-extras --no-sync pytest -q \
  workers/automation/tests/test_discovery_identity.py \
  workers/automation/tests/test_scorer.py \
  workers/automation/tests/test_contact_provenance.py \
  workers/automation/tests/test_contact_research_source_policy.py \
  workers/automation/tests/test_contact_projection_parity.py \
  --junitxml="$qa_dir/focused.xml"
```

`--no-sync` respects this role's dependency-preparation boundary. Exit 2:
`Failed to spawn: pytest` / `No such file or directory`. Zero pytest cases
executed; no focused JUnit report was produced. Controller-owned locked preparation
and rerun remain pending; the smaller probe is supplemental evidence.

## Future architecture, not implemented

### Minimal compatible contract

Introduce optional relationship observations owned by Discovery, scoped to
`(TenantId, JobId)`, with existing source-observation/snapshot evidence anchors.
Absence means no relationship information; backfill must not infer relationships.
Do not create a global organization/contact directory or a second job identity.
The following names describe proposed semantics, not shipped fields.

| Distinct role | Proposed representation |
| --- | --- |
| Posting source | Existing registry ID, `Source.board`, native ID and posting locator stay authoritative for acquisition. A platform hosting an agency advert remains a source. |
| Publishing intermediary | Optional organization label/domain explicitly reported in captured content or user entry, with literal claim and evidence anchor. Multiple intermediary observations are allowed; domain alone does not prove agency status. |
| Claimed hiring/client employer | Optional organization label and role `hiring_employer`, `client` or `unknown`. Distinguish `undisclosed` from missing/failed extraction. A staffing firm can be publisher and actual hiring employer; no client is required. |
| Recruiter contact | Optional same-tenant ContactId, independently confirmed through Contact & Outreach. Keep personal values as canonical contact attributes; do not copy names, emails, phones or private notes into job projections/events. |

Each observation needs a stable ID, tenant/JobId, source observation and/or
snapshot reference, safe source reference, capture time/method, literal supporting
span or restricted canonical evidence reference, claimed roles, confidence and
explicit confirmation record. Preserve manual-capture provenance; distinguish
source disclosure from user confirmation. Sensitive spans stay on restricted
canonical evidence paths, not telemetry/events/public exports. Project only safe
organization/status metadata and opaque references. URLs may contain private
tokens and require privacy handling even when used as evidence references.
Evidence references must locate retained supporting text: a snapshot hash alone
cannot ground a client claim. If the text is unavailable, keep the relationship
unknown rather than inventing a quotation or treating extraction confidence as proof.

### Relationship status and lifecycle

Keep claim status separate from client disclosure:

| Proposed status | Meaning and transition |
| --- | --- |
| `unknown` | No supported relation or client identity. Keep null identity; disclosure is separately `undisclosed`, `disclosed` or `not_stated`. |
| `proposed` | Captured statement or explicit user assertion proposes a relation. Extraction confidence alone cannot confirm it; even confident source prose starts here. |
| `confirmed` | User deliberately accepts the precise claim and evidence version. This is acceptance, not independent verification of a legal/exclusive mandate. An undisclosed-client relation still has null client identity. |
| `conflicting` | Retain incompatible claims about the same asserted relationship for review. Do not choose by latest capture, model confidence, domain or score similarity. |

Different intermediaries or roles are not automatically conflicts. One agency
may describe many opportunities. Contradictory client identities for one asserted
relationship remain competing claims. Amendments/rejections retain audit history
and supersession/rejection metadata. Refresh adds a candidate observation rather
than editing an accepted one. Confirmation binds its evidence version, rejecting
stale concurrent decisions. Failed capture, extraction, validation or persistence
preserves the last accepted relationship and materials; retain failure history
separately. Changing a claim requires a new explicit decision.

### Compatibility and sensitive-data boundaries

Preserve `Employer.name`/`jobs.company` as the existing reported fact. Expose
roles additively, without reinterpreting historical values, changing canonical
identity, merging JobIds, collapsing intermediary postings, retargeting
applications or creating locators from client domains. Current Discovery matching
stays unchanged in the minimal follow-up. Any repair of ambiguous repost scoring
needs a separate contract/regression proof; score reuse is never client evidence.

Tenant/JobId ownership applies to writes, foreign keys, lookups, projections,
confirmation and optional contacts. Reject references owned by another tenant/job.
Do not globally correlate labels or infer recruiter membership from email domains.
Future relationship data must participate in existing supervised retention/purge
handling; this investigation performs no destructive operation.

Preserve accepted enrichment, analysis and materials versions, and all profile,
materials-generation and target-URL approval bindings. Relationship confirmation
does not set an application target, research a contact, grant submission approval,
approve outreach, mark a send or schedule an action. Research retains explicit
supervised source policy; outreach retains truthfulness gates, deliberate approval
and user send logging. Client claims must not become applicant/resume facts or
ungrounded generated prose. Before using relationship evidence in a future prompt,
define its authority and validation separately from the verbatim JD snapshot.

### Assumptions and design decisions

The frozen scope treats #953 as investigation/design, not automatic agency
detection or production support. An additive observation is the smallest seam
that preserves current facts and exposes disagreements. Unknown/undisclosed
clients remain unknown; confirmation means user acceptance of a claim. Evidence
is per posting, not a universal/exclusive agency–client association. Organization
resolution, legal-employer verification, cross-post opportunity grouping and
market-wide agency research are deferred. No client guess is needed for this design.

### Future acceptance cases

These are follow-up implementation gates, **not executed feature cases**.

| Scenario | Required future result |
| --- | --- |
| Direct employer | Preserve source/company/JobId/target. Publisher and hiring-employer may be the same organization; fabricate no intermediary. |
| Disclosed agency client | Preserve publisher and literal client claim/evidence; start proposed and require confirmation. No company rewrite or target change. |
| Confidential client | Intermediary plus `undisclosed` client, null identity and explicit claim status. No inference from title, city, industry, score or website. |
| Staffing firm as employer | Publisher and hiring-employer can identify the firm. Work-site client must not automatically replace legal/reported employer. |
| Multiple intermediaries | Retain claims/sources separately. JobIds remain distinct unless existing identity rules independently resolve ownership; no relationship-based merge. |
| Conflicting client claims | Preserve competing versions, mark the asserted relationship conflicting; user resolution retains history. Refresh never silently chooses a winner. |
| Same title/city, different or unknown clients | No identity/equivalence inference from repost matching; score reuse remains a scoring heuristic. Any scorer repair needs separate multi-candidate tests. |
| Unknown employer / fallback board | Preserve existing Unknown/platform guard behavior; absent evidence cannot create client/employer identity. |
| Cross-tenant references | Reject another tenant's job/contact/evidence. Qualify keys and confirmation lookups; matching labels cannot leak readback. |
| Failed / concurrent refresh | Preserve accepted relationships/materials; retain candidate/failure history. Confirm only the precise claim/evidence version. |
| Privacy | Canonical detail access follows existing boundaries; events/projections/telemetry omit contact values, sensitive spans and URL tokens. |
| Submission / outreach gates | Acceptance changes no URL, approval binding, draft gate or send log. Research, submission approval, outreach approval and send logging stay separate. |

### Follow-up implementation scope

Deliver implementation in a separate issue/PR; do not close #953 as a shipped
feature. The inspected source owners above define these seams:

| Owner | Required work and tests |
| --- | --- |
| Discovery aggregate/ports/repository | Optional typed observations, confirmation/conflict invariants and tenant/job/evidence foreign keys. Absent/direct/agency/staffing/multiple/conflict tests plus unchanged dedup regressions. |
| Enrichment/capture | Explicit grounded claim extraction with disclosed/undisclosed/absent distinctions, literal-span validation, stale confirmation and failed-refresh preservation. No autonomous research or target-authority change. |
| SQLite migration and retention | Additive versioned migration preserving companies, identities, targets and artifacts; owned graph retention, rollback/recovery and tenant tests. Historical v7 parity is not current migration proof. |
| Contact & Outreach | Same-tenant contact references/provenance without value copying. Regress research default denial, protected/manual capture, truthfulness, approval, rejected-refresh preservation and manual send logs. |
| TypeScript API/shared contracts and both projection builders | Optional compatible read/write fields, absent-field compatibility, value omission, tenant parity, conflicts and evidence-version confirmation. |
| Job detail/review UI | Distinct reported employer, publisher, claimed client and evidence/status; supervised confirmation. Desktop/mobile/accessibility and failed-refresh cases; update owning user/API/architecture docs when shipped. |
| Scoring/Materials | Regress company identity, repost context versions and unchanged score/analysis inputs. Future relationship consumption requires separately reviewed authority/grounding, not score-driven client inference. |

Only this document changes. Shared navigation, production contracts, migration
versions, source policy and feature behavior are unchanged.

## Verification checkpoint and remaining gates

| Check | Observed result |
| --- | --- |
| Probe above | Exit 0 with recorded synthetic stdout. AST-isolated SQL/predicate limits apply. |
| Configured scripts recipe | Exit 1. JUnit records 86 entries: 81 passing, five failing, zero skipped. One failure lacked pinned `brace-expansion`; four distribution files failed import because `ajv` was missing, so their internal cases did not execute. Scripts gate remains pending. |
| Locked focused pytest | Exit 2, missing executable; zero required cases executed. Pending preparation and rerun. |
| `corepack pnpm docs:build` | Exit 1: install-asset equality passed, then `vitepress: command not found`. Dead-link/emitted-href/redirect gates did not execute; build of final document remains pending. |
| `corepack pnpm docs:check:runtime` | Exit 1: missing `@playwright/test`; no browser launched. No rendered evidence at this checkpoint. |
| Diff and scope checks | Working-tree and configured `origin/main...HEAD` checks exited 0. The explicit new-file no-index check emitted no whitespace diagnostics (exit 1 denotes the file difference). Only this document is changed/untracked; HEAD remains the inspected baseline. |

Reproduce the configured scripts recipe using the owned directory above:

```bash
sh -c 'exec node --test --test-reporter=junit --test-reporter-destination="$1" scripts/*.test.mjs' \
  jobctrl-scripts "$qa_dir/scripts.xml"
corepack pnpm docs:build
corepack pnpm docs:check:runtime
git diff --check
git diff --check origin/main...HEAD
```

The configured comparison checks committed HEAD; rerun at the signed publication
head. For the new untracked document, also run
`git diff --no-index --check /dev/null docs/architecture/recruiting-intermediaries.md`.
Confirm the complete changed-file list contains only this document.

After build, independent QA must visit `/architecture/recruiting-intermediaries`
in a **fresh**, owned local preview. The configured runtime page list in
`scripts/check-docs-site-runtime.mjs` does not include it. An ephemeral browser
probe must block outbound requests, capture desktop/mobile screenshots outside
source paths, and verify the three exact headings, issue href, table/code
readability and scroll containment, hydration, loaded assets and absence of
browser/request errors. Restart after rebuild. Rendered proof remains pending;
Markdown inspection is not browser evidence.

Independent source/privacy/compatibility review and independent QA reproduction
remain controller gates, with no unresolved Blocker/High allowed. The controller
owns frozen dependency preparation, mandatory prepublication/final checks,
browser/API QA, the signed Conventional Commit and exactly one investigation PR
referencing #953 without an implementation-closing keyword. Require exact-head
CI (including applicable Docs Site, Repo Scripts, Release Privacy Gate and DCO
disposition), tracker/assignee and open-issue readback, and owned cleanup. Leave
the PR unmerged and #953 open. Retain only synthetic local QA evidence outside
source; commit no credentials, real profiles, databases or generated materials.
