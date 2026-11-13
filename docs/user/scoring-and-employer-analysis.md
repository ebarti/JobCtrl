---
description: "See how JobCtrl scores job fit from versioned profile evidence, requirement-level assessments, blockers, confidence, and correction history."
---

# Scoring

Fit compares typed, evidence-linked posting demands with a versioned Candidate
Profile. It produces an applicant-side fit score, confidence, blockers, gaps,
and requirement-level evidence for your own triage.
Requirements owns reusable Skills/Professional Experience meanings, direct
Education/Languages demands and posting occurrences; Fit owns how those demands
and saved candidate evidence become a fit decision. Discovery's
employer analysis supplies separate role and company context.
For a shorter conceptual introduction, read
[Evidence-based Job Fit Scoring](../guides/evidence-based-job-fit-scoring.md).

This page describes the Python source build. The
[published release](https://github.com/ebarti/JobCtrl/releases/latest) determines
installed-version availability; a synthetic walkthrough or source verification
does not establish what has been released or deployed.

Before a new scoring attempt, JobCtrl reuses a posting observation or a
trustworthy, source-bound canonical capture from the last six hours. Missing,
changed or older evidence uses the normal availability check. Usable content can
proceed while availability stays unknown; confirmed unavailable postings stop
new provider work while preserving the accepted score and evidence. Use Job
Detail’s **Check availability** to retry; see
[saved posting availability](enrichment-and-extraction.md#saved-posting-availability).

Scoring also uses your saved exact-title exclusions as part of its source
context. If those saved settings cannot be read or the exclusions are damaged,
the attempt stops before checking the posting or starting model work. Your
previous score and evidence remain available. Check workspace access and retry;
if data is damaged, preserve the workspace and consult
[Back Up And Restore](data-and-safety.md#back-up-and-restore).
Reusing an existing score does not need to read those settings; posting
availability and work ownership are still checked.

## Shared requirement meanings

The reusable catalog contains **Skills** and **Professional Experience**.
Requirements preserves each occurrence's extracted meaning, source excerpts and
source-bound notes while linking it to a reusable qualified meaning.
**Education** and **Languages** stay direct job-local demands with their own
posting and source revisions; they never enter catalog matching or achievement
wording generation. Personal traits, certifications and licenses, job conditions
and detailed years-of-experience analysis are excluded from this iteration.
Structured certification support is tracked in
[#1476](https://github.com/ebarti/JobCtrl/issues/1476).

Before extraction, a source-bound model decision identifies non-English
postings. They are skipped rather than translated or assigned zero fit. An
invalid or unavailable language decision leaves the accepted state unchanged.
If an older accepted score exists, a new unsupported-language outcome retains
that history with a visible language-refresh status; it does not produce a
replacement or make that score current.

After extraction, one model request receives the complete incoming
Skills/Professional Experience batch and the entire active catalog, including
categories, names and definitions. That request decides whether each meaning
already exists, is genuinely new or is
uncertain. Paraphrases within the same posting can share one canonical meaning
without dropping their individual occurrences. Ordinary facets of one
competence may reuse a meaning; materially different capabilities stay distinct.
Notes and meaningful alternatives remain source-bound, with no generated
importance weights or mandatory labels.

Catalog matching does not use retrieval subsets or a separate novelty judge.
If the complete input is too large, the provider refuses it, or a decision is
uncertain, accepted requirements remain available and the refresh reports the
problem. It does not silently split the catalog or publish an incomplete
replacement. Saving or correcting a requirement does not itself refresh Fit
or wording coverage; those remain explicit actions. See the
[catalog architecture](../architecture/scoring.md#requirements-catalog-matching)
for the source and revision checks.

When the complete posting text and model inputs are identical, Requirements can
reuse an accepted extraction or catalog-matching result. The selected provider,
model and effective reasoning settings must also match. A changed catalog needs
its own matching decision. Reuse keeps each job's actual source, posting
revision and occurrences separate; it does not merge openings or claim that a
new provider call occurred. Similar wording alone never qualifies for exact
result reuse.

In the Original source candidate, **Jobs → Requirements** opens the independent
canonical library; achievement tags in **My profile → Experience** open the same
meaning. Inspect category, name, definition, linked achievements, exact
wording and posting history. Your explicit associations remain **unassessed** and
cannot change fit or coverage. Current maintained wording, proposed revisions
and earlier approval history are separate; a new maintained expression requires
recorded distinct coverage that cannot reuse or consolidate the existing one.
See [Requirements Library](requirements-library.md) and the
[current-wording decision](../decisions.md#_2026-11-11-requirement-led-current-wording-and-proposed-revisions).

## Person Fit And Approved Wording

**Person fit** answers what your saved factual evidence supports. **Approved
wording coverage** answers whether exact approved text expresses a supported
requirement. A missing or unapproved expression does not lower factual fit. A
supported section-backed match does not create an achievement-wording gap.
Approving a better expression creates no new capability.

Job Detail leads with the saved score, fit band, confidence and eligibility.
Each requirement keeps its full source text, recorded outcome and point
contribution visible. Open **Assessment details** for its complete rationale,
**Evidence and provenance**, and **Correct this requirement assessment**. Source
versions and score corrections remain available beside the result.

When current approved-wording coverage is not recorded, the panel keeps that
state explicit. **Wording gap details** retains every requirement's exact status
and proposal state; **Recorded wording relations** retains the saved identities
when relations exist. This presentation does not change qualification or the
saved score. During a multi-job assessment, a completed job is identified
separately while assessment of the selected jobs remains active.

Saving facts, reviewing sources, editing requirements or approving wording does
not launch a reassessment or regenerate a resume. Choose **Update affected
matches** on Profile, Evidence Map or beside Person fit in Job Detail, or select
scored jobs in Jobs and open **Update affected matches for selected jobs**. The
action uses saved inputs and a fixed complete catalog. It reuses current
assessments, reviews affected factual support, reuses exact wording relations
and groups actual supported expression needs by achievement. It does not
rewrite already covered content for stylistic variation. Proposals require your
approval; accepted documents keep their recorded content. The
[Profile update guide](candidate-profile.md#update-affected-matches) owns
selection, work limits, the monetary-cost caveat, partial results and explicit
retry/cancellation behavior.

## How The Score Is Calculated

JobCtrl does not ask a model for one opaque number and save it. The model
classifies the evidence for each posting requirement; versioned, deterministic
code turns those classifications into the persisted 1–10 score.

Each saved job retains its occurrences, direct demands and score. Jobs that
reference the same canonical requirement may reuse a current person assessment
against the same saved facts. Similar text alone does not establish shared
identity. Direct Education/Languages assessments remain bound to their own job
and posting revision.

Before requesting qualification, Fit checks all four categories for current
accepted support and sends the entire missing set in one model request, with
the complete permitted factual inventory supplied once. Each item keeps its
own citations and assessment identity. A missing, duplicate, foreign or invalid
result refuses the batch without replacing accepted assessments or scores. An
all-current set needs no qualification call.

Evidence stays within the category's permitted sources:

| Posting demand | Permitted Profile evidence |
| --- | --- |
| Skills | Structured Skills, factual roles and achievements |
| Professional Experience | Factual roles and achievements |
| Education | Education records; professional experience only if the posting explicitly offers that alternative |
| Languages | Structured Language / Proficiency records only |

An accepted equivalent-experience route records that route without claiming a
degree. A language named in a Skills group or achievement does not prove
proficiency. The model judges degree equivalence, language proficiency and
support; code checks the source categories, identities, revisions and citations.

A job with no prior score can receive its first assessment during explicitly
started preparation, including current qualification when earlier shared
assessments predate saved Profile changes. It resolves only that job's fixed
requirements and direct demands and preserves other jobs' scores and history.
A previously scored job needs **Update affected matches** when saved changes
require new qualification. Saving a Profile starts neither action.

The current formula is **`requirement-fit-v3-equal`**. Each distinct canonical
Skills/Professional Experience requirement and each distinct job-local
Education/Languages demand counts as one item. Repeated occurrences of one
canonical meaning do not increase its points. A meaningful alternatives group
counts as one demand.

| Evidence classification | Credit |
| --- | ---: |
| Direct match | 1.00 |
| Strong match | 0.85 |
| Transferable evidence | 0.60 |
| Missing or blocked | 0.00 |

For `N > 0` accepted assessed items:

```text
qualification coverage = sum(evidence credits) / N
score = clamp(1 + floor(9 × qualification coverage + 0.5), 1, 10)
```

Rounding is to the nearest whole number, with halves rounded up. For `N = 0`,
there is no calculated score. There are no posting importance weights,
must-have multipliers, blocker caps or invented source priorities. Source notes
explain the demand and do not alter arithmetic. Invalid or incomplete
qualification cannot produce a replacement score.

For example, a direct Skills match, transferable Professional Experience,
supported Education and missing Languages demand give:

| Assessed item | Credit |
| --- | ---: |
| Skills, direct | 1.00 |
| Professional Experience, transferable | 0.60 |
| Education, direct | 1.00 |
| Languages, missing | 0.00 |

Coverage is `2.60 / 4 = 0.65`, so the score is
`1 + floor(9 × 0.65 + 0.5) = 7`: **Strong**. Scores 9–10 are **Excellent**,
7–8 **Strong**, 5–6 **Plausible**, 3–4 **Stretch**, and 1–2 **Poor**.
Job Detail retains each item's outcome, supporting sources and contribution,
plus the formula version, assessed count and qualification coverage.
An unavailable source remains unavailable rather than becoming proof of a match.

Historical results retain their original formula and evidence. The
`requirements-v2` generation starts with an empty active catalog and never
promotes an old meaning merely because its fields resemble the new contract.
Older accepted scores and resumes remain available with a contract-change
refresh status; they do not establish current ranking or composition readiness.
Only a successful explicit refresh publishes replacement accepted pointers.
Failure, cancellation or incompatible operation replay cannot replace that
accepted history. See the [upgrade boundary](data-and-safety.md#typed-requirements-upgrade).

### When Requirement Rows Are Unavailable

The current Python source does not create a replacement score from missing,
stale or incoherent qualified requirements. Job Detail keeps the prior accepted
score with its stale status, or shows that no assessment is recorded yet. There
is no word-overlap or opaque dimension-score fallback. Historical reports retain
their recorded policy and evidence until an explicit refresh successfully
publishes a current requirement-led score.

### Score, Confidence, And Eligibility Are Different

- **Confidence is a review signal, not a points adjustment.** Low confidence
  tells you to inspect the evidence; it does not automatically lower the score.
- **Eligibility is recorded separately from fit.** A blocked assessed item
  receives zero credit without capping the score. Downstream safety and
  eligibility gates remain separate from the arithmetic.
- **Compensation preferences never block tailoring.** A posted salary below
  your preferred range remains visible as an auditable warning, including the
  parsed amount and source, while the job continues through materials.
- **The minimum-fit threshold does not change the saved score.** It decides
  whether an existing score is eligible for materials. Changing it does not
  call the model or recalculate the score. A below-threshold decision is shown
  on Tailor and Apply as `skipped` with `MIN_SCORE` and the exact
  score/threshold pair; it is not pending work or a generation failure.
- **A correction retains its own authority.** Your correction creates a new
  reviewed score version and a calibration anchor. An explicit re-score runs
  the current policy again against the current canonical inputs.

### Indexed Scoring Keywords

Each score version stores its keywords in a normalized, indexed relation keyed
by tenant, job, and score version. Historical versions remain auditable, but
Jobs filtering and `GET /v1/scoring/keywords` use only the score version that
the current projection renders. The aggregation returns both the canonical
normalized key and a display spelling with its score version and job count.

`GET /v1/jobs?normalizedScoreKeyword=...` accepts the exact canonical key from
that aggregation. Normalization is owned by persistence, including Unicode
case-folding; clients do not guess or re-normalize display text.

## What You Can See And Control

Scoring runs inside Discover preparation. The ordinary **Start search** action
keeps its durable search identity open
through initial assessment of its newly saved jobs. It runs enrichment, role
analysis, Requirements and Fit, with no wording preparation or resume generation.
Source completion and source counts do not stand in for fit completion. An
assessment failure is a per-job outcome; earlier accepted records remain.
The explicit `assess` preparation recipe applies those same prerequisites and
person-fit work to selected saved Job IDs without another search. Existing scores
made stale by Profile or catalog edits still require the manual affected-matches
decision; search never expands into that refresh.

Review the recorded results on the current product surfaces:

- `/jobs` exposes fit-score filters, sorting, bands, and stage state.
- `/jobs/:jobId` shows the employer analysis, score breakdown, confidence,
  hard blockers, matched/missing/transferable signals, requirement-fit report,
  policy metadata, correction history, and stale state when recorded. Profile
  evidence attached to a requirement resolves through the Evidence map into its
  title and a useful source excerpt; unresolved references are labeled
  unavailable, with the raw storage key kept under **Technical details**.
  Each requirement's **Show evidence / Hide evidence** control operates
  independently. Every requirement starts expanded, including matched,
  transferable, missing, blocked, and unassessed requirements. The title, tier,
  importance, and match status remain visible when collapsed.
  A new analysis generation resets these defaults; ordinary page updates preserve
  your open cards. Fit evidence must match the current analysis and requirement.
  Resume coverage must separately match the requirement recorded when that
  resume was generated. If that source identity is unavailable or changed,
  coverage is marked **not recorded** while the accepted resume remains available.
- `/evidence-map` works in the opposite direction: it shows where a profile
  achievement or skill was used by requirement-fit and generated materials.
- `/settings` owns scoring and target guidance. Guidance influences subsequent
  scoring work but is not candidate evidence.
- `/settings/models` selects employer-analysis perspectives. Their execution,
  failure, and fallback behavior belongs to
  [Discovery](discovery.md#employer-analysis-perspectives).
- `/discovery` owns the minimum-fit eligibility threshold. Changing that
  threshold can make persisted scores eligible or ineligible for materials; it
  does not rewrite the score or call the scoring model again.

From the Job Detail workspace you can record a corrected score with a rationale
or ask for an explicit re-score against the current policy. The Jobs toolbar also
offers bounded current-policy maintenance for selected or outdated scores.
A correction and a re-score are different: correction records your reviewed
decision; re-score runs the current scoring pipeline and creates a new model-
derived version.
Manual corrections carry the existing requirement evidence forward to the new
score version, preserving its original profile and employer-analysis provenance.
They do not reassess that evidence. Post-edit preparation for a previously
scored job that needs updated qualification asks for **Update affected matches**
first; it cannot bypass the manual boundary by silently refreshing from a
tailoring request. Existing
accepted resumes remain available, and opening their editor does not start a
score refresh.
Resetting stale scores prepares their stages for another run; it does not run
scoring. The suggested `jobctrl score --rescore` command starts the scoring
queue for eligible enriched jobs, including jobs with existing scores; it is not
limited to the selected reset jobs. It uses the normal provider and budget checks.
If employer analysis changes after the last assessment, Job Detail labels the
requirement fit outdated and offers a per-job re-score. The earlier score and
accepted materials stay available while the new assessment runs. Jobs with an
analysis but no saved requirement assessment are labeled not assessed instead.


The ideal-candidate narrative describes the candidate's capabilities and the
role's needs directly. Explanations of expert agreement or how the profile was
determined belong in the analysis audit metadata. Generation rejects such
process commentary and re-asks before accepting a new record. Old analyses
remain readable; a supported analysis refresh replaces invalid prose only after
its replacement passes validation, preserving the previous generation on failure.

Low confidence means the evidence needs review, not that the fit is necessarily
low. A high score with evidence you cannot personally support is likewise a
reason to correct or investigate it.

### Scoring priorities {#runtime-setting-scoring-priorities}

**Settings → General → Scoring guidance → Scoring priorities** adds user
guidance describing what strong-fit jobs should demonstrate. It is consumed by
newly started scoring work. It is policy input, not candidate evidence, and it
does not rewrite historical score versions.

### Target role guidance {#runtime-setting-target-role-guidance}

**Target role guidance** adds role or company preferences to newly started
scoring work. It supplements the target-search titles owned by Discovery; it
does not add, remove, or rename those search targets.

A profile change records pending work without starting preparation. Use
**Update affected matches** after saving the changes you want included. The
action reviews the saved requirement catalog, updates only affected person
assessments and recomputes scores for the selected jobs. New evidence is also
considered for requirements previously missing support. A wording proposal
requires your explicit approval and does not lower your factual fit score.

The action displays its work limits, progress and cancellation control. Edits
made while it is queued or running remain pending for another deliberate update.
It does not restart itself when it saves results or when you approve wording.
Previously accepted records remain available on failure. If factual updates
completed but wording preparation did not, the result reports that boundary.

## Source Of Truth And Ownership

- **The posting snapshot owns employer claims.** Analysis evidence spans must
  match the captured posting text after formatting-only normalization. A model
  paraphrase is not source evidence.
- **The Candidate Profile owns candidate claims.** Scoring receives an immutable
  profile snapshot; neither analysis nor scoring can add experience or skills.
- **Requirements owns typed posting demands.** It records reusable
  Skills/Professional Experience meanings, job-local Education/Languages demands,
  occurrences and generation identity. Discovery supplies separate role and
  employer analysis; [its perspectives](discovery.md#employer-analysis-perspectives)
  do not create source importance weights or candidate facts.
- **Scoring owns the decision record.** Versioned `job_scores` rows hold the
  resolved score, criteria snapshot, requirement-fit evidence, and non-sensitive
  trace. `scoring_policies` owns rubric/policy versions and calibration anchors;
  stale markers record when an older score awaits deliberate adoption of a
  newer policy.
- **Resumes owns document composition.** It consumes current recorded canonical
  coverage for approved achievement wording. Direct Education/Languages demands
  do not enter wording generation, and current section-backed support creates
  no achievement-wording gap. Other baseline sections remain intact.
- **Operations owns display projections.** Jobs reads expose persisted analysis
  and score evidence. They do not call a model or recompute a score on request.
- **Explicit feedback remains history until an owning policy says otherwise.**
  Score corrections and their anchors are auditable inputs, but Apply candidate
  acquisition does not apply a second feedback-based rank adjustment or let an
  unaccepted learning recommendation reorder jobs.

The model may extract structured evidence and propose fit. The final persisted
decision is resolved through the versioned scoring policy, so a raw model
opinion is not the sole authority. Scores are for a job seeker ranking jobs,
not for an employer ranking people.

## Lifecycle

1. **Start with an enriched posting.** Scoring only consumes the usable job
   record and its captured content.
2. **Order work.** A bounded scoring pool uses recency and stable IDs. Vocabulary
   overlap does not decide which jobs are scored.
3. **Consume accepted typed demands.** Requirements supplies reusable meanings,
   job-local demands and exact posting evidence. Fit does not create a parallel
   interpretation of the posting.
4. **Resolve fit.** The scorer combines that analysis, the profile snapshot,
   user guidance, and current policy into structured fit evidence and a policy-
   resolved score.
5. **Persist and project.** The score version, criteria, trace, requirement-fit
   rows, analysis generation, and events are saved before Jobs and Evidence
   projections expose them.
6. **Correct or evolve deliberately.** A user correction creates a new score
   version and a calibration anchor. A new scoring policy can mark comparable
   older scores stale, but it does not silently replace them; an explicit
   re-score adopts the current policy. Resetting stale work keeps the saved
   score visible and marked stale until a matching replacement is committed.
   Failed or canceled work, or reuse of the saved score, does not clear the
   warning. A later policy change remains visible if an older assessment finishes.
   Reset leaves queued or running scoring alone. Wait for it to finish, then
   retry the reset if the score is still stale; an already-pending score is
   ready for scoring. Reset only targets active jobs: hidden, deleted, or
   inactive postings retain their saved scores and warnings. Unhide or restore
   a job, or wait until the posting is active again, before retrying its reset.
   A manual correction also retains any existing warning.
7. **Review profile edits on request.** Saving your profile does not update scores
   or regenerate materials. **Update affected matches** uses one impact decision
   across the requirement catalog when saved factual inputs changed. Shared
   requirements are not reassessed separately for every job. Current decisions
   and approved-wording bindings are reused; actual expression gaps are grouped
   by achievement for reviewable wording preparation. A failed or stale operation
   retains accepted records and reports the remaining work. Initial assessment
   of a newly captured job remains part of its explicitly started preparation.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Review Jobs](normal-flows.md) and [Discovery → Employer Analysis Perspectives](discovery.md#employer-analysis-perspectives). |
| HTTP contract | Jobs list/detail reads, `GET /v1/scoring/keywords`, `POST /v1/jobs/:key/score-correction`, per-job current-policy re-score, and bulk/stale-score actions; see [Jobs & Materials API](../api/jobs-and-materials.md#jobs-and-evidence) and the [complete lifecycle contract](../api/complete-contract.md#jobs-read-model-and-lifecycle). |
| Worker implementation | `workers/automation/src/jobctrl/features/fit/` owns qualification, coverage and manual refresh. `features/requirements/` owns qualified meanings and occurrences; `features/profile/` owns facts and wording approval. |
| Product components | `apps/web/src/contexts/scoring/`, `apps/web/src/contexts/materials/components/EmployerAnalysisPanel.tsx`, and the Jobs detail/triage views. |
| Deep architecture | [Scoring](../architecture/scoring.md), [Materials → Canonical Employer Analysis](../architecture/materials.md#canonical-employer-analysis), and [Stage Walkthrough → Score](../architecture/pipeline/stages.md#score). |


## Semantic Determination Authority

Scoring work limits use recency and stable IDs. The model supplies source-bound
verdicts for exact canonical or job-local demand IDs, using only the permitted
Profile sections. Code validates structure and resolves equal-item credits,
rounding and bands. No prose reclassification or lexical retrieval decides
support, degree equivalence, language proficiency or eligibility.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.

## Optional company context

[Company briefings](company-briefings.md) add separately dated public context beside Role Analysis. They are explicitly configured and refreshed, shared across confirmed company/job links, and do not change fit scores or posting requirements.

## Selected-job demand and learning milestones

Open **Selected-job demand and learning milestones** on `/evidence-map`. Name a
cohort, choose its selection date, select up to 30 saved jobs and optionally
record aspirations. **Review selected cohort** makes no model call. It shows
unique selected identities, descriptions available for analysis, missing
descriptions, exact duplicate application-identity groups (shared URL and identical posting content) and usable confirmed
achievement sources. Repeated selections and shared recorded application URLs plus exact title/employer/description content
count once; duplicates with different identities may remain. The selection date
labels your cohort, not the publication dates of its postings.

**Compare reviewed postings** sends the reviewed descriptions and unique,
confirmed, supported/verified achievement evidence to the configured model in
the Profile accounting lane. The saved comparison identifies its profile
version, source snapshots, verbatim posting and achievement citations,
provider/model, prompt/schema versions and determination fingerprint. Counts
refer only to distinct analyzed postings in this cohort. Missing evidence means
no confirmed support was found in these sources; it does not establish inability
or a market-wide skills statistic. Declared skills and aspirations cannot serve
as confirmed evidence.

Choose each proposed learning or evidence-building milestone explicitly. Its
origin retains the exact cohort revision, comparison, citations, completion
criterion and selection time. Save progress and a completion-evidence statement
or artifact reference; completion requires a nonempty statement. Status changes
retain a revision history. These statements remain user-attested activity, never
a readiness score or an automatic skill, Profile, fit, materials or Apply update.
Confirm any new achievement through the existing Candidate Profile review flow.

Profile/posting changes mark historical comparisons for review. Refreshing a
cohort can change its selected jobs and aspirations; previously chosen milestones
retain their original sources and show that the cohort changed. A failed
refresh or stale revision preserves the last accepted comparison and your draft.
The interface shows up to 20 recent cohorts, 100 milestones and 50 recent
activity revisions per milestone; older records remain in local storage.
The browser-only demo explains that this capability requires a local workspace.
