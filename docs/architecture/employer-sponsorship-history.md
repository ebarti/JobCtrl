---
description: "Future design for optional, official US and Canadian employer filing-history evidence, with explicit provenance, identity review and preservation boundaries."
---

# Employer Sponsorship History

This is a **future design, not an implemented capability**, for optional
official employer filing-history evidence.
Official historical filings could help a person investigate a vague posting.
They cannot establish that a current vacancy offers sponsorship, that an employer
will sponsor a particular person, or that the person is eligible.

The proposed capability is optional and explicitly initiated for a selected
jurisdiction and official resource. No filing-history provider, command, API,
schema, scheduler or eligibility override is currently available.

## Current implementation

Inspected on 2026-10-19 at JobCtrl
[`f734ef8bf1d27e3219b2122aed089421f61b7ca8`](https://github.com/ebarti/JobCtrl/tree/f734ef8bf1d27e3219b2122aed089421f61b7ca8).
The following owners already exist; none is an official employer filing-history
provider.

| Fact or decision | Current owner and boundary |
| --- | --- |
| Candidate authorization | Candidate Profile's [`WorkAuthorization`][profile] holds `legally_authorized_to_work`, `require_sponsorship` and `work_permit_type`, defaulting to empty strings. An employer dataset cannot fill unknown candidate answers. |
| Posting meaning | Enrichment's [`JobInterpretation`][interpretation] records cited constraints, including work authorization, and requirement scopes. Meaning comes from source-bound determinations, not sponsorship word lists. |
| Fit and eligibility | [`ScoringDecision`][scoring] records typed, cited eligibility verdicts; [`eligibility_blocks_downstream`][eligibility] reads blockers/status. Scoring persists its determination binding. Historical employer filings are not inputs to a new eligibility override. |
| Job identity | Discovery owns canonical UUID-backed JobId and its locators, source observations and duplicate relationships. The [`SqliteJobIdentityResolver`][identity] reads JobId and posting-URL locators. A name or employer-history link cannot replace that identity or merge jobs. See [Application URL Authority](application-url-authority.md). |
| Optional company context | [Company briefings](../user/company-briefings.md) are Materials-owned. Explicit JobId-to-company URL confirmation, bounded public pages and persisted determinations supply passive shared reads. Equal names do not link companies; failed refreshes preserve accepted content. The company key is a hash of a reviewed URL, **not a legal-employer identifier**. |

### Existing ownership

Company briefings provide useful patterns for explicit identity links,
immutable attempts, source-bound determinations and transactional acceptance.
They are not dataset importers, and a reviewed company URL is not a legal
employer identifier. Candidate qualifications and eligibility remain separate;
the [semantic determination decision](../decisions.md#2026-10-07-semantic-judgments-are-llm-determinations)
owns judgments about meaning. Historical filing counts must not create lexical
sponsorship heuristics or eligibility overrides.

## Official source formats and limits

The resource samples below describe formats and limitations as of 2026-10-19.
Observation, publication and coverage dates have distinct meanings. A successful
download does not establish completeness or a supported automatic update path.

### United States: historical H-1B petitions

The former [fixed-download page][us-files] redirects to an official archived page
marked “Archived Content” and “out of date.” Its FY2023 link remains downloadable.
The [current hub][us-hub] describes annual/query-specific Excel and CSV downloads
through **Crosstab View → filters → Download to Excel**. It advertises FY2009
through FY2026 quarter 3 at observation time. No interactive export was exercised;
there is no demonstrated automated current-hub acquisition contract.

| Observed FY2023 sample | Evidence and limit |
| --- | --- |
| Official resource | [USCIS FY2023 CSV][us-csv], linked as “FY 2023 H-1B Employer Data” by the archived page |
| Resource size | 2,202,574 decoded bytes in the FY2023 sample |
| SHA-256 | `96f42309393249a7368bd418b2b2c5111b45acc7ccec487a0f024dfa07d71931` |
| Shape | 33,332 parsed data records, each with 11 fields; all observed fiscal-year cells are `2023` |
| Period and publication | FY2023 is source-labeled. Within-year cutoff and full-year completeness are unknown. Publication date was not established. HTTP `Last-Modified: Wed, 31 May 2023 17:40:18 GMT` and the archive page's July 1, 2025 review date are separate observations, not dataset publication evidence. |

Observed CSV header:

```text
Fiscal Year,Employer,Initial Approval,Initial Denial,Continuing Approval,Continuing Denial,NAICS,Tax ID,State,City,ZIP
```

The hub explains that tax identifiers expose only their last four digits. Its
[methodology page][us-understanding] describes petition decisions and notes
employer-name inconsistency and data limitations. Those counts are historical
administrative evidence; they are not open vacancies or commitments to sponsor.
All-2023 rows and a successful download cannot prove full-year coverage. Failure
to find an employer cannot prove it has never sponsored anyone.

### Canada: positive LMIA employers

The official [ESDC catalog][ca-catalog] identifies dataset
`90fed587-1364-4f33-a9ee-208181dc0b97` and the English 2026Q1 resource
`4ee7a4e0-ffc3-47af-94e7-30929d1eeb67`. The [download][ca-xlsx] is **XLSX**, not
CSV, and redirects to public Azure blob storage. The official resource URL and
ID remain canonical; an expiring signed redirect is not an identity.

| Observed 2026Q1 sample | Evidence and limit |
| --- | --- |
| Resource size | 529,510 bytes in the 2026Q1 sample |
| SHA-256 | `2f48cb522180ff82e6768a68b679bed4d4c89efa28d1c5aca7bc1604c99a044e` |
| Publication | Resource metadata `date_published` explicitly says `2026-07-21`. Its `created`/`metadata_modified` dates are July 22; HTTP modification time is July 21. These fields retain their distinct meanings. |
| Coverage | Resource title and workbook A1 say January–March 2026. Package-level coverage fields still say October–December 2025. Retain this metadata conflict with both citations; do not silently substitute the package dates or infer coverage from the filename. |
| Workbook | One worksheet, `Sheet1`, dimension `A1:H8799`; 8,799 XML row elements, including a title row and header row. This is a shape measurement, not a count of employers or validated filings. |
| Expansion | 29 ZIP entries totaling 3,300,534 uncompressed bytes in the observed directory. No macros, formulas or external data were executed. |

Row 2 contains these literal headers (including the source's spelling):

```text
Province/Territory | Program Stream | Employer | Address | Occupation | Incorporate Status | Approved LMIAs | Approved Positions
```

Catalog notes explicitly exclude personal names, including caregiver employers
and business names containing personal names. The list is incomplete. It tracks
positions on positive LMIAs, including subsequently cancelled positions, not work
permits issued or workers entering Canada. PR-only LMIAs were excluded for Q1
2018–Q3 2023; they are included starting Q4 2023, without backfilling older
lists. Absence is not negative sponsorship evidence, and a positive LMIA is not
a current vacancy or a candidate's work permit.

### Public implementation references

The issue links public source at fixed revisions:

- Career-Ops [`index.mjs`][external-plugin] declares an ingest hook returning
  `[]`; it delegates the actual capability elsewhere. That entry alone proves
  no provider behavior. [`scan.mjs`][external-scan] contains default positive and
  negative sponsorship vocabulary. JobCtrl must not import that vocabulary as
  a semantic eligibility filter.
- JobOps [`manifest.ts`][external-provider] probes fixed annual URLs downward,
  indexes columns by position, splits CSV on physical lines and aggregates
  approvals by employer name. These inspected choices do not establish legal
  identity, publication dates, multiline-CSV safety or current export support.
  They are reference limitations, not reproduced JobCtrl production defects.

The references describe external implementation choices, not adopted JobCtrl
behavior. Current company-briefing and scoring tests cover their own identity,
acceptance and preservation boundaries; they do not prove a dataset provider,
legal-employer matching or live sponsorship support.

## Future architecture, not implemented

Discovery should own acquisition, dataset revisions and reviewed legal-employer
associations. Materials keeps company briefings; Candidate Profile, Enrichment,
Scoring and Apply retain their existing authorities. The smallest future
capability reads one explicitly chosen official resource at a time. It does not
need a generalized registry, automatic source discovery or a background refresh.
No persistence schema or executable interface is installed by this design.

### Explicit entry and bounded acquisition

A future explicit operation selects US or Canada, official source/resource and
period, and permits anonymous public acquisition. A local export from the hub
would require the same official-resource provenance; arbitrary uploaded bytes
must not become “official” merely because of their filename. Until a trustworthy
current export path is established, US support must honestly expose that gap
or restrict itself to reviewed historical resources.

Reuse existing public-destination, DNS/socket, pacing and request-budget
protections. Do not send profile facts, resumes or private postings to a source.
Allow redirects only through the reviewed official download chain, validating
each destination. Redact signed queries before retaining diagnostics.

Proposed initial per-resource ceilings are 16 MiB for both transferred and
decoded bytes, three redirects, 60 seconds acquisition wall time, 128 MiB total
ZIP expansion, 256 ZIP members, 16 worksheets, 100,000 data records, 32 columns,
2,000,000 cells and 32 KiB per cell/CSV field. A parser has a 30-second execution
bound. These are future acceptance limits, not measured production defaults;
they must be enforced during streaming/expansion, not after allocation. Crossing
a limit fails the attempt without accepting a truncated prefix. Larger official
releases require a separately reviewed limit change and new proof.

CSV parsing must support quoted commas, escaped quotes and embedded newlines.
Map exact required headers through a versioned source-specific parser; reject
missing, duplicate or unexpected layouts rather than guessing shifted columns.
XLSX parsing validates the ZIP directory and actual streamed expansion, selects
an explicitly supported worksheet/title/header layout, bounds shared strings,
rows and cells, disables external entities/links and never evaluates formulas
or macros. Reject encrypted, corrupt or unsupported workbooks. Preserve source
row/cell references and separate approval/denial/position categories. Never sum
by display name or count identical duplicates twice; record exact duplicate
references and counts without inventing a shared employer.

### Provenance and staged validation

Every proposed immutable dataset revision needs:

| Field group | Proposed retained facts |
| --- | --- |
| Official identity | Source agency, official catalog/resource URL and ID, jurisdiction and language; sanitized final host/path and redirect history are supplementary |
| Complete content | SHA-256 of all decoded resource bytes, byte length and decoding/format information, retained immutable content reference; HTTP validators remain separate |
| Coverage | Source-labeled fiscal period/quarter, supported date bounds and exact metadata/workbook citations; missing cutoff, exclusions and conflicting metadata remain explicit |
| Publication | Source-declared publication date with URL/field or quoted evidence and metadata-snapshot hash; otherwise null with an unknown reason. No download-clock, filename or `Last-Modified` fallback |
| Observation | Actual acquisition start/finish and observation time, separately from publication and acceptance times |
| Interpretation | Parser/version, structural validation result, row/cell locators, counts, warnings and the exact coverage/publication evidence used |

Stage bytes, parse and validate outside the acceptance transaction. Malformed or
truncated bodies, transport/format disagreement, changed headers and absent
resource identity/hash/jurisdiction cannot be accepted. Missing publication date
or uncertain coverage can remain usable historical evidence **only** with an
explicit unknown/conflict status and review; they cannot become “current” by
being downloaded today. Store attempt failures separately. Record the precise
resource and parser versions a person reviewed.

### Reviewed legal-employer association

Dataset rows get stable recorded IDs scoped to their immutable dataset revision.
A separate reviewed association references those IDs and the canonical JobId,
the saved employer snapshot, jurisdiction, evidence and association revision.
The original Job and dataset rows remain owned by their existing contexts.

Equal names, similar spelling, shared addresses, partial tax IDs, parent/subsidiary
relationships and a briefing's company URL cannot establish legal equivalence.
Retain possible matches as unconfirmed; ambiguous or conflicting evidence needs
review and can resolve to “unknown” or “no confirmed association.” Changed
employer identity or dataset evidence invalidates current association review,
without deleting historical links. A new dataset revision never inherits a
review by recomputing a name match.

If semantic assistance is introduced, use the existing strict source-bound
LLM determination owner: canonical row/source IDs, verbatim citations,
provider/model, schema/prompt versions and input fingerprint; lane and spend
preflight before every new call. Structural validation rejects foreign IDs,
invalid quotes and exact-value mismatches. Provider/spend/schema failure creates
no association and no lexical fallback. Human review records the accepted
association; neither a model nor a reviewer can turn filings into vacancy or
candidate-eligibility evidence.

### Atomic acceptance, passive reads and recovery

Accept validated bytes, provenance, row index and the accepted revision pointer
atomically after comparing the expected source configuration and prior accepted
revision. Network/model work never holds that writer transaction. Persist content
safely before pointer activation; an orphaned staged object has no read authority.
Use one source/resource refresh owner or equivalent fencing so a stale concurrent
attempt cannot overwrite a later accepted revision. Do not promote any reviewed
association whose dataset/configuration changed while it was being reviewed.

A failed refresh preserves the last accepted dataset, row IDs, associations and
original observation/publication/acceptance clocks. Its separate attempt may
show unavailable, malformed or review-required status. A successful re-download
of unchanged bytes records a new attempt/observation separately; it does not
redate the old accepted dataset. An interrupted transaction leaves either the
previous complete revision or the new complete revision, never a partial index.

After restart, reload the durable accepted pointer and verify its referenced
hash/provenance/index before serving it. Resume only the recorded attempt with
its expected revision; otherwise discard staging and require another explicit
refresh. If the accepted reference is corrupt, preserve it for recovery and show
unavailable; do not silently replace it with a partial download. With valid
accepted data and a failed later attempt, reads still return the same accepted
IDs with stale/failure context. Reads never fetch, parse anew, call a model or
reconstruct identity from prose.

### Presentation and authority

Present separate source-labeled historical counts/periods and reviewed employer
association, current posting claims, and candidate-authored authorization. A
future passive view can say “Historical filing evidence; current vacancy
sponsorship unknown,” with source, publication/coverage uncertainty, freshness
and last-attempt failure visible together. No match, missing source and stale
source are distinct unknown states, not “does not sponsor.” Freshness is a
source-specific disclosure policy, never evidence of an active offer.

Historical filings must never modify candidate facts, canonical Job ownership,
posting claims, eligibility, scores, materials or approvals. They grant no
application or communication authority. Country-specific vocabulary can only
be a source-attributed query suggestion reviewed before the user saves a search.
It cannot rewrite existing saved search controls or act as an eligibility or
intake filter. Literal execution of the user's saved query remains with the
existing search owner.

### Future implementation proof

All scenarios below are **proposed acceptance requirements**, not implemented
provider tests or passing results. Use owned synthetic stores and explicit
fake model choices; no evaluation corpus or recorded-output replay fixtures.

| Scenario/boundary | Required future observation |
| --- | --- |
| Optional entry | Disabled/absent configuration and passive reads make zero network/model calls; explicit jurisdiction/resource selection is required before acquisition. No profile or private workspace data leaves the owner. |
| CSV format | Quoted comma, escaped quote, embedded newline, BOM and reordered supported headers retain exact fields/row IDs. Missing/duplicate/changed unsupported headers fail without positional guesses. |
| Workbook format/limits | Title and header rows are distinct; supported layouts parse by version. Changed sheets, oversized shared strings/cells, forged ZIP sizes, expansion bombs, external entities, formulas and macros cannot bypass bounds or execute. |
| Download failure | Timeout, redirect refusal, unavailable/stale source, wrong media, malformed/truncated CSV/XLSX and mid-stream size exhaustion leave accepted bytes/IDs/clocks unchanged; no valid prefix becomes accepted. |
| Metadata | Missing publication date is explicitly unknown; missing period/cutoff and Canada's conflicting package/resource dates remain visible. Modification/observation time cannot replace publication/coverage. |
| Duplicates and identity | Exact duplicate rows retain locators without double counting; same names, partial tax IDs, parents/subsidiaries and briefing URLs remain unconfirmed until reviewed. No case asserts current vacancy sponsorship. |
| Semantic authority | Opposite valid model identity proposals follow their recorded verdicts pending human review; unavailable provider, denied spend, malformed JSON, bad schema, foreign IDs, non-verbatim quotes and mismatched exact values fail distinctly with no fallback. Unchanged accepted inputs reuse receipts without a new call. |
| Concurrent refresh/review | Competing refreshes and configuration/employer/association changes fence acceptance. A stale writer cannot replace newer accepted evidence or migrate a review to different row IDs. |
| Acceptance interruption | Inject failure before pointer activation, during transactional writes and after commit; close the process and reopen the store. The accepted pointer/index/hash agree; failure leaves the previous revision and original clocks readable. |
| Reload/resume | After failed refresh and restart, actual entry-point reads return the same accepted dataset/row/association IDs with failure context; interrupted staging is never inferred accepted. Corrupt accepted provenance shows unavailable while retaining recovery history. |
| Downstream isolation | Compare authored facts, canonical jobs/locators, posting interpretations, scores, accepted materials and approvals before/after every success/failure. Only the optional dataset/association/attempt owner changes. Reviewed vocabulary changes no search until explicitly saved and never changes eligibility. |

A future implementation must prove these through its real command/API writer,
persistence boundary and passive readers, including reopening an owned store.
Existing briefing rollback tests do not substitute for dataset crash/reload
proof, and public HTTP 200 samples do not establish live provider integration.

[profile]: https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/profile/value_objects.py
[interpretation]: https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/enrichment/interpretation.py
[scoring]: https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/scoring/determination.py
[eligibility]: https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/scoring/eligibility.py
[identity]: https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_identity_resolver.py
[us-files]: https://www.uscis.gov/archive/h-1b-employer-data-hub-files
[us-hub]: https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub
[us-understanding]: https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub/understanding-our-h-1b-employer-data-hub
[us-csv]: https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2023.csv
[ca-catalog]: https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97
[ca-xlsx]: https://open.canada.ca/data/dataset/90fed587-1364-4f33-a9ee-208181dc0b97/resource/4ee7a4e0-ffc3-47af-94e7-30929d1eeb67/download/tfwp_2026q1_pos_en.xlsx
[external-plugin]: https://github.com/career-ops-hq/career-ops/blob/0fc547a726b5aefa26495bfe6b6971d310f178e7/plugins/h1b-sponsor/index.mjs
[external-scan]: https://github.com/career-ops-hq/career-ops/blob/0fc547a726b5aefa26495bfe6b6971d310f178e7/scan.mjs#L888
[external-provider]: https://github.com/DaKheera47/job-ops/blob/c28b90a5fba75f298cb1d6a49460ddf009808715/visa-sponsor-providers/us/manifest.ts
