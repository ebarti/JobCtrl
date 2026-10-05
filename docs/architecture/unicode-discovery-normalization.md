# Unicode discovery normalization

Discovery currently compares some titles through ASCII tokens and some locations
through uncomposed Unicode strings. This investigation records reproducible gaps
and proposes a comparison-only contract that preserves source text and durable
identity. Owning issue: [Unicode discovery normalization design #1024](https://github.com/ebarti/JobCtrl/issues/1024).

**Read this if** you need to separate discovery matching from display formatting,
content deduplication, request identity, or accepted role-feedback rules.

## Future architecture, not implemented

This is a bounded investigation and design, not a production implementation.
No helper, adapter, schema, shared navigation, or persisted record changes here.
The issue remains design work; delivery of this page does not establish that
Unicode discovery matching is implemented or verified.

### Proposed minimal comparison contract

Derive an ephemeral comparison string from each operand using this order:

1. Unicode compatibility normalization (NFKC).
2. Locale-independent full casefolding.
3. Final canonical composition (NFC), because folding can introduce combining
   sequences.
4. Trim and collapse Unicode whitespace to one ASCII space.

For a future Python owner, the specification is equivalent to
`" ".join(unicodedata.normalize("NFC", unicodedata.normalize("NFKC", value).casefold()).split())`.
This expression specifies comparison semantics; it is not a shipped helper or a
new content-identity algorithm. Use the same Unicode whitespace definition for
both operands. A future cross-runtime implementation must pin or explicitly
test its Unicode version and whitespace set; JavaScript `toLowerCase()` is not
full casefolding. For this Python-owned proposal, whitespace means Python
`str.split()` whitespace semantics; a future mirror must test that same set
rather than substitute its runtime's default regular-expression class.

Title tokens should retain runs of Unicode letters (`L*`) and numbers (`N*`),
including combining marks (`M*`) attached to a retained letter/number run.
An isolated leading mark does not start a token. Other characters separate runs.
Preserve accents and script distinctions after the specified normalization:
`Développeur` equals `De\u0301veloppeur`, but not `Developpeur`; `東京` does not
equal `京都`. NFKC deliberately equates width/compatibility variants; casefolding
deliberately equates `Straße` and `STRASSE`. This is not accent stripping or
transliteration and does not make confusable scripts equivalent.

Normalize both titles and queries, and the keys/values used for comparison in
alias, stopword, role-policy, seniority, track and query-deduplication tables.
Retain current note removal, strict/recall modes, compact-span constraints,
English aliases, specialty/business exclusions, track/seniority policies and
adjudication order. Unicode support does not infer translated English role
categories. Newly planned equivalent queries may deduplicate using comparison
keys while retaining the first original query spelling for the provider.
Never rewrite an existing immutable search specification.

For locations, apply the same string transformation to posting text, configured
patterns, remote markers, alias lookup keys/values and country-context keys.
For short alphanumeric aliases (the existing at-most-three-character policy),
require boundaries outside Unicode letters, numbers and combining marks.
Thus `US` can match `Remote ＵＳ` after NFKC but cannot match inside `éUSé`.
Do not use ASCII lookarounds or assume a runtime's `\b` has these semantics.
Keep existing long-pattern substring and comma-composite matching policies.
Reject geography still precedes remote acceptance; accepted country context
still suppresses only the existing ambiguous rejection abbreviations.
Keep local-only exceptions and concrete-location requirements in their current
order.

### Assumptions and compatibility boundaries

The smallest change belongs at the existing Python comparison seams. It needs
no service, database, schema migration, network source, or new profile field.
Assume existing alias vocabulary and English role classification remain product
policy; spelling equivalence alone is the scope of the proposed contract.

| Boundary | Proposed preservation requirement |
| --- | --- |
| Provider queries and locations | Keep the original selected spelling and existing provider-specific location mapping. Derive comparison keys separately. |
| Display/source text | Keep source spelling and existing display formatters. A composed/decomposed display difference remains visible unless a separate display change is designed. |
| URLs and canonical Job identity | Do not normalize URLs with title/location rules, re-key Jobs, broaden identity merge rules, or change observation identity. |
| Content hashes | Keep the existing content fingerprint and shingle contracts unchanged, even where discovery comparisons use similar transformations. |
| Durable search units | Preserve serialized existing specs, fingerprints, unit IDs, receipts and checkpoints. New planning comparisons do not migrate old plans. |
| Accepted feedback | Keep legacy stored keys and decisions. New discovery tokens must not silently change the legacy feedback reader's key derivation. |
| Sensitive data and authority | Comparison uses existing inputs in memory. No external lookup, new telemetry payload, profile/resume export, model call, automatic approval, scoring, tailoring or submission is introduced. Failed refreshes must preserve accepted artifacts. |

The feedback mismatch below requires a separate reader/writer parity and
compatibility design before changing either side. Do not simply regenerate
approved keys from `title_display` or dual-read broad new keys: ASCII loss has
already made some legacy keys ambiguous. Inventory collision behavior using
synthetic fixtures, define a versioned key or another explicit compatibility
mechanism, preserve approval provenance and scope, and decide how ambiguous
legacy decisions remain effective without broadening exclusions. No migration
or compatibility strategy is claimed accepted here.

Punctuation remains a limitation: splitting non-letter/number characters does
not define semantic equivalence for `C++`, `C#`, dashes or apostrophes. Broader
segmentation (including unspaced scripts), locale-specific linguistic matching,
transliteration, accent-insensitive search, invisible/format-character policy,
homoglyph security and richer geography are follow-up work. NFKC may change
compatibility punctuation; do not add extra punctuation rewrites implicitly.
Unknown-location, missing-title and all-mark inputs must have explicit
regression coverage; normalization must not create a universal match from an
empty token set.

## Current implementation

Source inspection and probes below use repository head
`67b4175aa2d9e8f96e62da545886b1e8712bf691`. Source links are pinned to that
revision so the evidence is inspectable independently of subsequent changes.
The following owners are current code, not proposed new layers.

| Concern | Inspected owner and current behavior |
| --- | --- |
| Title admission | [title_filter.py][title-owner]: `normalize_query` strips notes after `\|`; `_tokens` casefolds then extracts `[a-z0-9]+`. `title_matches_query` checks approved exclusions first, then English stopwords/aliases, exclusions, strict or recall policy, and optional loose-match adjudication. No NFKC/NFC step exists here. |
| Query planning | [target_queries.py][query-owner]: `_dedupe_exact_queries` uses stripped full-string casefold keys; `_query_key` sorts ASCII tokens excluding dedupe stopwords for generated candidates. `_tokens` also uses `[a-z0-9]+`. `title_matches_any_query` delegates to the title owner. Generated recall queries can also carry tier 1; tier alone does not identify an exact query. |
| Location admission and adapter display | [location_filter.py][location-owner]: `_normalize` casefolds and collapses whitespace without canonical/compatibility normalization. `_matches` uses ASCII lookarounds for short alphanumeric patterns and substring search otherwise. Alias/composite/country-context handling lives here. `location_matches_target` checks rejects before remote/local/accept logic. `normalize_location_display` separately maps Spain country/region tokens using regular expressions. |
| Broad-board boundary | [jobspy.py][jobspy-owner]: despite its filename, `_scrape_with_retry` delegates to JobStreaming; `_location_ok` and `_title_ok` delegate to shared helpers. `_run_one_search` passes selected original query/location to the provider (with separate Glassdoor mapping), then filters the frame by location and title before storing. `store_jobspy_results` also invokes the posting acceptance policy and repository. |
| Other consumers | [ats_adapters.py][ats-owner]: Workday, Greenhouse, Lever and Ashby adapter conversions call title and location helpers. [workday.py][workday-owner] and [smartextract.py][extract-owner] use shared helpers and target-query matching. [production_wiring.py][wiring-owner]: `_posting_acceptance_policy` rechecks target title/location at the write boundary. These call sites were inspected; the probes do not run full adapters. |
| Projection display | [Python location_normalization.py][py-projection] and [TypeScript location-normalization.ts][ts-projection] format location display separately from discovery admission. [projection_builder.py][py-builder] and [read-model.ts][ts-builder] call them for `job_list_projections.location`. Both have the shared [locationCases fixture][fixture] and [Python][py-projection-test]/[TypeScript][ts-projection-test] tests. Their existing country recognition does not compose decomposed `España`. |
| Content identity | [job_content_identity.py][content-owner]: `normalize_identity_text` uses NFKC, selected punctuation translation, whitespace collapse and casefolding; description normalization additionally removes formatting. `job_content_fingerprint` hashes title/employer/description, separately from fuzzy shingle matching. [sqlite_repository.py][repository-owner] and the broad-board owner consume it for deduplication. [test_discovery_identity.py][identity-test] covers canonical/observation and content-duplicate paths. |
| Canonical and URL identity | [identifiers.py][id-owner] generates UUID JobIds and validates canonical UUID serialization. [discovery/identity.py][url-owner] owns canonical identity/observations and URL-specific normalization; title tokens do not own these identities. |
| Request fingerprint | [search_units.py][request-owner]: immutable `DiscoverySearchSpec` serializes original string fields into sorted compact JSON, hashes it, and derives `search_unit_id` from ordinal/hash. [sqlite_search_unit_repository.py][request-repository] persists request JSON/fingerprint and rejects incompatible existing plans. [test_discovery_search_unit_identity.py][request-test] covers canonical receipts and repository identity boundaries. Composition/width variants remain different request fingerprints. |
| Approved feedback writer/reader | [discovery-controls.ts][feedback-owner]: `lowScoreRoleMatchGroups` calls `normalizeTitlePattern` (`toLowerCase` then ASCII tokens) and hashes that key into the suggestion ID. `refreshRoleMatchFeedbackSuggestions` writes pending suggestions and updates only pending conflicts, preserving decided records. [title_filter.py][title-owner] loads approved local `exact_title_exclusion` keys with a 30-second cache and compares them to its own casefold/ASCII key. [API role-feedback route tests][feedback-test] and [worker title tests][title-test] cover feedback paths; this probe does not execute those suites. |

Follow the [auditability checks](../developer/qa/regression-catalog.md#auditability-checks)
when implementing a feedback repair: trace canonical evidence through writer,
persistence and reader; do not mask the mismatch by hiding feedback or changing
its displayed spelling. The current gap is a comparison-key mismatch, not
proof that any real user's approved exclusion failed.

## Synthetic evidence

### Isolation, runtimes and limits

All inputs are synthetic literals or the checked-in shared fixture. No profile,
resume, user database, provider crawl, model adjudication or application submission
was used. Feedback is injected in memory by replacing the approved-pattern loader;
`role_matcher=None` disables model adjudication. The API writer function is extracted
from actual source and executed after TypeScript type stripping; no API request or
suggestion approval is performed.

The two location helper files are loaded directly to avoid infrastructure package
initializers. A normal projection-package import failed with
`No module named 'opentelemetry'` in this checkout. Direct loading executes the
helper source, not persistence or production wiring. Pure title/query/content/
search-spec owners import normally. Type stripping emits an experimental warning.

Initial measurements: Python 3.14.7 / Unicode 16.0.0 and Node 26.9.0 /
Unicode 17.0. These are outside the configured CI matrix: Python 3.11–3.13
in [python.yml][python-ci], Node 22.21.1 in [repo-scripts.yml][scripts-ci] and
[docs-site.yml][docs-ci]. Repeating the Node portion on installed Node 22.21.1 /
Unicode 16.0 gave identical results. No supported Python CI version was installed;
that repeat is pending. Fixture success establishes these 18 examples only, not
general cross-runtime Unicode parity.

### Reproduce against the inspected source

Run from the repository root. Save the following blocks as `probe.mjs` and
`probe.py` in a uniquely owned temporary directory outside the repository.
The Python command takes the JavaScript file path as its only argument:

```bash
PYTHONDONTWRITEBYTECODE=1 python3.14 /path/to/owned/probe.py /path/to/owned/probe.mjs
# Repeat with the pinned Node executable, if installed:
PROBE_NODE=/path/to/node-22.21.1/bin/node PYTHONDONTWRITEBYTECODE=1 \
  python3.14 /path/to/owned/probe.py /path/to/owned/probe.mjs
# Repeat with a supported Python CI executable when available.
```

```javascript
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = (path) => readFileSync(path, 'utf8');
const projectionSource = stripTypeScriptTypes(read('apps/api/src/location-normalization.ts'));
const normalize = new Function(projectionSource.replace('export function ', 'function ') + '\nreturn normalizeJobLocation;')();
const controls = read('apps/api/src/discovery-controls.ts');
const writerSource = controls.match(/function normalizeTitlePattern\(value: string\): string \{[\s\S]*?\n\}/)[0];
const writer = new Function(stripTypeScriptTypes(writerSource) + '\nreturn normalizeTitlePattern;')();
const cases = JSON.parse(read('packages/domain-types/test/fixtures/audit_projection_parity.json')).locationCases;
const result = {
  node: process.version, unicode: process.versions.unicode,
  projectionPassed: cases.filter(c => normalize(c.input) === c.expected).length,
  projectionTotal: cases.length,
  display: ['España', 'Espan\u0303a'].map(normalize),
  writerKey: writer('Straße Engineer'),
};
console.log(JSON.stringify(result));
```

```python
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unicodedata

root = Path.cwd()
sys.path.insert(0, str(root / 'workers/automation/src'))
from jobctrl.discovery import title_filter as title, target_queries as targets
from jobctrl.domain.job_content_identity import normalize_identity_text, job_content_fingerprint
from jobctrl.domain.discovery.search_units import DiscoverySearchSpec

# Execute pure helper files without infrastructure package initializers.
def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, root / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

location = load('synthetic_location', 'workers/automation/src/jobctrl/infrastructure/discovery/location_filter.py')
projection = load('synthetic_projection', 'workers/automation/src/jobctrl/infrastructure/projections/location_normalization.py')
node = json.loads(subprocess.check_output(
    [os.environ.get('PROBE_NODE', 'node'), sys.argv[1]], text=True))
print('Python', sys.version.split()[0], 'Unicode', unicodedata.unidata_version)
print('Node', json.dumps(node, ensure_ascii=False, sort_keys=True))
# In-memory replacement: never invoke the DB-backed feedback loader or model.
title._approved_role_feedback_title_patterns = lambda: ()
for left, right in [
    ('Director of Engineering', 'Director of Engineering'),
    ('Vice President, Engineering', 'VP of Engineering'),
    ('Sales Director Platform', 'Director of Platform Engineering'),
    ('Développeur', 'De\u0301veloppeur'),
    ('東京 Engineer', '京都 Engineer'),
    ('Ｓｏｆｔｗａｒｅ Engineer', 'Software Engineer'),
]:
    print('title', repr(left), repr(right), title._tokens(left), title._tokens(right),
          title.title_matches_query(left, right, role_matcher=None))
roles = ['Développeur', 'De\u0301veloppeur', '東京 Engineer', '京都 Engineer']
print('tier1', [q['query'] for q in targets.build_target_role_queries(roles) if q['tier'] == 1])
for value, accept, reject in [
    ('Remote US', ['Remote'], ['US']),
    ('Remote ＵＳ', ['Remote'], ['US']),
    ('Remote, United States', ['Spain', 'Europe'], ['US']),
    ('Remote EMEA', ['Europe'], ['US']),
    ('Barcelona, CT, ES', ['Barcelona, Spain'], ['US', 'Canada']),
    ('Barcelona, Venezuela', ['Barcelona, Spain'], ['US', 'Canada']),
    ('Madrid, MD, ES', ['Barcelona, Spain'], ['US', 'Canada']),
    ('España', ['Spain'], []),
    ('Espan\u0303a', ['Spain'], []),
    ('Remote éUSé', ['Remote'], ['US']),
]:
    print('location', repr(value), accept, reject,
          location.location_matches_target(value, accept=accept, reject=reject))
for value in ['España', 'Espan\u0303a']:
    print('display', repr(value), repr(location.normalize_location_display(value)),
          repr(projection.normalize_job_location(value)))
cases = json.loads((root / 'packages/domain-types/test/fixtures/audit_projection_parity.json').read_text())['locationCases']
print('Python projection fixture', sum(projection.normalize_job_location(c['input']) == c['expected'] for c in cases), '/', len(cases))
for left, right in [('Développeur', 'De\u0301veloppeur'), ('Ｓｏｆｔｗａｒｅ Engineer', 'Software Engineer')]:
    def content(value):
        return job_content_fingerprint(title=value, company='Synthetic Co', description='Synthetic description')
    def request(value):
        return DiscoverySearchSpec(query=value, provider_location='Spain', target_location='Spain',
            sites=('indeed',), results_per_site=1, hours_old=None, remote_only=False,
            country_indeed='spain')
    print('identity', repr(left), repr(right), normalize_identity_text(left) == normalize_identity_text(right),
          content(left) == content(right), request(left).fingerprint() == request(right).fingerprint())
writer_key = node['writerKey']
print('feedback keys', repr(writer_key), repr(title._normalize_title_pattern('Straße Engineer')))
title._approved_role_feedback_title_patterns = lambda: (writer_key,)
print('API-key exclusion applied', title._title_excluded_by_role_feedback('Straße Engineer'),
      'admitted', title.title_matches_query('Straße Engineer', 'Straße Engineer', role_matcher=None))
title._approved_role_feedback_title_patterns = lambda: ('strasse engineer',)
print('worker-key exclusion applied', title._title_excluded_by_role_feedback('Straße Engineer'),
      'admitted', title.title_matches_query('Straße Engineer', 'Straße Engineer', role_matcher=None))
```

### Measured results

`De\u0301veloppeur` and `Espan\u0303a` below denote decomposed input, not a
literal backslash sequence. Booleans are observed current helper results.

| Probe | Measured current output |
| --- | --- |
| `Director of Engineering` / same query | `True` |
| `Vice President, Engineering` / `VP of Engineering` | `True` |
| `Sales Director Platform` / `Director of Platform Engineering` | `False` |
| `Développeur` / `De\u0301veloppeur` | Tokens `['d', 'veloppeur']` / `['de', 'veloppeur']`; match `False` |
| `東京 Engineer` / `京都 Engineer` | Both token lists `['engineer']`; match `True` after script loss |
| `Ｓｏｆｔｗａｒｅ Engineer` / `Software Engineer` | `['engineer']` / `['software', 'engineer']`; match `False` |
| Target-role planner with those first four Unicode role variants | Retains all four original roles; also emits tier-1 recall queries `Mid Software Engineer`, `Software Engineer`, `Senior Software Engineer`, `Lead Software Engineer`, `Staff Software Engineer`, `Principal Software Engineer` |
| `Remote US` vs `Remote ＵＳ`, accept `['Remote']`, reject `['US']` | `False` / `True` |
| `Remote, United States`, accept `['Spain', 'Europe']`, reject `['US']` | `False`: rejection wins |
| `Remote EMEA`, accept `['Europe']`, reject `['US']` | `True` |
| `Barcelona, CT, ES` / `Barcelona, Venezuela` / `Madrid, MD, ES`, accept `['Barcelona, Spain']`, reject `['US', 'Canada']` | `True` / `False` / `False`: composite geography and abbreviation controls |
| `España` vs `Espan\u0303a`, accept `['Spain']`, reject `[]` | Admission `True` / `False`; discovery display `Spain` / original decomposed spelling; Python and TypeScript projection display also `Spain` / original decomposed spelling |
| `Remote éUSé`, accept `['Remote']`, reject `['US']` | `False`: ASCII short-alias boundary treats surrounding accented letters as boundaries |
| Shared projection fixture | Python `18 / 18`; Node `projectionPassed: 18, projectionTotal: 18` on both Node versions |
| Composed/decomposed title pair, and fullwidth/ASCII title pair; otherwise same synthetic employer/description and request fields | Identity-text equality `True`, content-fingerprint equality `True`, request-fingerprint equality `False`, for both pairs |
| `Straße Engineer` feedback | API writer key `'stra e engineer'`; worker key `'strasse engineer'`; API-key exclusion applied `False`, admitted `True`; worker-key positive control excluded `True`, admitted `False` |

These results demonstrate deterministic spelling gaps and preserve positive
controls. They do not estimate incidence, provider behavior, linguistic quality,
production feedback persistence, worker cache invalidation or model decisions.
The proposal's future outcomes below were not executed as a modified algorithm.

### Future acceptance cases

These are requirements for a subsequent implementation, not passing tests here.
Use the same synthetic inputs and policy settings as above unless stated.

| Case | Observed now | Proposed future requirement |
| --- | --- | --- |
| Composed/decomposed `Développeur` | Does not match | Matches in both operand directions; equivalent newly planned roles deduplicate, retaining first source spelling |
| Fullwidth/ASCII `Software Engineer` | Does not match | Matches in both directions |
| `東京 Engineer` / `京都 Engineer` | Matches after losing script | Does not match when the distinct script tokens are required by the query |
| `Développeur` / `Developpeur`; different-script confusables | Not measured | Remain distinct; no accent stripping/transliteration/confusable folding beyond NFKC/casefold |
| Fullwidth `Remote ＵＳ` | Bypasses US rejection | Rejected exactly like ASCII US; reject precedes remote allowance |
| `Remote éUSé` | Rejected | US alias does not match inside the Unicode letter run; generic Remote policy admits it |
| Decomposed `España` against Spain alias; decomposed configured alias against composed input | First direction fails; reverse not measured | Both directions admit through equivalent alias keys; display retains current formatting/spelling behavior |
| English exact/VP matches, business/specialty rejection, strict/recall track/seniority and adjudication | Selected controls pass; broader suite not run | Existing policies and ordering pass regression coverage without adding translated role taxonomy |
| Reject precedence, EMEA, composite city/country, ambiguous abbreviations, remote-required/local exception, missing location | Selected controls pass; others not measured here | Existing policy decisions remain, with Unicode-equivalent operands handled symmetrically |
| Attached marks, isolated marks, whitespace, empty/null titles and queries | Not measured | Attached marks survive; isolated marks do not form tokens; stable whitespace; preserve documented empty-input policy without widening nonempty unmatched titles |
| Projection display | Both helpers pass 18 shared cases | All 18 still pass byte-for-byte; any display extension needs its own shared cases and decision |
| Content identity and immutable request specs | Equivalent content hashes, distinct original request hashes | Hash algorithms, old JSON/specs, unit IDs, URLs and JobIds remain unchanged |
| Approved `Straße Engineer` exclusion | Reader/writer mismatch | Separate compatibility work proves parity and preservation of existing approval scope; comparison rollout alone must not claim this repaired |

### Follow-up implementation scope

The future comparison helper and its tests belong in the Python discovery
comparison layer, consumed by the title, target-query and location owners above.
Cover composed/decomposed and width variants, non-Latin distinctions, attached
marks, short-location boundaries and operand/alias symmetry. Expand
[test_title_filter.py][title-test], [test_discovery_title_filter.py][adapter-test],
[test_target_search_preferences.py][query-test] and
[test_discovery_location_filter.py][location-test], then exercise the inspected
adapter and write-policy consumers. These are future edits, outside this page's
scope. Test immutable-spec recovery and canonical/content identity preservation
at the search-unit repository and discovery identity boundaries.

Feedback compatibility belongs jointly to the API writer and worker reader;
cover lowercasing versus casefolding, Unicode and ASCII-loss collisions, pending
versus approved/rejected rows, suggestion identity, tenant/status selection,
cache refresh, and preservation of decisions/provenance. Pair synthetic database
and product-path QA with canonical evidence tracing before calling it fixed.
Do not migrate feedback using a discovery-token helper without that design.

If display normalization is pursued separately, both projection implementations
and their shared fixture must change together. This proposal deliberately leaves
the measured decomposed-display gap open.

### Delivery verification checkpoint

Local attempts in this implementation role are evidence, not completed delivery
gates. Dependency preparation, independent review/QA, final checks and publication
remain controller-owned.

| Check | Local observation / remaining gate |
| --- | --- |
| Synthetic source probes | Executed successfully on Python 3.14.7 with Node 26.9.0, repeated with Node 22.21.1; supported-Python repeat pending |
| `checks.scripts` from `scripts/checks.toml` | Configured JUnit command attempted: 86 reported cases, 81 passed, 5 failed, 0 skipped. Missing `brace-expansion` caused one failure; four distribution test files could not load `ajv`. Dependency-complete regression run pending |
| `corepack pnpm docs:build` | Installer-asset parity passed; build stopped at `vitepress: command not found` because `node_modules` is absent. Docs/link/redirect gates pending |
| `corepack pnpm docs:check:runtime` | Stopped loading `@playwright/test`; runtime browser gate pending |
| New-page rendered evidence | Pending fresh post-build local preview at desktop/mobile sizes: headings, Unicode examples, tables, code blocks, links, overflow and browser/request errors. The fixed runtime page list does not include this new page |
| Diff/scope/privacy | Required headings, issue URL and 31 source-reference paths checked. Only this uncommitted page changes; manual content inspection found only synthetic inputs and public source references. Whitespace checks passed, including `git diff --no-index --check /dev/null docs/architecture/unicode-discovery-normalization.md` for the untracked page. `origin/main...HEAD` also passed but excludes uncommitted content; controller repeats against the final signed commit |
| Independent gates and publication | Pending independent review and QA PASS with no unresolved Blocker/High, exact-final-head required CI (including applicable Docs Site, Repo Scripts and Release Privacy Gate), one open unmerged PR, issue/tracker/assignee readback and owned cleanup. Do not close #1024 as implemented |

The script invocation used an owned temporary JUnit path:

```bash
node --test --test-reporter=junit \
  --test-reporter-destination=/path/to/owned/scripts.xml scripts/*.test.mjs
corepack pnpm docs:build
corepack pnpm docs:check:runtime
git diff --check origin/main...HEAD
git diff --check
```

[title-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/title_filter.py
[query-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/target_queries.py
[location-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/location_filter.py
[jobspy-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/jobspy.py
[ats-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/ats_adapters.py
[workday-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/workday.py
[extract-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/smartextract.py
[wiring-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/production_wiring.py
[py-projection]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/projections/location_normalization.py
[py-builder]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py
[py-projection-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_location_normalization.py
[fixture]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/packages/domain-types/test/fixtures/audit_projection_parity.json
[content-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/job_content_identity.py
[repository-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_repository.py
[id-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/identifiers.py
[url-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/identity.py
[request-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/search_units.py
[request-repository]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_search_unit_repository.py
[request-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_search_unit_identity.py
[identity-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_identity.py
[location-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_location_filter.py
[adapter-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_title_filter.py
[query-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_target_search_preferences.py
[feedback-owner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/discovery-controls.ts
[feedback-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/test/server.test.ts
[scripts-ci]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/.github/workflows/repo-scripts.yml
[python-ci]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/.github/workflows/python.yml
[docs-ci]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/.github/workflows/docs-site.yml
[ts-projection]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/location-normalization.ts
[ts-builder]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/src/read-model.ts
[ts-projection-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/api/test/location-normalization.test.ts
[title-test]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_title_filter.py
