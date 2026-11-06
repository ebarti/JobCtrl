# Browser Smoke

Use a disposable synthetic workspace and exercise the product path affected by
the change. The complete checklist contains the long-form assertions for each
surface; this page is the route-level starting point.

## Start A Safe Stack

Run the current E2E entry point from the repository root:

```bash
corepack pnpm e2e
corepack pnpm e2e -- --headed --grep 'approved baseline'
```

The runner owns fresh synthetic workspaces, actual Python HTTP/CLI/worker
composition, Temporal, SQLite and the renderer. It freezes the source and
runtime policy and records candidate hashes and setup-inclusive timings. Only
external model, job, mail and provider boundaries are controlled; unexpected
external calls fail the run. Use the observed results in
[Python application journeys](python-journeys.md), not invented terminal events.

The former `qa:seed`, test-only API, `JOBCTRL_E2E_STUB_DISPATCH` and
`JOBCTRL_E2E_ISOLATED` paths are retired. Those environment flags do not make
current manual QA safe. Do not use real Profile data, credentials, mailboxes or
application destinations, and do not replace internal APIs, repositories or
worker dispatch with stubs.

## Live Worker Smoke

A real worker is part of the ordinary suite; there is no separate legacy
JSON-RPC/live-worker command. Cancellation and restart journeys hold a controlled
external request, act through the real API, kill the actual worker and observe
its distinct replacement and durable state. The application-effect journey
uses a controlled external mail endpoint after real persisted intent, never an
actual employer submission.

Owned process groups and state remain the runner's responsibility. Teardown
verifies cleanup; failed synthetic state is retained for diagnosis rather than
being treated as successful cleanup. Use the current harness under
`apps/web/e2e/harness/` and `scripts/run-e2e.mjs`. These controlled boundaries
are not a claim of a general OS network sandbox or live-provider qualification.

## Route Checklist

| Route | Verify |
| --- | --- |
| `/dashboard` | KPI/read-model consistency, source health, funnel, and responsive connection status. |
| `/analytics` | Window/dimension filters, counts and rates, sample/confidence warnings, totals, and empty/loading/error states. |
| `/jobs`, `/jobs/$jobId`, `/jobs/$jobId/run/$runId` | Filters and URL state, list/detail agreement, score/evidence explanation, human-readable Evidence-map references with honest unresolved states, stage actions, and complete job/run workspaces. |
| `/artifacts`, `/artifacts/$artifactId` | Registered artifact metadata, previews, comparison, provenance, linked human-readable evidence, technical fallback for unresolved keys, and explicit missing-audit states. |
| `/apply-review` | Readiness/blocker truth, editable draft persistence, line-anchored and unresolved comment visibility, binding decisions, and accepted-artifact preservation. |
| `/pipelines` | Source-family versus reconciliation topology, execution/sweep/backlog scope, exact stage outcomes, active-work truth, stop/recovery controls, privacy masking, ETA, freshness, queue, and worker capacity. |
| `/runs`, `/runs/$runId` | Workflow type, progress/timeline, cancellation, and terminal reconciliation. |
| `/discovery` | Source controls, quarantine/manual capture, schedules, and safe feedback commands. |
| `/outreach`, `/outreach/$contactId` | Contact provenance, supervised candidate confirmation, draft gates, copy-only delivery, and reminders. |
| `/evidence-map` | Evidence usage/gaps and deep links back to the owning job or artifact. |
| `/debug`, `/activity/$eventId` | Filters, safe payload/audit facts, detail navigation, and no sensitive free-form input leakage. |
| `/profile`, `/profile/import/*` | Ownership boundaries, save/discard, import steps, real previews, validation, and mounted form state. |
| `/preferences` | Legacy preference parity, autosave/undo, adaptive fields, and the real resume-template workbench. |
| `/settings`, `/settings/credentials`, `/settings/models`, `/settings/browser` | General settings, provider ownership/readiness, model policy, passive browser detection versus explicit adoption, pairing, validation, and unavailable states. |

## High-Value Smokes

- [Job Detail audit](complete-checklist.md#jobs-drawer-audit-smoke)
- [Apply Review](complete-checklist.md#apply-review-smoke)
- [Materials inspector](complete-checklist.md#materials-generation--inspector-smoke)
- [Evidence map](complete-checklist.md#evidence-map-smoke)
- [Outreach planner](complete-checklist.md#outreach-planner-product-smoke)
- [Interview prep](complete-checklist.md#interview-prep-smoke)
- [Browser extension](complete-checklist.md#browser-extension-qa)

## Cumulative Redesign Route Sweep

Run the complete Playwright suite first, then walk every route and detail route
above in the in-app browser against the disposable seed. Record the route,
state, viewport, theme, density, console result, and interaction result. Cover
1440px, 1280px, a collapsed-rail desktop width, and 390×844; repeat light/dark
and compact/regular/comfy density.

Exercise shared Rhea/Base UI behavior through product routes: labelled Select
triggers and keyboard navigation, overlay focus return and Escape dismissal,
disclosures that preserve mounted form state, destructive confirmations,
visible focus, and no document-level horizontal overflow. Status must remain an
icon/dot plus text, while coherent cards retain the shared radius and quiet
elevation without becoming one card per fact. Verify body copy retains the
shared body typography role in compact, regular, and comfy density; density
changes geometry, not typography. Every primary route keeps the
compact eyebrow/title/subtitle/action hierarchy instead of a route-local hero.

On `/jobs`, verify there is one table and no lifecycle tablist. The **Job state**
column filter exposes static Active, Deleted, and Hidden options, defaults to
Active, supports combined selections, and has no unsupported text predicate.
Verify URL reload/back navigation and saved-view apply/reset preserve the state
selection, page and selection reset when it changes, and totals match the full
server-filtered result. An old `deleted=closed` link remains compatible without
adding a Closed control. In a mixed-state view, verify selected and all-matching
actions visibly target only eligible states. The default table hides Sources
and Warnings, ordinary active titles omit `OPEN`, delete actions are destructive,
and the row's Open control becomes visible on keyboard focus without competing
with selection. At 900px and below, walk Jobs, Artifacts, Contacts, Discovery,
and Settings record data as labelled cards and confirm sort/filter access is
still reachable; at phone width each record becomes one column.

On `/pipelines`, create synthetic work through the real public entry points and
verify its distinct acquisition/preparation steps, honest scope/freshness/ETA/
capacity/queue states, exact active/terminal/attention counts, and no raw/private
identifier leakage. Stop an active Discover execution and confirm the pipeline
snapshot refreshes. For an observed failed-history case, a
positive or unavailable active-work inventory must block the replacement-run
shortcut, while an exact zero may expose setup that selects Discover without
starting it. Keep raw workflow IDs and the reconciler code collapsed. On
`/settings/browser`, verify the initial capability read has no launch,
adoption, persistence, or path disclosure; enabling is a second explicit action;
a stale detected ID fails closed; and the advanced manual path plus separate
profile-copy consent still work.

On Job Detail and Artifact Detail, resolve stored evidence IDs through the
recorded Evidence map and verify the title/excerpt replaces the raw key. Artifact
references must link back to the owning Evidence entry. A missing key must stay
visible as unavailable with its identifier only under **Technical details**.
Confirm Artifact Detail completes the summary/evidence/comparison audit before
the full-width PDF preview. Stack Profile's editor before its preview and
Evidence Map's entry/detail/inspector regions without a dead resize gutter or
page overflow. Keep Apply Review's queue on the left at a working desktop width,
then verify the queue moves above full-width sequential review content and its
decision actions wrap at narrow width. Compare a short title/company row with a
long one and verify their score, title, company, and status share the same left
alignment rather than centering the shorter row.

On Apply Review, keep matched persisted comments attached to their rendered
line and unmatched/unresolved comments in the labeled fallback while replies
remain usable.

On `/settings/credentials`, use an environment-owned active provider route.
Its secret/removal controls must stay read-only while an alternative supported
route remains editable; saving the alternative must not claim it became active.
Finally, issue a retry with `runAfter: true` while the worker-readiness stub is
unavailable and confirm the failed stage, attempts, diagnostics, and audit
history remain unchanged. Readiness must be proven before reset.

## Responsive And Theme Pass

For a visible UI change, check at least one desktop viewport and 390×844 mobile
in light and dark themes. Verify keyboard focus, overlays, empty/loading/error
states, long content, and horizontal overflow—not only the populated happy path.
Use 900px as an additional boundary when the change touches a record-table
reflow; check both sides of the breakpoint.

## Persistence And Artifact Regression Paths

For compensation changes, the Job Detail product-path check must cover both an
accepted range and an insufficient-evidence result. Verify that the posted
amount and market range (or explicit no-reliable-range outcome) are the visual
headlines; cash is not relabelled as separately mentioned equity; the inferred
level is correct; evidence/provider counts expand into the actual salary
evidence records and reported sample counts; reliability percentages explain
their basis; and the normal focused refresh has no local observation-path
input.

For Plate PDF-export changes, exercise the shared control on `/profile`,
`/preferences`, and `/apply-review`. Edit the mounted document without saving,
export it, and verify the browser downloads a non-empty PDF containing the live
edit with the expected surface-specific filename. The PDF must omit JobCtrl
comment/audit chrome and transient selection styling, preserve non-default
template typography/colors/margins, and use the mounted template's A4 or Letter
media box without a trailing blank page or a rendered text line split across a
page boundary. Compare the mounted Plate document to
the downloaded PDF and confirm Unicode contact glyphs and separators are
visually unchanged, punctuation-adjacent word spaces do not collapse, and text
search/extraction still returns the live edit. Drag-selection must follow the
rendered word and line geometry without offset, oversized, or cross-line
highlight boxes. The action must not save the
profile, template, or review draft; call a generation endpoint; register or
replace an artifact; or change Apply approval state.

For Profile Plate text projection, first click an experience bullet's actual
text while the editor has no selection. Confirm the native caret stays inside
that line when its audit highlight appears; moving to the line end and typing
must update that bullet, not the resume header. Include the Font selector in
scoped axe checks: the trigger and value must use the resume toolbar's matching
foreground/background in both light and dark app themes, including the themed
Apply review toolbar.

For Profile Plate text projection, edit the fifth experience title, company,
location and date, a bullet and summary, education fields, an individual skill
and its label, and address text; switch to **Profile data** and verify
the matching boxed field contains the same unsaved value and the normal Profile
dirty/save controls appear. Include deletion plus digits or punctuation so the
check exercises Plate's model-change path rather than a native browser input
event. Saving must persist that exact field through the normal Profile mutation.
While both panes are open, make an unrelated boxed edit before editing Plate
and verify both changes survive. If the boxed editor removes or changes the
same bullet first, the Plate projection must preserve the boxed structure and
surface a conflict. Clear a required title, continue typing, and undo it: an
incomplete intermediate draft must not freeze projection. Type spaces and
punctuation in right-aligned location/date cells and retain the caret's order.
Fields in composite lines must have individual source bindings; include a pipe
inside an institution/location and a comma inside a single skill. Reorder roles
before projecting a title and prove identity, not array position, owns the edit.
A formatting-only change must not create a guessed profile-field edit.
Move bullets up and down within a role using mouse and keyboard, including the
first/last boundaries, then autosave and reload. Verify the baseline preview's
order, required selections, metrics, and historical achievement links still
refer to the same source text. Cover duplicate and blank draft bullets, mixed
authored/derived evidence, another save after reordering, and desktop/mobile
controls without overflow or accessibility regressions.
Verify unknown nested fields and raw numeric strings survive the actual outgoing
Profile request. Use real Python GET/PATCH, SQLite persistence and the current
renderer for supported values/order; do not substitute deterministic preview
HTML or an isolated internal API. During an observed delayed save acknowledgement,
continue typing a newer title while the save is pending.
Releasing the older response must preserve the same newer value in Plate and
Profile data, including after the next autosave and reload. Neither optimistic
query updates nor successful older responses may refresh an active draft preview.

Verify the Size control displays its relative value as a percentage (100% at
the resume default) with high-contrast text rather than exposing the internal
unitless scale. Verify experience entries render newest-first and education
aligns the completion year with the institution above the degree. Then move an
experience manually, save, reload, and verify both the boxed order and Plate
order preserve the saved sequence. Apply **Sort newest first** and verify it
restores current/latest roles first. A role with a summary but no bullets must
not render an empty list or the full bullet-bearing entry gap.

For saved review-draft reconciliation, preserve the real request and
acknowledgement ordering: save A, type B, receive A, then render the saved
revision. Verify B remains editable/dirty, focus remains in Plate, rendering
stays gated until the later edit is saved, and the rendered revision/comparison
does not regress. Exercise independent replies/feedback and tenant/job switches
through the actual application; do not fabricate internal save/render responses.

<a id="isolated-browser-mode"></a>

## Owned Browser Workspaces

The current runner allocates the workspace, ports and service homes; do not
point it at an existing user workspace or revive removed isolated-API/seed
helpers. Browser requests reach the same Python application used by the CLI
and worker. Create synthetic records through public product entry points, and
keep only external services controlled. Existing source or installed entry
points are selected by the runner's documented mode, not by substituting API
responses.

For focused runs, use the existing journey titles with `corepack pnpm e2e --
--grep '...'`. Keep UI assertions below the real application boundary and
record actual outcomes, candidate hashes and cleanup. See
[Python application journeys](python-journeys.md) and
[Reliability & QA](../../local-reliability-qa.md) for the authoritative runtime,
installed-mode and evidence contracts.
