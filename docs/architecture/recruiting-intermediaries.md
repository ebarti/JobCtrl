# Recruiting Intermediaries

JobCtrl records where a posting was found and its reported employer, but the
inspected contracts do not separately record a publishing agency and its claimed
client. This investigation proposes an additive, evidence-bearing relationship
without changing job identity, application targets, or supervised actions.

**Read this if** you need to distinguish agency and direct employer postings or
scope a future implementation.

Owning investigation: [JobCtrl issue #953](https://github.com/ebarti/JobCtrl/issues/953).
This is a design deliverable, not an implemented capability or an issue closeout.
Source inspection and intake measurements use baseline
`67b4175aa2d9e8f96e62da545886b1e8712bf691` on 2026-10-05.
The author repeated the retained probe on 2026-10-06 using the controller-prepared
Python 3.12.13 environment at `b47b3a1b2792dc4ceb252fce6573bc0f715b3a0b`.
The linked production/test files are unchanged from the inspected baseline.
Historical broker evidence below is bound to its original candidate, not to this
subsequently edited document.
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
| [Python contact projections](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py) and [TypeScript projections](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/projections.ts) | Both contact rebuild functions scope queries to a tenant and carry employer/JobId, role, counts and provenance without attribute values. Shared-fixture execution provenance and historical-schema limits are separated below. |
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
The isolated intake predicate does not execute the selector or score persistence.
The locked one-direct/one-repost fixtures exercise those paths; they do not
reproduce ambiguous multi-candidate selection or prove a client relationship.

Neither the inspected posting DTO nor extraction result contains a relationship
observation, confidential-client status or conflict-resolution record. Contact
and posting provenance provide useful seams. Do not synthesize relationships
from a score, title, location, source domain or contact employer.

## Synthetic evidence

All labels and URLs below are synthetic. The probe writes only an in-memory
SQLite fixture, reads repository source and prints safe results. It makes no
network requests. Run from the repository root with Python 3.11 or newer.
Initial probe interpreter: CPython 3.14.7; prepared-environment reproduction:
CPython 3.12.13. Initial Node checks used 26.9.0.

### Reproducible intake, SQL and contact probe

```bash
workers/automation/.venv/bin/python - <<'PY'
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

### Locked fixture inputs and asserted invariants

This inventory describes inputs and assertions from inspected source. The
execution provenance below distinguishes direct author measurements, inspected
broker receipts and independent-QA reports. No fixture targets personal state.

| Inspected owner | Required cases and assertions |
| --- | --- |
| [test_discovery_identity.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_identity.py) | `collapses_jobspy_job_rediscovered_by_canonical_source`: one Job, two source observations, fingerprint link confidence 0.95. `collapses_reworded_cross_source_description` and `matches_fresh_listing_against_enriched_owner`: same-employer matching. `does_not_merge_distinct_employers_behind_manual_capture_board` and `does_not_merge_distinct_employers_behind_workday_fallback_board`: two jobs, no duplicate link despite shared board/boilerplate. Native precedence/divergent descriptions also have cases. Names omit the common `test_discover_jobs_use_case_` prefix. |
| [test_scorer.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_scorer.py) | `test_score_job_by_url_reuses_direct_score_for_reference_repost` (parameterized recovery) and `test_run_scoring_reuses_direct_score_for_reference_repost_without_llm`: differing reported employers and rewritten descriptions; assertions expect direct score 9, zero scripted LLM calls and success/stage evidence. Same-content reuse and failed-analysis refresh cases are also present. These assertions do not verify a client relationship. |
| [test_contact_provenance.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_contact_provenance.py) | Required source reference, source-kind/capture-method allowlists and serialized provenance. |
| [test_contact_research_source_policy.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_contact_research_source_policy.py) | Default denial, opt-in public source, protected/manual capture, private/local target rejection, authentication/bypass constraints, entry/import without fetch and availability. |
| [test_contact_projection_parity.py](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_contact_projection_parity.py) | Loads [contact_projection_parity.json](https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/packages/domain-types/test/fixtures/contact_projection_parity.json) into an in-memory exact-v7 compatibility schema, rebuilds two tenants and excludes sensitive attribute values. This historical fixture is not proof of current-runtime schema admission. |

Initial author attempt on 2026-10-05, from the repository root:

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

`--no-sync` respected the author role's dependency-preparation boundary. This
initial attempt exited 2: `Failed to spawn: pytest` / `No such file or directory`.
Zero cases executed and no focused JUnit report was produced in that attempt.
This is preparation history, followed by the measured prepared executions
below; it is not a finding about current job/contact behavior.

### Final measured results and execution provenance

Evidence retention is allocated outside source under bundle
`dbb39a6fa46e87622644a56420d77bb65423a01bde6e4bc7226cd46558023eb3`.
The read-only handoff is `role-evidence/<bundle>/receipts.json`; author probe
source, inputs, complete stdout/stderr, UTC command receipts, JUnit and source/lock
hashes are in `role-artifacts/authoring/implement/<bundle>/`. These are retained
locations, not scratch paths. They contain only synthetic investigation evidence.
The controller seals the final authoring snapshot after this checkpoint.

#### Original candidate identity

The verified handoff SHA-256 is
`2a6dbd27b81cbe75db320c757bac58f5d8cc1816300b491fd389814055fec1c6`.
All 39 referenced copied logs/manifests/JUnit/HTML files matched their receipt
hashes. The original identities matter because shared Git HEAD does not imply
identical uncommitted document content:

| Evidence identity | Candidate ID and content digest |
| --- | --- |
| Historical broker local suite / independent reports | Candidate `154e3c2dc5ed2b13b169d498263190ebb83083878a314f4145e2ccc3e663a59a`; content digest `94b43968d709ca8f7e09dd701ed25992a0f955f9885ddaae40dc454f20a6f17d`; HEAD `b47b3a1b2792dc4ceb252fce6573bc0f715b3a0b`; base `67b4175aa2d9e8f96e62da545886b1e8712bf691`. |
| Input to this repair | Candidate `b92f7c18a77c76c29c0e978f44cedfd83ed8e48f5497863e63e670602ea6c180`; content digest `97c4443869ffa0f19b53948c684fb99d7eb4a8bec3271744ef72db8f066e5c1e`; same HEAD/base. Its handoff records Python dependency preparation passing, with no current check results. |

These are input/receipt identities. Neither is a validation identity for the
final edited document. Earlier baseline receipts bound to candidate
`57ad75615d013b7cea08a56bd5466547f45b0fd3ab8fea62c01f422c3951b786`
are history, not checks of this repair.

#### Direct author measurements

At `2026-10-06T11:28:08Z`, the author ran the embedded probe using
`workers/automation/.venv/bin/python` from repository root. It exited 0, emitted
no stderr and exactly reproduced the stdout retained above (1,015 bytes).
`intake-probe.py` retains the same Python body and all synthetic inputs;
`intake.receipt.json` retains the actual argv, cwd and start/end UTC times.

The prepared environment came from the controller's locked `uv sync --locked
--no-install-project --extra dev --python <prepared-cpython-3.12.13>` execution;
its receipt `planned-python-dependencies-e21f8ce11b5bd63f` exited 0. The author
performed no dependency installation or provider/source calls.

From `workers/automation`, the author executed this command at the same UTC start
(paths normalized here; exact paths are in `focused.receipt.json`):

```bash
.venv/bin/python -m pytest \
  tests/test_contact_projection_parity.py \
  tests/test_contact_provenance.py \
  tests/test_contact_research_source_policy.py \
  tests/test_discovery_identity.py tests/test_scorer.py \
  -q -o pythonpath=src --junitxml="$evidence_dir/focused.xml"
```

Actual stdout, exit 0 with empty stderr:

```text
........................................................................ [ 94%]
....                                                                     [100%]
76 passed in 3.96s
```

JUnit contains 76 executed cases, zero failures/errors/skips:

| Executed file | Cases | Measured assertion scope |
| --- | --- | --- |
| `test_discovery_identity.py` | 33 | The inventory's cross-source fingerprint/shingle matches, enriched-owner listing match, distinct employers behind manual/Workday boards, native identity precedence and divergent descriptions all executed. |
| `test_scorer.py` | 28 | Rewritten/reference-repost reuse executed through `test_score_job_by_url_reuses_direct_score_for_reference_repost[True]`, `[False]` and `test_run_scoring_reuses_direct_score_for_reference_repost_without_llm`; each asserts score 9 and zero scripted LLM calls. Same-content reuse and failed-analysis refresh cases also executed. |
| `test_contact_provenance.py` | 4 | Source reference, allowed source/capture kinds and complete serialized provenance executed. |
| `test_contact_research_source_policy.py` | 10 | Default denial, opted-in public source, protected/manual path, local/private targets, authentication/bypass and entry/import restrictions executed. No fetch occurred. |
| `test_contact_projection_parity.py` | 1 | Both tenants' shared-fixture projection comparisons and sensitive-value exclusion executed in the historical exact-v7 compatibility schema. |

The working-tree `git diff --check` and configured
`git diff --check origin/main...HEAD` also exited 0 with empty stdout/stderr;
`diff-check.receipt.json` and `head-diff-check.receipt.json` retain their UTC times.
Only `docs/architecture/recruiting-intermediaries.md` is changed. The committed
comparison covers existing HEAD; it is not a check of a future signed commit.

These are author executions, distinct from independent QA. The AST/three-table
probe remains limited evidence. The full scorer fixtures exercise one direct
score and one repost, not ambiguous multi-candidate selection; passing score
reuse does not prove a client relationship. Historical projection-fixture success
does not prove current-runtime schema admission or migration of a real workspace.

#### Inspected historical broker executions

For the historical candidate above, the local receipt's actual commands and
outputs were inspected from the copied files (not their original controller cwd):

| Broker command | Observed output/result | Retained SHA-256 |
| --- | --- | --- |
| `corepack pnpm scripts:test` | Exit 0: `# tests 163`, `# pass 163`, `# fail 0`, `# skipped 0`. This uses the ordinary scripts command, not the author's JUnit-reporter recipe. | Log `8705116fe0058073f4cfdcf7e95495494a2e97b56e60081d8285cba67491def8`. |
| `corepack pnpm docs:build` | Exit 0: install-asset equality, VitePress build and emitted-link/redirect gates passed. `13647 references resolve across 444 emitted files`; legacy Product Tour permanently redirects to `/user/product-tour`. | Log `69d845abaf45b49212f33b7b4045d6018981971a55af5b6cc9e4f13674d868ac`. |
| Prepared `.venv/bin/python -m pytest` with the five files above, `-q -o pythonpath=src --junitxml=<retained-junit>` | Exit 0: `76 passed in 4.10s`; JUnit has 33 Discovery, 28 scorer, 4 provenance, 10 policy and 1 projection case, zero failures/errors/skips. | Log `0ff22f3f0b3d31c81e230ceb1a17a1b679f36864d86397d7851923cea55f888b`; JUnit `8a66f5d10929d6312e0f29b3a524f8a27e830b0163917ef7add41bb4c2933428`. |
| `corepack pnpm exec node --input-type=module -e <HTML probe>` | Exit 0: `4 rendered documentation checks passed`. Inspected code reads emitted HTML and asserts the three heading IDs and owning issue href. It launches no browser. | Log `bdae804c6427f389ae95d0dae863bf748afed961e5f2694b9c0c4b2b2584c267`; copied HTML `c9855e9c5239d5fc59d0c09fd9e34744742fdcc9f4b7c8a1d3cbe1d097931065` (117,760 bytes). |
| `git diff --check` | Exit 0, empty log. | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. |

The handoff retains each exact argv, including the full HTML probe source;
`broker-command-ledger.json` preserves the selected original identities and
receipts, and `historical-html-probe.mjs` retains that source separately as data.
The broker label “rendered-doc-evidence” describes four emitted-HTML checks. It
is not evidence of desktop/mobile rendering, asset requests or hydration.

#### Independent reports and their limits

The historical review receipt has state `passed`. Its detail independently
reproduces the intake probe and supports source attribution, compatibility and
privacy. It inspected the broker logs/JUnit/build but explicitly did not execute
those suites or inspect browser images.

The separate historical QA receipt has overall state `failed`. Its detail reports
independent execution of 163 scripts, 76 Python cases, runtime docs checks, diff
checks and desktop/mobile QA with nine inspected captures and owned-process
cleanup. The supplied handoff retains that report, but does not include those
browser images, probe transcript, viewport dimensions or image hashes. Preserve
both the reported scenario results and the failed overall disposition; do not
turn narrative scenario passes into QA approval or invent capture measurements.
No previous report approves the subsequently edited candidate.

An earlier baseline script receipt recorded 163 tests, 157 passes and six failures
(log `96b93c8029aa09de48bdd003d8b9da7ef5d64ed4ba10c4bdc1b4c00570582557`).
Later candidate-bound scripts receipts above passed all 163. Keep this resolved
historical failure separate from author dependency-preparation failures below;
neither proves a defect in intermediary behavior or validates the final revision.

#### Retained hashes

SHA-256 uses file bytes. For the embedded probe, hash only the Python body between
the shell heredoc line and its closing `PY`, encoded as UTF-8 with LF line endings
and one terminating LF. Stdout is the text block above with one terminating LF.
These conventions make code, inputs and measured output independently checkable.
The repository paths below have the same bytes at the inspected baseline and
repair HEAD. Copied receipt files use the supplied handoff hashes; author outputs
have separate hashes and execution ownership.

| Evidence | SHA-256 |
| --- | --- |
| Embedded Python body (includes synthetic inputs) | `c4cc9d0141114215e2a7936b63ce0ce280033ddf2ecb6640fe1b667cc0609a1f` |
| Retained stdout | `c72a905ed28a83b792b29fa6ee973e620f9212527e9410f147a491c5874e7157` |
| `workers/automation/src/jobctrl/domain/job_content_identity.py` | `ae6492482d151c23bf37973d53cdb9d0f2c836420a029796f073eb3da7971455` |
| `workers/automation/src/jobctrl/scoring/scorer.py` | `3dbf5dc704308fff7c549b21c1b8fd68f6dac81fac6108a8b097187922a969c8` |
| `workers/automation/src/jobctrl/infrastructure/discovery/sqlite_repository.py` | `e3e51c05827e8aac8f208ffe7702c1ff73ed28882b50ab9b19fcd2fd1f04a233` |
| `workers/automation/src/jobctrl/domain/contact/value_objects.py` | `a1cc9910e7f021bb2ac2aef76ff77957d29759306f3d23e8b1f4535e90bd3ec1` |
| `workers/automation/src/jobctrl/domain/contact/source_policy.py` | `6ea472f28e2ee0bc39e6258f7505288d6395deb575b9fa2aa2c1e4c1cf90a0a5` |
| `workers/automation/tests/test_discovery_identity.py` | `7304710c719d043ede00ebfc8afc2297450bd576c4fb4d620cb00be29a519b51` |
| `workers/automation/tests/test_scorer.py` | `bee407a7e1c5cf315cdc9344194ac515f46f677cd3953ce797d23b65368aff8a` |
| `workers/automation/tests/test_contact_provenance.py` | `ebdf1725a31df7f1f9e0e459279a7489dd1a880395a6d773b4d5da691ab9a9af` |
| `workers/automation/tests/test_contact_research_source_policy.py` | `31d212fc84e51818bd21d71ff84679b910da2aa83fcdc2932024937d351afd50` |
| `workers/automation/tests/test_contact_projection_parity.py` | `78dda7027613bde74360e43af341e2e90d246c3c792d4930601efaa31a0ba942` |
| `packages/domain-types/test/fixtures/contact_projection_parity.json` | `4a178dc907af8250d889827e68b91b48bc8243de13c4d41d1d640dd06f957120` |
| `workers/automation/src/jobctrl/infrastructure/migrations/schema_v7.sql` | `a90f3a0e21c5d4126aa9796e3ad68db9299e1dba175a45c824af6b7d339bedcd` |
| `workers/automation/uv.lock` | `c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6` |
| `pnpm-lock.yaml` | `f58933349adc295cad3ff96ba14d5cae6a62b37fcb83d12fe94a72063aaa0b75` |
| `scripts/checks.toml` | `cbe4620f5a1c92ee723b8edaae74af3b2a0f07c97d8698d9cf514352548915fa` |
| `scripts/check-docs-site-runtime.mjs` | `cb751b315e82d6f94091af0410257ce4234193ba2def9d78a63b7d9dc3050b28` |
| `initial-author-scripts.xml` (initial preparation-failure history) | `752c5f45710ed4a4b162bc03b971c7cfaf7ccd105548cd0db01fd7a75401921e` |

Authoring bundle files measured this turn:

| Retained author file | SHA-256 |
| --- | --- |
| `intake-probe.py` | `c4cc9d0141114215e2a7936b63ce0ce280033ddf2ecb6640fe1b667cc0609a1f` |
| `intake.stdout.txt` | `c72a905ed28a83b792b29fa6ee973e620f9212527e9410f147a491c5874e7157` |
| `intake.stderr.txt` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `intake.receipt.json` | `2e014b4e143cf3a393563a6a8043f1364db094b774463383d857f3f514065822` |
| `focused.xml` | `cbb1ac365b9319bfe0c81862447b8733bcead88233b66a7bbad1e98370b4c8cf` |
| `focused.stdout.txt` | `0e1ad0addeba0d44b61016ed0f2aefa2b66481712aa10da89f81de1681c8154d` |
| `focused.stderr.txt` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `focused.receipt.json` | `0661b12c02193d97d3d942ddd7f9f3dd22885407b6b06ee9002baf3357985142` |
| `source-lock-hashes.json` | `4063d260fb5bb6089f0019577083a4c2e1669695d86030845b99a16bb69af752` |
| `handoff-verification.json` | `350f52f8740a1085924879a6663a77edd26bba03b747e6802da7db9ddf01f630` |
| `broker-command-ledger.json` | `8be56b52086c74f7742caa541a41520620f391d01b1a372faa8482bf95b5c498` |
| `historical-html-probe.mjs` | `c2b7635d69bb3cb7ee745a236d1ee4ca10910daa7144eb9229d902e069ff46bd` |

#### Initial preparation history

These are the 2026-10-05 unprepared author-environment outcomes, not current
product failures or the later broker results. The candidate-bound historical receipts above record subsequent prepared
executions passing. They do not validate this later document revision.

| Initial command | Actual initial outcome |
| --- | --- |
| Configured scripts recipe in `scripts/checks.toml` | Exit 1; JUnit recorded 86 entries: 81 passing, five failing, zero skipped. One lacked pinned `brace-expansion`; four distribution files could not import `ajv`, so their internal cases did not execute. |
| Locked focused pytest recipe above | Exit 2, missing pytest executable; zero cases and no focused JUnit. |
| `corepack pnpm docs:build` | Exit 1; install-asset equality passed, then `vitepress: command not found`. Emitted-link/redirect gates did not execute in this attempt. |
| `corepack pnpm docs:check:runtime` | Exit 1, missing `@playwright/test`; no browser launched in this attempt. |

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

## Verification method

From an owned synthetic QA directory, the configured recipes are:

```bash
qa_dir=$(mktemp -d /tmp/jobctrl-953-qa.XXXXXX)
sh -c 'exec node --test --test-reporter=junit --test-reporter-destination="$1" scripts/*.test.mjs' \
  jobctrl-scripts "$qa_dir/scripts.xml"
corepack pnpm docs:build
corepack pnpm docs:check:runtime
git diff --check
git diff --check origin/main...HEAD
```

Run the locked fixture command above against the prepared environment. Preserve
its actual node IDs/counts/results and report hash with the execution owner;
inspected assertions alone are not execution proof. The committed comparison
must be rerun at the signed publication head, and the changed-file list must
contain only this document.

The configured runtime page list in `scripts/check-docs-site-runtime.mjs` does
not include `/architecture/recruiting-intermediaries`. Direct-page QA therefore
uses a fresh owned local preview and an ephemeral browser with outbound requests
blocked. Preserve the actual desktop/mobile dimensions, screenshots and hashes,
heading/issue-href readback, table/code scroll containment, hydration/asset results
and errors with the execution owner. Restart preview after rebuilding. An emitted
HTML/link check alone is not that rendered proof.

Independent review covers source attribution, current/proposed separation,
compatibility and privacy; independent QA reproduces synthetic and rendered
results. No unresolved Blocker/High is acceptable. The controller owns dependency
preparation, mandatory prepublication/final checks, browser/API QA, the signed
Conventional Commit and one investigation PR referencing #953 without an
implementation-closing keyword. Require exact-head applicable CI (Docs Site,
Repo Scripts, Release Privacy Gate and DCO disposition), tracker/assignee and
open-issue readback, and owned cleanup. Leave the PR unmerged and #953 open.
This method defines publication gates; the local investigation measurements do
not establish CI, publication or feature implementation.
