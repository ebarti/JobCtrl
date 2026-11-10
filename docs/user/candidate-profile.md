<script setup lang="ts">
import CandidateProfileFlow from "../.vitepress/theme/CandidateProfileFlow.vue";
</script>

# Candidate Profile

Legacy migrations preserve achievement text, scope, metrics, identifiers and
saved confirmations. Older records do not say whether a person or a historical
system writer supplied their confirmation. Profile and Evidence Map show when
that provenance needs review. New evidence-based preparation reports
`legacy_evidence_review_required` until the review is resolved; existing accepted
materials remain available. Matching wording or field values never establishes
authorship. See [Review legacy confirmations](#review-legacy-confirmations).

A Candidate Profile is JobCtrl's canonical, local record of facts about you:
your experience, education, skills, evidence, application answers, resume
baseline, and the preferences that control how those facts may be used. Scoring,
materials, interview preparation, and Apply consume versioned snapshots of
this record; they do not rewrite it to suit a job.

<CandidateProfileFlow />

## How Profile Data Becomes Runtime Evidence

JobCtrl does not let a generated resume or an import silently become truth. The
profile boundary works in this order:

1. **Import creates a draft.** Resume-PDF import returns extracted
   profile data and inferred style without changing saved facts. The browser
   presents the draft on Profile for explicit section selection and acceptance.
2. **Save validates and retains the authored data.** The Python Profile service
   validates the structure and saves the complete authored document, rendering
   preferences, sources and version history in one SQLite transaction. Every
   save includes the version that was reviewed, including `null` for initial
   creation. A conflicting save changes nothing; an unchanged save does not
   advance the version.
3. **Work receives an immutable snapshot.** Other features receive copied
   facts, stable source IDs and source revisions through Profile's public
   service. They cannot read or write Profile's private tables.
4. **Fact and wording revisions remain separate.** Profile records a factual
   revision and a wording-library revision as well as the overall saved version.
   Approving a new expression does not change factual qualification. Sources and
   exact approvals remain attached to the wording that used them.
5. **Refresh preserves accepted work.** Authoring failure, invalid model output,
   cancellation or a changed source cannot replace an approved variant. A new
   document uses the current saved versions; previously accepted documents keep
   their original source and approval records.

This version boundary is what lets JobCtrl prove which candidate facts a score,
resume, or application decision actually used.

## Review An Imported Resume

The web import flow previews your PDF and asks whether to extract profile data,
style, or both. After extraction, Profile shows the returned fields as a draft.
Select the sections to keep and choose **Accept selected sections**, or reject
the draft. Any extraction warnings appear with the draft. Experience,
education, and skills are added alongside saved entries;
existing achievement evidence is retained, and extracted bullets are not
created as confirmed achievement evidence. Personal details and summary replace
the corresponding saved values only when their section is selected. Import
itself never changes the saved profile. Personal fields shown for review come
from the recorded extraction, even if the saved profile changes while the PDF is
being read. Style review includes only page and font details observed in the PDF;
other saved style choices remain unchanged when those details are accepted. If that source record cannot be verified, the PDF stays available
for retry. Older drafts whose source attempt cannot be verified stay
in browser recovery; show and copy their JSON, then import the PDF again to review
those fields.

The draft is bound to the saved profile version read before extraction. A
concurrent profile save prevents acceptance until you load the latest profile
and review and select the sections again. If a damaged draft would hide a field
that the current saved profile would change, acceptance stops; load the verified
latest profile to see the full changes and make a new selection. A failed or unconfirmed save keeps
the draft in this browser, including after a reload. A save attempt is recorded
before it is sent. After an unconfirmed result, the original selection can be
retried only while the saved profile version is unchanged; if it changed, inspect
the saved profile before removing the draft or starting another import. A first profile save is fenced against an initially absent
profile. If draft storage fails, the extracted draft remains available in the
current session and the uploaded PDF is retained; retry browser storage before
reloading. If review data cannot be verified, no save is sent; removing that
review retains the older or unexpected data for recovery. Clearing site data
removes the saved review drafts and recovery data.

Open tabs share saved review drafts. A tab checks that its draft is still at
the reviewed revision before saving, and a stale tab cannot remove a newer
revision. Removing a draft does not cancel a save already in flight; check the
saved profile before deciding what to do.
If the profile save succeeds but the draft cannot be removed, retry removal
rather than accepting the same draft again.

The selected PDF and its filename are stored in this browser so the wizard can
survive navigation and refresh. Leaving the wizard or choosing **Cancel** keeps
the saved PDF. **Remove saved PDF** clears the current selection, as does
successful import cleanup. An earlier version's separate saved copy is retained:
the upload step identifies it and offers a download when it can be read.
Removing the current selection does not erase that earlier copy; clearing this
site's browser data removes both copies. If the browser
cannot read, save, or remove its data, the wizard explains the failure and lets
you retry. A failed replacement leaves the previously saved selection unchanged.
If import succeeds but removing the PDF fails, retrying removal does not repeat
the import request. Once removal succeeds, you can choose the same PDF again
and start a new import; an identical request already running must first finish.
The completed request's PDF, filename and options stay in memory for the current
app session after the stored upload is removed. The separate review draft is
saved in browser storage before that cleanup and remains until accepted or
rejected. New drafts contain reviewable fields and the saved personal values needed
for comparison, not a copy of the complete saved profile. Older retained drafts
may still contain additional data. After accepting or rejecting one, Profile
shows a preserved legacy review: select **Show recovery JSON** to inspect and copy
its complete data before clearing browser site data. It can contain sensitive
profile information. After upgrading, close or reload all older Profile tabs and
wait for any in-flight saves to finish before reviewing imports. JobCtrl does not
automatically close or reload older browser tabs. An older tab may already have
loaded a draft or started a save; updating browser storage cannot cancel that work. If upload cleanup failed before a reload, the app no longer knows the
earlier request completed, so submitting again can repeat it.

The current version coordinates saves and removal between open tabs. If another
tab changes the selection, return to upload and choose **Load latest saved
PDF** before continuing. Removal is unavailable while that selection loads;
review the loaded PDF before removing it. If browser storage is unavailable, enable site data and retry in a current browser. Reload or close
older JobCtrl tabs: older versions cannot coordinate with each other and may
still change the earlier copy. They cannot erase the current version's record.

Reviewed multi-source intake, duplicate/conflict reconciliation and item-level
fact promotion remain **proposed, not implemented**. The [owning intake design and
current-path assessment](../plans/2026-09-21-profile-evidence-selective-tailoring.md#2-current-foundations-and-acceptance-map)
preserve explicit acceptance, unknown facts and canonical ownership. They do
not authorize generated facts.

## What You Can See And Control

Use the current web routes according to the kind of change you are making:

| Route | What it owns |
| --- | --- |
| `/profile` | Personal information, baseline resume content, experience, optional position summaries, education, skills, achievement evidence, and voluntary EEO data. The same page renders the real editable baseline resume beside the editor. |
| `/profile/import/upload` | The start of the three-step PDF import flow. You choose whether to import profile data, resume style, or both before confirming. |
| `/preferences` | Application defaults, writing and tailoring controls, resume style, and resume-template selection and editing. |
| `/evidence-map` | A read-only map from canonical achievements and skills to their uses in scores, requirement fit, generated bullets, and coverage gaps. |
| `/discovery` | Target search and Discovery controls. These are composed near the workflow that uses them rather than treated as general profile editing. |

Profile keeps the canonical editor and the real baseline-resume preview side by
side only while both remain readable; at narrower working widths the preview
moves below the editor and the resize handle disappears. Evidence Map follows
the same rule: its entry list, selected evidence, and gaps/reusable-stories
inspector stack instead of compressing the three-pane desktop workspace.

Saving facts, adding or reviewing sources, and editing or approving wording do
not run matching, scoring, authoring, or resume regeneration. Existing matches
can become out of date and stay available with their recorded source versions.
Choose **Get suggestions for target roles** in Discovery when you want
evidence-backed suggestions.

### Update affected matches

Choose **Update affected matches** on Profile, Evidence Map, or beside Person
fit in Job Detail when you want JobCtrl to review the saved changes. The action
uses the last **saved** Profile, sources and approved wording; save any edits you
want included before starting. Opening these pages or checking the status does
not start the action. A changed source or wording remains pending review rather
than becoming a current match merely because it was saved.

The action considers the complete saved requirement catalog and the selected
scored jobs. It can use your configured model to check affected qualifications
and wording coverage and prepare wording proposals. Proposals still require your
explicit approval. Each request is bounded to 100 affected requirements, 40
model call attempts, 20 wording proposals and 10 minutes. Attempts are counted
before provider and configured budget checks; the request does not impose a hard
monetary cap. When more than 100 scored jobs
are available, select up to 100 in **Jobs** and open **Update affected matches
for selected jobs**. Starting another request for
remaining jobs is a separate decision. Existing approved wording and accepted
scores and documents remain available during the update and if it fails or is
cancelled.

The panel shows the recorded phase, counts, and outcome, including a partial
result when qualification was published before later work stopped. **Request cancellation**
asks the worker to stop; wait for the recorded result rather than assuming that
the request has already stopped. A changed input can make an update stale, and
reaching a limit can leave work pending. Failed or uncertain wording requests
appear in the result; after reviewing and dismissing the completed request,
**Retry failed wording** explicitly retries the eligible listed proposals with
the current saved inputs. If several retained failures belong to one achievement,
choose one proposal for that achievement. Retrying one does not clear other
eligible failures. A still-running or unresolved request is not retried
automatically. A confirmed interrupted request can be retried explicitly; any
unknown outcome of its earlier provider call remains recorded. Review these
states before choosing a new update. If the start
response is lost, check the earlier request; an absent
record at one instant does not prove it could not still arrive. Retrying the
same request uses its original identity. If the saved inputs changed, the panel
offers a separate request for the current inputs and retains the earlier
identity for status checks.

The baseline records your authored roles and achievements. Update that source
deliberately when your experience changes; tailoring does not change Profile as
a side effect. See the explicitly labeled transformation target in
[Materials & Tailoring](materials-and-tailoring.md#how-jobctrl-chooses-a-resume).

Adding an experience, education entry or skill category creates its internal
identity immediately. You edit its descriptive fields; changing a title or label
keeps its identity and any **Must appear in final resume** selection intact.

Target Search can propose a small set of evidence-backed role titles and
historical location/work-model rows. JobCtrl generates them from the saved
profile version, even when the browser form has new unsaved edits. Each role
proposal shows its original direct/adjacent classification, supported track and
seniority, rationale, and evidence references. Editing a title keeps the
original evidence clearly separate from your edit. You can edit, reject,
deselect, or dismiss every proposal. All role and historical preference rows start unselected:
past work location or arrangement is not current search consent. Adding selected
proposals only changes the current form draft; the usual Save/autosave path
appends and deduplicates accepted titles and preserves location/model row pairs
with an expected-version check. A delayed or stale result cannot overwrite later
profile edits, and manual Target Search entry continues to work.

The Plate toolbars on `/profile` and `/preferences` include **Export PDF**. On
export, the browser downloads `baseline-resume.pdf` to its configured download
location. Export can take several seconds. Every PDF page uses the selected
template's margins, including pages continuing a long resume. Education keeps
the institution and location together beside the date, with the degree below.
Section and entry headings stay with their first content line at page breaks.
Bullets and short paragraphs stay together when they fit on one page.

On `/profile`, edits to names, address parts, email, phone, executive profile,
experience titles, companies, locations, dates, summaries and bullets, education,
and individual skills update the same draft shown by **Profile data**. Each
field is bound to its saved entry identity, including fields sharing a display
line; separators inside names or skills are preserved. Edits follow the normal
validation, undo, and autosave path. Temporarily clearing a required field does
not prevent further editing or undo; incomplete data still cannot be saved.
Conflicting boxed edits or a mismatched preview are preserved and reported.
Formatting, section headings, and link presentation remain document-local;
edit professional URLs in **Profile data**. The Preferences Plate editor remains
a presentation-only draft.

The resume presentation follows the experience sequence saved in Profile. Each
role has **Move up** and **Move down** controls for a custom sequence, and
**Sort newest first** applies the date-based order explicitly, with current
roles first. Each bullet also has **Move up** and **Move down** controls within
its role. Reordering preserves the bullet text, required selection, and the
achievement identities used by existing evidence links. The reordered lists
follow the normal Profile save and autosave path. Roles without achievement
bullets render compactly instead of reserving space for an empty bullet list.
Education entries place the institution and
completion year on the first row and the degree directly underneath.

The download is rendered from the document currently mounted in the browser,
so it includes live text and formatting while preserving the active template's
styling, margins, glyphs, punctuation spacing, line wrapping, and A4 or Letter
page size. Its visible pages use the browser's rendered output; a separate
invisible text layer keeps the PDF searchable and extractable. The **Export
PDF** action itself does not save a profile or template, register the download
as a JobCtrl artifact, or change Apply approval state.

Template editing retains your draft when a newer version appears. Review the
latest settings and choose whether to keep your changes or discard them before
saving. Keeping changes applies your edited settings over the latest version;
if both changed one setting, your value is kept. If saving a version succeeds
but setting it as the default fails, the saved version remains selectable.

Profile and preference forms validate before saving. After five seconds without
an edit, they attempt to autosave the current draft; the explicit **Save
changes** button uses the same mutation path. If a save fails, the draft and
error remain visible. An unchanged draft is not automatically submitted again;
choose **Save changes** to retry, or edit the draft to schedule another attempt.
The [Profile & Settings API](../api/profile-and-settings.md) owns the field and
version contract.

Legal or screening attestations are never inferred. Leave an answer unknown if
you cannot attest to it; Apply fails closed on required missing profile data.
The current application-field contract and failure behavior live in
[Apply](apply.md#candidate-profile-application-fields).

## Source Of Truth And Ownership

Profile-owned tables in the local SQLite database are the sole runtime
authority. The complete authored document, immutable source versions, exact
decisions and supporting attachment bytes share this owner. Browser import
drafts remain recovery data until explicitly accepted.
The profile's main ownership boundaries are:

- **Candidate Profile owns candidate facts.** A saved experience bullet,
  position summary, declared skill, application answer, or achievement record
  is evidence only because it entered through this boundary. A non-empty
  position summary appears below that role's title/date heading and before its
  achievement bullets; an empty summary adds no resume content or spacing.
- **An achievement owns its facts and sources.** A metric, ownership claim or
  outcome must retain the source that supports it. A number copied from another
  achievement or from a job posting cannot become evidence. Historical
  `resume_constraints.real_metrics` values are retained during transfer with
  their existing uncertainty; they do not independently prove a claim.
- **Preferences own permission and presentation policy.** A tailoring toggle or
  writing style can constrain generation, but it cannot create a fact.
- **Settings own shared choices, not candidate evidence.** Provider/model
  policy and budget use the shared Settings boundary. Credentials remain on the separate secret boundary described
  in [Configuration](configuration.md).
- **Discovery composes search and source operation.** Target roles and locations
  persist in Candidate Profile rows; source registry, runtime controls,
  schedules, quarantine, and capture state use Discovery-owned tables. Every
  value edited on `/discovery` is SQLite-backed. See [Discovery](discovery.md).
- **Materials own generated output.** A tailored resume, Apply Review draft, or
  rendered PDF does not back-write its wording into the profile. Promote a true
  new fact by editing the Profile itself. Interview question guidance is public
  research, not evidence about you. Generated outlines and personal preparation
  notes do not change profile facts, fit scores, search preferences, approved
  resumes, or Apply decisions. A new recollection saved in a preparation note
  remains an unverified user statement; review and save a true fact through
  Profile before using it as canonical evidence.

Interview prep retains the profile version and relevant generation-time
evidence excerpts it used. A later profile save marks that preparation stale;
it does not rewrite its history or silently regenerate it. Inspect the retained
source alongside the current Profile before choosing to regenerate. See
[Interview preparation](materials-and-tailoring.md#interview-preparation) for
question selection, notes, and accepted-history behavior.

The Evidence map composes public Profile source reads with the downstream
features that record their use. It does not create a second evidence store or infer evidence
from generated prose. Human-facing rows use evidence titles, source labels, and
bounded excerpts. Sparse storage keys remain available only from each row's
**Technical details** disclosure.

## Lifecycle

1. **Create or request an import draft.** First-run setup creates the local
   profile. Resume import extracts a draft through the API; choose its sections
   in Profile before accepting them into the saved record.
2. **Validate and save.** The API normalizes the accepted data into profile and
   child rows, records the update, and refreshes profile reads.
3. **Snapshot for work.** A scoring, tailoring, or Apply run receives an
   immutable profile snapshot and records the relevant profile version in its
   own audit data.
4. **Generate without mutation.** Scoring writes a score; Materials writes a new
   artifact generation; Apply reads approved application fields. None changes
   the underlying profile as a side effect.
5. **Keep edits explicit.** A later Profile save records a new version without
   silently running Fit or generating a document. Fit compares factual source
   revisions. Resumes checks exact current wording approvals and sources.
   Applications revalidates its reviewed inputs before accepting approval.
   Earlier accepted artifacts and their original provenance remain available.

This separation is why profile correction, score correction, resume editing,
and application approval are different actions: each updates the record owned
by the context where the decision belongs.

The accepted full-baseline composition keeps every saved role and achievement,
choosing exactly one approved wording for each achievement. Required markers
remain useful when requesting focused coaching; historical per-role ceilings
and omission settings do not silently remove baseline achievements.

Required-bullet coaching is opt-in and uses your saved Required bullets and
linked achievement evidence. Your configured LLM provider receives those bullets,
role/company context and the saved role evidence, and decides whether to offer grammar,
clarity, achievement-framing or evidence guidance. The model reads the actual
claim and support; opening phrases and lists of words do not decide findings.
A stated result and proof supporting it are separate questions.

Guidance links to the exact saved source and version. Only safe whitespace
cleanup can be accepted automatically; substantive edits and evidence additions
remain yours to make. The model is instructed not to invent facts or metrics,
but its guidance can be inaccurate or unsupported; review it against your saved
evidence. Code verifies source references and permits only exact whitespace
cleanup through Accept. It does not verify the truth of the model's free-text
advice. If your provider is unavailable or its response is invalid, inspection
fails without substitute heuristics. A failed refresh keeps the previous reviewed
suggestions and saved profile. Oversized or unresolvable sources report an incomplete inspection;
manual editing remains available. The offline public demo has no configured
provider, so this coaching capability is unavailable there. The demo disables
inspection and links to local installation; you can still edit its sample profile.

Inspection checks the daily spend budget and the profile token budget before
calling your provider. If either is reached, the message identifies the budget;
wait for the daily reset or adjust it in Settings. Provider setup failures ask
you to connect or authenticate in Settings. These budgets account for observed
usage and do not cap the tokens or cost of an individual in-flight call. One
inspection can exceed the remaining budget; only inspect when you accept that
provider cost. Coaching sends bounded source input and validates the response
size after generation.

Review each proposed wording change separately. Accepting a change preserves
the bullet's order, achievement identity, and Required selection through the
normal version-checked profile save. Rejecting or dismissing suggestions does
not edit the profile. Save your current edits before requesting coaching; a
changed source or saved profile version requires a fresh review. A later manual
save remains bound to the saved form version while its refreshed profile is
loading. Manual saves and autosaves of other profile fields use the same guard.
If another save intervenes, rebase the draft. Failed requests and conflicting
saves preserve existing canonical facts and keep manual editing
available. A failed accept keeps its reviewed suggestion visible while the
saved version remains the same. An edit made afterward keeps a unique Required
pin with its bullet; ambiguous duplicate text must be resolved before saving.
If a newer saved profile arrives while you have a draft, use
**Rebase edits onto saved profile** to carry non-overlapping edits forward;
resolve overlapping fields manually before saving. In Discovery Target search,
this action is labeled **Update draft with saved changes**. A normal save can
update the form and its saved-profile query in either order. That brief delay
shows saving or refresh status, rather than asking you to combine your own save
with itself. Suggestions stay bound to a matching saved profile version.

While an accepted cleanup is saving, another Save waits. If you edit that same
bullet, its Required pin follows a unique edited text; duplicate text must be
resolved before the draft can be saved.

If an accept committed but its response was lost, rebasing can preserve edits
to different bullets in the same experience entry when their positions and
identities remain clear. Edits to the same bullet still need manual resolution.

This optional aid does not implement the evidence interviews, canonical fact
promotion, or selection-policy migrations in the proposed
[Profile Evidence program](../plans/2026-09-21-profile-evidence-selective-tailoring.md).

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Build The Candidate Profile](normal-flows.md) |
| HTTP contract | `GET/PATCH /v1/profile`, `/v1/profile/sources`, `/v1/profile/wording`, and profile HTML/PDF previews; see [Profile & Settings API](../api/profile-and-settings.md) and the [complete profile contract](../api/complete-contract.md#profile-and-preferences). |
| Web implementation | `apps/web/src/contexts/profile/`, the `/profile`, `/preferences`, and `/profile/import/*` route files, and `apps/web/src/views/evidence-map/`. |
| Domain and persistence | `workers/automation/src/jobctrl/features/profile/`; feature-owned SQLite stores documents, sources, decisions, variants, import drafts and retained versions. |
| Cross-context contract | `ProfileSnapshot` and `AuthoringBrief` in `features/profile/models.py`; copied documents and stable source/wording IDs are the published language. |
| Required-bullet coaching | `features/profile/service.py` calls the shared model gateway and validates cited sources. The browser joins stable achievement IDs, exact text and saved positions before accepting whitespace cleanup. |


## Semantic Determination Authority

Import is a model extraction with verbatim field spans. Track, seniority, functions and historical target preferences are model interpretations of the saved version. They remain pending suggestions until you select values and save with their version fence. Inferred seniority and canned evidence strength are not written into authored achievement rows. Provider/spend/validation failure preserves saved facts and records an actionable interpretation status.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.


## Approved wording library

Each saved baseline bullet has its own achievement identity. Alternative wording
belongs under that achievement; it does not replace or merge another
achievement. The library shows exact text, source references, provenance and
whether the variant is approved, pending, rejected, deferred or stale.

A supported new requirement can request one source-grounded wording proposal
through an immutable authoring brief. Profile does not compute requirement
matches or person fit. The proposal's model receipt and source revisions remain
recorded. Only your explicit **Approve** action authorizes that exact text for
reuse. **Reject** and **Defer** remain recorded under the original request, so a
later job does not repeatedly regenerate the same proposal. Manual wording is
reviewed through the same exact approval boundary. Approving wording changes no
fact or qualification score.

A changed source makes dependent wording stale. A failed authoring attempt keeps
previous approved wording and shows its failure separately. A source-bound
proposal never promotes an unsupported claim into a fact. Edit facts deliberately
in Profile and confirm evidence separately when appropriate.

## Review legacy confirmations

Imported historical flags are not proof of human confirmation. The transfer
retains original cells and validates available historical human-review receipts
against the exact source rows. A valid receipt retains its authority. Missing,
conflicting or damaged authority stays **Review required**; a client flag cannot
clear that state.

The local `legacy-evidence` commands and Profile's public review service show
current and original cells, conflicts and an exact review token. Recovery
inventories a retained Profile export without replacing current facts. A missing
or edited current record remains a conflict rather than being silently restored.
Confirm or reject only after inspecting the displayed text and sources. The
current Profile version, source revision and one-use review token fence the
decision. Neither action invents strength, confidence, scope, metrics or
historical authorship. Review output contains private Profile data and must not
be copied into public issues or logs.

## Preserve Profile during the fresh-state transition

The deliberate Python cutover uses a one-off Profile transfer. It preserves the
full authored baseline, all roles and achievements, facts, preferences,
confirmations, source versions, exact wording decisions, import provenance and
supporting attachment bytes. Other JobCtrl-owned state starts fresh only at the
explicitly authorized cutover. Development and QA use owned synthetic
workspaces and do not reset a real workspace.

The old server did not store uploaded PDF bytes in SQLite. Use **Export browser
Profile sources** from the existing browser origin to read the selected PDF,
legacy retained PDF and review/recovery records without changing browser
storage. The private export includes original bytes, SHA-256 digests, record
identities, exact retained review records and an explicit unavailable-reference
inventory. A read, hash or concurrent-storage-change failure marks the export
incomplete and preserves recovery data.

The transfer joins that browser supplement with the read-only server Profile
export. Known browser-held attachments must have their bytes; an incomplete
manifest refuses import before creating a target Profile. A historical filename
whose PDF was already absent stays an honestly unavailable reference. The
source database and browser records remain unchanged, and an existing target
Profile cannot be overwritten. Target-to-target Profile export/import preserves
stable IDs, approvals, source history and attachment bytes exactly.
