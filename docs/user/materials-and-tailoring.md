---
description: "Create truthful job-specific resumes and interview preparation with inspectable evidence, accepted history, and separate personal notes."
---

# Materials & Tailoring

Materials are the job-specific resumes, PDFs, and related review
records JobCtrl creates from canonical profile evidence and the target posting.
Tailoring is the versioned, gated process that selects and renders those claims
without turning the job description into evidence about you.
For a plain-language walkthrough of that boundary, read
[Resume Tailoring Without Fabrication](../guides/resume-tailoring-without-fabrication.md).

Concurrent preparation attempts keep their files separate. If saved materials
change before an older attempt finishes, that attempt cannot replace the newer
accepted material; JobCtrl marks it stale when it still owns the work so it can
be retried with the current sources. A PDF whose save acknowledgement is
uncertain is kept for inspection rather than deleted.
If another preparation is still running, reusing the earlier approved material
leaves that work running and able to save its replacement.

Retrying a failed Tailor stage preserves approved material and its
review evidence. If an approved resume already exists, a plain retry
reports that a replacement requires an explicit re-tailor; it does not start a
replacement automatically. A newer incomplete generation may be cleared for
recovery while the earlier approved material remains available.

Profile facts and approved wording provide the evidence for the resume. A job
posting supplies employer requirements and context; it does not establish a
candidate fact. Unconfirmed achievements do not authorize new claims.

Before generating a resume, JobCtrl reuses a posting observation
from the preceding six hours, including an uncertain observation. It attempts a
refresh when no recent observation exists. Usable content can feed preparation
while availability remains unknown; reusing uncertainty does not mark the posting
active or change its background retry schedule. Confirmed unavailable postings stop new work;
failed checks preserve accepted materials and approvals. Use Job
Detail’s **Check availability** to retry; see
[saved posting availability](enrichment-and-extraction.md#saved-posting-availability).
When a posting becomes unavailable after batch selection, that member is skipped
while the other selected jobs continue. A temporarily unavailable source remains
a reported item error; it does not prevent its peers from finishing.

Marking a job skipped stops new automatic resume generation
for that job, including preparation chained from URL imports and Discover. The
current Skip is checked again before each new material stage starts. An explicit
Tailor or Re-tailor action can request materials while Apply remains skipped;
all score, eligibility, source and review prerequisites still apply.
Use **Cancel** to stop work already in progress. A safe pre-submission Apply reset
allows normal automatic eligibility again. Recorded submit intent cannot be
cleared by reset; see [Skip and safe reset](apply.md#skip-and-safe-reset). A minimum-score policy skip remains
a separate decision controlled by the score and materials threshold.

## How JobCtrl Chooses A Resume

Preparation binds the resume to saved profile and job sources. You can inspect
its evidence, coverage, review findings, and accepted artifact before use. A
failed refresh preserves the last accepted resume.

::: info Accepted transformation target
The [Python transformation plan](../plans/2026-11-06-python-transformation.md)
specifies a full-baseline resume: retain every approved role and achievement,
retain the other baseline sections including Language / Proficiency, select one
approved wording per achievement, and report layout conflicts rather
than silently dropping content. Person fit remains separate from document
coverage. The plan specifies mechanical source and approval checks and one
advisory coherence review, with explicit acceptance available for a mechanically
valid document despite a review finding or timeout. Baseline-copy mode makes no
resume model calls. These are accepted target behaviors; implementation and
integration verification are in progress.
:::

The `requirements-v2` contract uses reusable Skills/Professional Experience for
achievement-wording coverage. Direct job-local Education and Languages demands
do not enter wording matching or generation. Current section-backed evidence
does not create an achievement-wording gap. Reuse existing approved expression;
new wording needs an actual unsupported expression need and factual achievement
support, rather than stylistic variation. Each eligible canonical requirement
has one internal composition policy point, without attributing importance
weights or mandatory labels to the posting. Tailoring preserves all baseline
sections and changes only approved achievement wording.

## What You Can See And Control

Provider and model availability depends on the configured provider and the
current account. See [model configuration](configuration.md#llm-providers) for
the available choices.

The Original redesign source candidate offers one job-level **Prepare resume**
action with **Tailored resume** and **Full baseline** choices. It sequences the
existing requirement, person-fit, composition, advisory review and rendering
owners under the saved limits. A result is ready for your review, not silently
accepted. **Request stop**, unfinished-work recovery and task-local progress keep
the same job and durable request identity. The
[redesign ledger](../plans/2026-11-11-original-app-redesign.md) records integrated
verification separately from source implementation and release availability.

Focused **Re-tailor** and other maintenance recipes remain in **Preparation
options and history** and supported bounded bulk work. They use their own
explicit scope; ordinary Profile or wording saves trigger no preparation.
Your accepted materials stay available until a replacement is accepted,
including when refresh fails. Manual document drafts are preserved before new
preparation is admitted.

The selected **Applications** review uses the same mode + **Prepare resume**
controls when Preparation is mounted. In a reduced composition without that
optional feature, **Resume type → Create resume** retains a direct document draft
with explicit checks/rendering, acceptance and export. Neither path grants an
application approval or external execution permission.

Composition freshness is a separate read from document acceptance. Changed
Profile, requirement or maintained-wording bindings can make the saved
composition stale while its draft/accepted record remains available. Choose
**Prepare resume** when you want a current candidate; a freshness read does not
regenerate it. Full-baseline freshness follows Profile sources without needing
Fit/requirement coverage to become current.

When you manually correct a score, the existing requirement evidence is carried
forward to that score version. Its original profile and employer-analysis
provenance remains visible; changing the score does not claim that the evidence
was reassessed. Re-tailoring also repairs older corrections whose evidence was
left behind, only when the recorded scoring determination identifies its source.

The user-visible surfaces divide the work:

- The selected job's **Resume** tab (`/jobs/:jobId`) shows the actual Plate
  editor, readiness, accepted artifacts and per-job preparation/review controls.
  **Fit & overview**, application, people/interviews and history remain nearby.
  Accepted artifacts appear first, newest recorded generation first;
  older approved artifacts remain visible. Canonically superseded versions
  remain inspectable in the collapsed **Superseded artifacts** list.
- **Jobs → Materials** (`/artifacts`) shows **Saved materials**, including drafts,
  accepted versions and history. Use **Search saved materials** or **Refresh
  materials** for the cross-job list; `/artifacts/:artifactId` opens a
  route-level inspector with stored validation, provenance, coverage, voice,
  template, risk metadata, and same-job comparison followed by the full-width
  real preview when supported.
  Canonical evidence foreign keys resolve to human-readable Evidence-map titles
  and excerpts with links back to the owning entry. An unresolved legacy key is
  labeled unavailable and stays accessible under **Technical details** rather
  than being presented as user-facing evidence.
- The job **Resume** tab opens that job's editor directly. The cross-job
  **Applications** queue (`/apply-review`) remains available for exact outgoing
  packet review. Text edits belong to the position's document draft and leave the
  Candidate Profile unchanged. The editor, revision,
  replacement-render, submission-approval lifecycle, and distinction between a
  local editor export and an approved artifact are owned by
  [Apply](apply.md#materials-and-resume-rendering). Its Plate toolbar can export
  the current document, including unsaved edits, directly to a PDF download.
  The selected template's margins apply to every exported page, including
  continuation pages; the download keeps searchable text aligned with the page.
  Section and entry headings stay with their first content line at page breaks.
  Bullets and short paragraphs stay together when they fit on one page.
  Review comments remain available on long resumes too. If saving comments
  fails, retrying saves the existing findings without running another review.
- **My profile → Search preferences** (`/preferences`) retains tailoring permissions, writing style, resume templates,
  and the default template; Apply Review can override the template for one job.
  Template payloads hold style/layout only, not candidate or job facts. An
  unsaved template draft remains available when saved templates refresh or you
  switch between templates during the same session. Template settings show the
  selected saved version and the exact version currently used as the default.
  Saving a new version does not change the default until you choose **set
  default** or **save default**. If saving succeeds but the default change is
  not confirmed, the saved version remains available. Check the current default
  before retrying **set default**. If templates cannot refresh, the panel labels
  the last read default and offers a retry before changing the default. A later
  successful read that shows the requested version clears the unconfirmed notice.
- **Settings → Connections** contains provider and model controls; `/settings/models`
  remains a supported deep link to that panel. The current fields
  and fallback rules belong to [Configuration](configuration.md).

**Materials ready** means the accepted resume text and submission PDF are
available for review, including while a replacement is queued or running.
Missing profile attestations remain visible as application prerequisites and do
not mean material generation is running. Missing resume text or PDF reports
**materials preparing**. Stage and apply-run failures still report repair, retain
accepted review evidence, and preserve all approval and submission gates.

Generated resume PDFs keep the selected template's page insets on continuation
pages, for both A4 and Letter, and keep section headings with their content.
Text flows to another page when needed; the
renderer does not shrink the font or remove accepted content to force a fit.

Generating materials, choosing a default template, revising a resume in Apply
Review, and approving a live submission are separate decisions. Materials
hands accepted generations to Apply; it does not own submission approval.
Likewise, **Export PDF** is a browser-local copy of the current editor state. It
does not save the draft, render a replacement generation, register an artifact,
or make the exported file eligible for submission.

## Interview Preparation

Open **Jobs → Interview library** (`/interviews`) to explore the installed question library.
Browsing works without a job or provider call. Search question text,
responsibilities, or competencies; filter by topic, role responsibilities, answer format, and source,
and switch between graph and list. The selected card and filters live in the
URL, so you can bookmark the same view. The list provides the same card content
and preparation actions as the graph.

The library contains 121 active question families across 15 topics, with 57
sources and 20 author groups. In **Graph**, **Questions** shows all matching
questions grouped by topic, with editorial connections between topics. Choose a
topic to read its question labels. **Sources** groups research resources by
author; choose an author, then a source to explore its linked questions.
Selecting a question updates the inspector while keeping the catalog map
available. Drag empty space or use the focused canvas's arrow keys to pan, use
the zoom controls, and choose **Overview** to return to the unfiltered map.

The selected card's inspector has **Answer**, **Rubric**, and **Sources** tabs.
**Answer** contains guidance, responsibility adaptations, alternatives, probes,
failure patterns, and synthetic illustrations when present. **Rubric** contains
draft criteria for reflection; do not add them into a readiness score.
**Sources** shows attribution, actual reading coverage, and original resources.

**Connections and saved evidence** is a separate, focused view of the selected
card's relationships and, when a job is selected, personal evidence. Source and
author attribution, editorial related-question edges, and accepted personal
evidence have different meanings: research supports guidance; it cannot prove
that you did something. Selecting a resource or following an editorial edge
does not select accepted profile evidence for preparation.

::: warning Research draft and beta output
The source ledger records actual reading coverage and distinguishes direct
interview guidance, extrapolation from leadership practice, and editorial
synthesis. Citations do not imply author endorsement or full-book reading.
Staff/executive coverage and neighboring-question distinctions still need
review. Draft criteria and synthetic examples do not establish coaching
quality, hiring outcomes, readiness, or validated grading. Review generated
personal claims against their linked evidence before relying on them.
:::

B11 asks what makes a decision good, separating the reasoning available at the
time from its eventual outcome. TS09 asks the same for technical decisions,
including requirements, realistic alternatives, whole-life costs, and conditions
that would change the decision. These principle answers need criteria, limits,
and application rather than a forced STAR success story. C07 persistently asks
for the employer's budgeted compensation range first, including ambiguity and
redirection; it must not invent leverage or reveal an inferred private minimum.
A deliberate user-chosen exception is a choice, not a competency failure. C08
is retired and reserved: availability, location, travel, and authorization
remain declared checklist facts.

### Prepare For A Job

Choose a canonical job from Interviews or follow the **Interview prep** link
from Job Detail. Browsing remains available without that choice; generating
personal preparation requires a job. Set the stage and format when known, the
role-responsibility lens, and any known employer criteria. Unknown stage is
valid, and an unspecified role lens remains unknown. Employer/user-supplied
criteria remain distinct from suggestions inferred from the role; a recommendation does not prove that an employer will ask it.

Review the focused question selection and its rationale. Add or remove cards
and adjust the order before generating. A request accepts at most 16 unique,
active questions from the selected catalog revision. This bounds a generation;
it does not limit the library. Old callers without a selection receive a
a cited model selection. JobCtrl generates only the selected cards, rather than
121 personalized answers.

Choose accepted profile evidence for each selected question before generating.
You can keep automatic selection, explicitly choose up to eight evidence
records, or choose none to ask for gaps instead of a factual outline. An empty
choice is preserved; JobCtrl does not silently fill it. If the profile changes,
review and reselect against its current version before generating. Notes and
new recollections cannot be selected as accepted facts.

Generation drafts each question separately with its selected evidence, then
reviews the complete preparation. More selected questions mean more provider
calls. If a question fails its checks, generation stops and keeps your last
accepted preparation and notes.

Evidence selection precedes prose. Historical answers use relevant accepted
profile evidence; transferable experience keeps its scope limits. Principle,
situational, narrative, negotiation, and preference answers use their own
structures. An open prompt such as “Tell me about a time you handled conflict”
invites recollection; it does not establish that an event occurred.
Hypothetical reasoning, prospective first-time-manager guidance, and advertised
job responsibilities can guide preparation without implying past experience.
“I would explain what I stopped investigating and why” leaves missing particulars
for you to supply. Asking about the advertised role's expectations clarifies the
job; it does not prove that you held that role.

Specific claims or presuppositions about your history, including factual
headings, need support from that question's selected accepted evidence, even
inside future or conditional wording. Another question's evidence, source
examples, and job responsibilities cannot supply that support. Choosing no
evidence leaves focused questions and marked gaps without filling in personal
history, metrics, tools, or authority.

Factual sections cite the selected evidence that supports their claims.
Guidance and clarifying questions keep proof citations separate: they may refer
back to a supported fact and ask for missing details, while contextual question
links do not confirm personal experience.
Current approved materials provide context only when their registered artifact
bindings are valid; an unrelated or stale fit report cannot prove a personal
claim.

### Inspect History And Keep Your Notes

Accepted question outlines expose linked profile excerpts, selection rationale,
missing details, probes, and guidance references. Each generation retains its
catalog/card/rubric bindings, selected-card snapshots, automatic or user-selected
evidence mode and ordered evidence IDs for each question, profile version and
relevant evidence excerpts, job/requirement excerpts, employer-analysis binding,
approved-material references, and model/prompt/gate versions. Inspect these original inputs even
after the current profile or job changes. Changed inputs mark the prep stale;
regeneration is your decision and does not rewrite the older result.

Legacy themes, STAR drafts, gap drills, and company notes remain readable as
legacy generated prep. They have no invented question or rubric association.
Older accepted and superseded prep remains inspectable. A pending or failed
refresh, including provider or gate rejection, leaves the last accepted prep
visible.

If preparation history or saved note revision history cannot be loaded, use
the corresponding **Retry loading** button to retry that page. Your selected
questions, context, unsaved note and last accepted preparation remain available;
loading history does not generate new preparation.

Save your editable notes/outlines separately for each job and question. A note
keeps an independent revision, optional source generation, and its own factual
support label. New recollections default to unverified user statements, and a
user edit does not inherit a generated answer's passed audit. A save checks the
revision you loaded; a conflict requires reconciliation rather than overwriting
a newer note. Failed saves keep your draft available for correction and retry.
Generating replacement prep does not delete saved notes.

A note's generation origin refers to that question's retained preparation;
JobCtrl derives the matching card and input bindings. New notes for questions
outside the saved generation are independent, with no generation-context
claim. Editing an existing note keeps its origin instead of attaching it to
newer prep. If that generation was deleted, a normal edit becomes independent;
the earlier note revision keeps its original provenance.

Reopen the job/question bookmark to edit an existing note for a retired or
unavailable card. Start new preparation or an independent note with an active
card.

Question choices and unsaved notes survive page navigation within the current
app session. Save a note to retain it across a browser reload; private draft
text is not stored in the URL or browser storage.

Preparation does not modify Profile, fit scores, Discovery intent, approved
resumes, or Apply state. Review and save a true new fact through
[Candidate Profile](candidate-profile.md). Post-interview reflections remain
manual Apply outcomes linked to a prep generation; they are separate from
preparation notes. See [Outcomes & Feedback](outcomes-and-feedback.md).

Reusable preparation across jobs or without a job, typed rehearsal, calibrated
assessment, and live assistance are future phases. This release has no answer
grading, readiness score, transcript upload, microphone, or in-session answer
surface.

## Policy History And Rollback

The retained **Learning recommendations** card, reachable through workspace
diagnostics, is a review boundary, not an
automatic tuning loop. Accepting a pending, active recommendation appends a new
Materials tailoring-policy revision linked to its recommendation and review;
rejecting it leaves the current revision unchanged. Recommendations whose
source evidence was tombstoned are inactive and cannot be accepted until they
are deterministically re-derived.

The recommendation list and each recommendation's evidence have separate page
controls. They show the current page, the number displayed, and the total
recorded items. Open evidence to see its source identifiers, revisions, jobs,
and roles. If another page cannot be read, the last displayed page remains
available and its failed read can be retried. Reviewing a recommendation does
not regenerate the recorded list or its evidence.

**Tailoring policy history** lists every current and superseded revision,
allowlisted learned rule, safe recommendation/review reference, restore
provenance, and creation time. Choose a superseded version to review the
transition from the displayed current version, then confirm the user-requested
restore. It appends a revision without editing or deleting earlier history. If
another session changes the policy before confirmation, the restore is refused;
review the refreshed history and start a new restore. Retrying an unconfirmed
request uses the same command and returns its recorded revision if it already
committed. A later revision can be current even when the receipt reports an
earlier successful restore. Acceptance and restore affect future tailoring-policy
resolution only. They do not re-score jobs, re-tailor existing materials,
replace accepted artifacts, alter the Candidate Profile, or change Apply
decisions. Use the normal explicit re-tailor action when you want existing work
to adopt the current policy.

## Source Of Truth And Ownership

The inputs have intentionally different authority:

| Input | Owner | What it may prove |
| --- | --- | --- |
| Candidate facts and achievements | Candidate Profile snapshot | Experience, skills, education, Language / Proficiency, metrics, dates, titles, employers, and other claims about you. |
| Job requirements and employer wording | Requirements snapshot bound to the accepted posting | Reusable Skills/Professional Experience meanings and direct job-local Education/Languages demands. It is target context, never candidate evidence. |
| Requirement fit | Scoring | Which requirements are matched, transferable, missing, or blocked, with allowed evidence links. It must describe the same posting-analysis generation Tailoring uses. |
| Tailoring and model policy | Preferences, Settings, and versioned Materials policy | What transformations and gates may run. Policy cannot create a fact. |
| Accepted output | Materials generation and registered artifacts | The exact text/HTML/PDF selected for review or Apply, plus its audit data. |

Every rendered resume line that makes a candidate claim should trace to
canonical profile evidence. Keyword coverage is computed from the actual
rendered, grounded text and persisted with the generation. The artifact read
model does not infer a missing list from the job description later, and it
reports absent audit data as unrecorded rather than as zero coverage.

Typed extraction retains the source's notes, alternatives and original
occurrence meaning alongside its canonical binding. Personal traits,
certifications/licenses, job conditions and detailed tenure analysis are outside
this iteration. They cannot become achievement-coverage failures or consume
wording retries. Structured Languages support comes only from the Profile's
Language / Proficiency entries, and an explicit equivalent-experience Education
route never becomes a degree claim. Other safety, application and preference
controls keep their own authority.

If requirement-fit evidence is missing or belongs to an older posting-analysis
generation, JobCtrl shows Tailor as blocked by Score and asks you to rescore the
job. This prerequisite block does not consume a Tailor retry. It prevents an
empty coverage plan from being retried as though it were a model-quality
failure.
Legacy-generation requirements and Fit results likewise require explicit
refresh before they establish current composition readiness. Older accepted
resumes remain available with their original provenance and bytes; a failed
refresh or incompatible operation cannot replace them.

When rescoring restores missing evidence, JobCtrl returns that retryable Tailor
block to pending after checking the current score and posting analysis. The
worker can then continue automatically after the normal cooldown and eligibility
checks. This preserves prior attempts, canceled decisions, and approved resumes.

The minimum-fit policy is a different terminal decision. When the current
score is below the live materials threshold, Tailor and Apply are
persisted as `skipped` with the `MIN_SCORE` code and the exact score/threshold
pair. They do not remain `pending`, because no automatic work owns them.
Lowering the threshold or recording a qualifying current score restores only
these threshold-owned skips. The per-job **Tailor this job** action is an
explicit low-fit override for the requested resume and its PDF export. It does
not change the recorded score or global threshold, and does not weaken
score hard blockers or material validation and quality review. The accepted
generation retains this request flag, so later Discover/recovery sweeps do not
hide those materials solely for being below the automatic threshold. Another
generation does not inherit the exception; a current hard blocker or missing
score still follows normal suppression policy.

Tailor failures also own their downstream state. If Tailor is retryably failed
or has exhausted its durable attempt budget, Apply shows `blocked`
with the exact Tailor failure/exhaustion reason instead of implying pending
work. Retry or reset Tailor first. Once Tailor succeeds, JobCtrl restores only
those Tailor-owned dependency blocks and does not disturb a skipped or canceled
decision.

Generated files stay under the local JobCtrl workspace and are served only
through registered artifact rows. An artifact route cannot open an arbitrary
filesystem path. See [Data, Privacy & Safety](data-and-safety.md#local-data) for
the local-file boundary.

## Lifecycle

1. **Check inputs.** Preparation uses saved profile sources, job requirements,
   eligibility, and the current request.
2. **Prepare and review.** The resulting resume has traceable source and review
   information. Review it before accepting or using it for an application.
3. **Render and retain.** The accepted text and its document artifacts are
   registered for review. A failed replacement leaves the prior accepted
   material available.
4. **Decide separately.** Generating or editing a resume does not approve an
   application or authorize submission.

The same preservation rule applies to stored interview prep and outreach draft
generations: a failed replacement does not destroy the last accepted record.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Generate And Inspect Materials](normal-flows.md) and [Apply → Materials And Resume Rendering](apply.md#materials-and-resume-rendering). |
| HTTP contract | Artifact list/detail/preview routes, `/v1/resume-templates`, per-job generate/re-tailor actions, and `/v1/learning/recommendations` plus `/v1/learning/policies/materials`; see [Jobs & Materials API](../api/jobs-and-materials.md) and the [complete learning contract](../api/complete-contract.md#feedback-learning-and-policy-history). Apply Review routes are owned by [Apply](apply.md). |
| Worker implementation | `workers/automation/src/jobctrl/domain/materials/`, `workers/automation/src/jobctrl/scoring/tailor.py`, and `workers/automation/src/jobctrl/infrastructure/materials/`. |
| API and web implementation | In `apps/api/src/`: `resume-review-drafts.ts`, `resume-templates.ts`, and `read-model.ts`; in the web app: `apps/web/src/contexts/materials/`, `apps/web/src/views/artifacts/`, and `apps/web/src/views/apply-review/`. |
| Deep architecture | [Employer Analysis & Materials Audit](../architecture/materials.md), [Tailoring Contract](../architecture/tailoring.md), and [Stage Walkthrough → Tailor](../architecture/pipeline/stages.md#tailor). |


## Semantic Determination Authority

When a model determines semantic support, its decision is source-bound and
recorded with provenance. Code validates IDs, quotations, exact values and
versions; a missing source is not inferred from word overlap. Interview
generation isolates each question's selected evidence, and an explicit empty
selection produces gaps. Failed refreshes keep accepted material available.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.

## Editable DOCX Export

In **Job Detail → Artifacts → Editable DOCX**, choose **A4** or **Letter**, then
select **Export resume DOCX** for the accepted
generation you want. The browser downloads the new document. **Retained DOCX
exports** keeps each successful export available with its paper size, source
generation, language, creation time and formatting warnings. **Download DOCX**
retries a download without creating another export.

The source must still match the version displayed when you click Export.
If it changes or loses acceptance, refresh the export list before trying again.
Missing source files are shown as unavailable. If a download fails, the retained
export stays in the list. Downloads verify the registered file's content hash;
restore a missing file or generate a new export if its retained bytes changed.
The public demo explains that this capability requires a local workspace.

You can also export from the CLI using the saved artifact ID and generation:

```sh
jobctrl material-export JOB_ID --source-artifact-id SOURCE_ID --generation 1
```

This creates a new editable Word document in the local workspace and prints a
JSON receipt containing its path, registered artifact ID and formatting limits.
Use the canonical Job ID and accepted source artifact ID shown in Job Detail or
Artifact Detail. Export requires an approved text artifact; drafts, rejected or
superseded materials and PDF/HTML inputs are refused.

The document preserves the accepted text, dates, contacts, Unicode, line order,
blank lines and bullet markers. Standard JobCtrl resume section headings become
Word headings. Other resume layouts remain literal paragraphs, with an explicit
warning. The export uses
a simple single-column layout: it does not reproduce PDF pagination, HTML/CSS
styling, images, columns, automatic hyperlinks or custom fonts. Bullet markers
remain editable text with hanging indentation, not automatic Word numbering.

The default page size is A4; use `--paper Letter` for US Letter. A recorded source
locale is preserved. When the source has no locale, the document uses `und`
(undetermined); `--locale fr-FR`, for example, labels that existing language.
It never translates or reformats dates. A conflicting recorded locale or an
unsupported format/setting fails explicitly. Reviewed translations continue to
use the separate [locale-variant export](locale-variants.md).

The receipt and document metadata bind the source ID, generation, source text
hash, source metadata hash and export settings. The receipt also records the
generated file hash. Export never rebuilds content from the current profile,
replaces accepted files, changes a review or approves an application. A failed
export retains prior exports and accepted material. Editing the DOCX in Word
does not update JobCtrl or make those edits accepted for Apply.

## Reviewed Translations

Job Detail's **Locale variants** section translates selected accepted resume
descriptions into an explicitly selected language. Original names,
titles, credentials, dates and achievements stay unchanged. Independent semantic
verification and separate terminology/formatting reviews precede locale acceptance;
unresolved terms, unsupported languages and ambiguous credentials stay explicit.
Text, HTML, PDF and DOCX share one accepted snapshot. Failed refreshes preserve
original and prior accepted material. See [Reviewed Locale Variants](locale-variants.md).

## Screening Answer Library

Materials also owns source-bound [screening-answer drafts and reusable reviewed revisions](screening-answers.md). Application-specific question versions, review and manual-use history remain owned by Apply. Failed refreshes retain accepted answers and material bytes.
