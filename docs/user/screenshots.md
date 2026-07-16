---
pageClass: jh-visual-doc jh-product-tour-page jh-outline-page
---

# Product Tour

This is a route-by-route tour of JobCtrl using synthetic sample data. Nothing
shown is a real person, resume, employer target, application, credential, or
local workspace. Click or tap an image to zoom. Follow the
[Daily Workflow](normal-flows.md) for the sequence and safety gates that connect
these surfaces.

Detailed work uses full route workspaces. Selecting a job, artifact, contact,
run, or activity event opens a bookmarkable page with its facts, evidence,
actions, and history together; it does not depend on a detached drawer. Each
detail workspace has an explicit path back to its owning list. Jobs, Artifacts,
Contacts, and Runs carry their URL-backed list state into that return path when
it is present.

On desktop, the navigation rail groups the product into Overview, Pipeline,
Library, Activity, and Setup. On mobile, the same destinations move into the
navigation sheet and each workspace reflows in reading order.

## Intended Screenshot Asset Matrix

Every production primary route, detail route, import step, and Settings route
has one intended canonical desktop asset. Dense representative surfaces also
have a mobile companion. Filenames remain stable so the README, docs site, and
capture workflow agree.

| Product surface | Route | Desktop asset | Mobile companion |
| --- | --- | --- | --- |
| Dashboard | `/dashboard` | `dashboard.png` | `dashboard-mobile.png` |
| Analytics | `/analytics` | `analytics.png` | — |
| Jobs | `/jobs` | `jobs.png` | — |
| Job Detail | `/jobs/:jobId` | `job-detail.png` | `job-detail-mobile.png` |
| Job run timeline | `/jobs/:jobId/run/:runId` | `job-run-timeline.png` | — |
| Apply Review | `/apply-review` | `apply-review.png` | `apply-review-mobile.png` |
| Pipelines | `/pipelines` | `pipelines.png` | `pipelines-mobile.png` |
| Discovery | `/discovery` | `discovery.png` | — |
| Artifacts | `/artifacts` | `artifacts.png` | — |
| Artifact Detail | `/artifacts/:artifactId` | `artifact-detail.png` | — |
| Evidence | `/evidence-map` | `evidence-map.png` | — |
| Contacts | `/outreach` | `contacts.png` | — |
| Contact Detail | `/outreach/:contactId` | `contact-detail.png` | — |
| Runs | `/runs` | `runs.png` | — |
| Run Detail | `/runs/:runId` | `run-detail.png` | — |
| Debug | `/debug` | `debug.png` | — |
| Activity Detail | `/activity/:eventId` | `activity-detail.png` | — |
| Profile | `/profile` | `profile.png` | `profile-mobile.png` |
| Resume import — upload | `/profile/import/upload` | `profile-import-upload.png` | — |
| Resume import — options | `/profile/import/preview` | `profile-import-preview.png` | — |
| Resume import — confirm | `/profile/import/confirm` | `profile-import-confirm.png` | — |
| Preferences | `/preferences` | `preferences.png` | — |
| Settings — General | `/settings` | `settings-general.png` | — |
| Settings — Credentials | `/settings/credentials` | `settings-credentials.png` | — |
| Settings — Model selection | `/settings/models` | `settings-models.png` | — |
| Settings — Browser & extension | `/settings/browser` | `settings-browser.png` | `settings-browser-mobile.png` |

All files live under `docs/assets/screenshots/`. The dashboard desktop asset is
also copied byte-for-byte to `docs/public/assets/screenshots/dashboard.png` for
the docs-site hero. See
[Documentation Screenshots](../local-development.md#documentation-screenshots)
for the reproducible synthetic Playwright workflow and privacy gate.

## Overview And Work Launch

### Dashboard

![JobCtrl Dashboard with pipeline health, active work, source health, queues, and recent activity](../assets/screenshots/dashboard.png)

Dashboard is the starting operational summary: KPI and funnel facts, digest,
work status, source health, active workflow and Apply runs, outcome conversion,
and recent activity. Its links take you to the route that owns the underlying
record instead of duplicating its full audit trail.

### Analytics

![JobCtrl Analytics workspace with outcome filters, sample warnings, and comparative results](../assets/screenshots/analytics.png)

Analytics compares recorded outcome counts and sample-gated rates by source,
score band, fit band, Apply mode, template, or policy. Small groups remain
count-only and carry an explicit sample warning rather than implying reliable
conversion rates.

### Pipelines

![JobCtrl Pipelines workspace with launch controls, scoped stage ledger, execution inspector, and active work](../assets/screenshots/pipelines.png)

Pipelines combines launch controls with the operations ledger. The Discover tab
keeps limit, internal concurrency, source, and dry-run controls; Apply adds
minimum score, model, headless-browser, continuous, and stop controls where
applicable. Worker readiness and launch status remain visible in the action
panel.

The ledger separates three scopes so their numbers are never conflated:
**Current execution** is work admitted to the selected Discover run,
**Execution sweep** is eligible backlog that run adopted, and **Global outside
execution** is unrelated backlog. The execution inspector shows both cohort
plans and remaining counts. Source-family crawling is reported separately from
the two reconciliation steps that enrich intake and fan preparation out.
Per-stage outcome and backlog counts sit beside capacity, ETA, and observation
time; disclosures expose worker slots, internal parallelism, approximate task
queue pollers/backlog/age/rates, read-model freshness, and the bounded
active-work inventory. Calibrating, paused, stale, unavailable, and no-work ETA
states stay explicit.

### Discovery

![JobCtrl Discovery workspace with target search, sources, schedules, runtime, capture, and diagnostics](../assets/screenshots/discovery.png)

Discovery owns target search, source registry, scheduling, runtime and crawl
policy, manual capture, quarantine decisions, and source diagnostics. These
controls decide what can enter a Discover execution; Pipelines owns launching
and observing that execution.

## Jobs And Application Review

### Jobs

![JobCtrl Jobs workspace with filters, saved views, fit evidence, and bulk actions](../assets/screenshots/jobs.png)

Jobs is the URL-backed triage table. Search, stage/state/apply/deleted filters,
sorting, pagination, saved views, selection, columns, and bulk actions remain
available before opening one record.

### Job Detail

![JobCtrl Job Detail route workspace with fit, provenance, compensation, materials, progress, and history](../assets/screenshots/job-detail.png)

Job Detail keeps identity, score and requirement evidence, source provenance,
compensation, description, employer analysis, interview prep, per-job actions,
preparation diagnostics, active artifacts, Apply history, outcomes, contacts,
and audit history in one route. Links hand off to Apply Review and Evidence
without losing the job context.

### Job Run Timeline

![JobCtrl job run timeline workspace with workflow facts, status, failures, and events](../assets/screenshots/job-run-timeline.png)

The job-scoped run route shows the selected workflow identity, mode, status,
timestamps, failure facts, and event timeline, with direct navigation back to
the owning job.

### Apply Review

![JobCtrl Application Review workspace with review queue, job evidence, resume editor, audit, and approval controls](../assets/screenshots/apply-review.png)

Apply Review pairs its queue with the complete selected application workspace:
job and requirement evidence, fit rationale, tailoring directives and coverage,
accepted/current artifacts, editable resume, cover letter or email, comparison,
grounding/fabrication/judge warnings, dry-run evidence, and approval actions. A
failed retry remains audit history and never hides the last accepted artifact.

## Library And Evidence

### Artifacts

![JobCtrl Artifacts workspace with search, type, status, company, template, size, and open actions](../assets/screenshots/artifacts.png)

Artifacts lists registered generated files with URL-backed search, filtering,
sorting, and pagination. Open an item for its preview and audit; open the
related job when the decision needs job-level context.

### Artifact Detail

![JobCtrl Artifact Detail route workspace with PDF preview, provenance, tailoring explanation, and comparison](../assets/screenshots/artifact-detail.png)

Artifact Detail combines the real in-app PDF preview, when supported, with
status, ID, job, local-file metadata, tailoring explanation, warnings,
provenance, and same-job comparison. Historical or unavailable artifacts stay
explicit instead of masquerading as current material.

### Evidence Map

![JobCtrl Evidence workspace with evidence library, selected usage detail, gaps, and reusable stories](../assets/screenshots/evidence-map.png)

Evidence is a master-detail workspace over canonical achievements and skills.
The selected entry shows source pins, freshness, resume and requirement uses,
coverage history, and linked jobs/artifacts; the inspector keeps gaps and
reusable stories visible.

### Contacts

![JobCtrl Contacts workspace with filters, provenance, due follow-ups, import, and contact actions](../assets/screenshots/contacts.png)

Contacts lists recruiters, hiring managers, referrers, and other application
relationships with employer/job links, provenance, due follow-ups, import, and
create controls. Supervised research remains job-scoped in Job Detail, and only
proposals you confirm become contacts. JobCtrl records and drafts; it never
sends outreach.

### Contact Detail

![JobCtrl Contact Detail route workspace with facts, provenance, outreach versions, gates, and follow-ups](../assets/screenshots/contact-detail.png)

Contact Detail keeps confirmed facts and their provenance beside the outreach
thread. Draft generations, edits, gate results, approval, user-attested send
logs, and follow-up reminders remain inspectable as separate decisions.

## Workflow And Event History

### Runs

![JobCtrl Runs workspace with workflow filters, identity, status, timing, and progress](../assets/screenshots/runs.png)

Runs is the durable workflow index. Filter by status, inspect start/update/end
time and progress, cancel eligible work, or open the run route for its complete
timeline and failure facts.

### Run Detail

![JobCtrl Run Detail route workspace with workflow facts, failure diagnostics, and lifecycle timeline](../assets/screenshots/run-detail.png)

Run Detail shows workflow and Temporal identities, job relationship, mode,
status, timestamps, retryability, failure code/message, and lifecycle events.

### Debug

![JobCtrl Debug workspace with event filters, levels, stages, references, and evidence links](../assets/screenshots/debug.png)

Debug is the event-level index. Query, level, stage, event type, sorting, and
pagination stay URL-backed, with direct handoffs to a related job or the full
event workspace.

### Activity Detail

![JobCtrl Activity Detail route workspace with event facts, projected payload, and timeline](../assets/screenshots/activity-detail.png)

Activity Detail makes the selected event's source explicit: event type, stage,
level, timestamp, job reference when present, complete projected payload, and a
single-event timeline.

## Profile And Setup

### Profile

![JobCtrl Profile workspace with canonical candidate fields and the real editable baseline resume](../assets/screenshots/profile.png)

Profile keeps canonical personal, experience, education, skills, evidence, and
voluntary EEO fields beside the real baseline resume editor. The resizable
preview is the visual feedback surface for the same data, not a second profile
source.

### Resume Import

![JobCtrl resume import upload route with a synthetic PDF selected](../assets/screenshots/profile-import-upload.png)

![JobCtrl resume import options route selecting profile and style data](../assets/screenshots/profile-import-preview.png)

![JobCtrl resume import confirmation route summarizing the selected synthetic file and sections](../assets/screenshots/profile-import-confirm.png)

Resume import is a three-route wizard: select a PDF, choose profile data, style
data, or both, then confirm the exact import. Back and cancel actions keep the
pending choice explicit before any profile mutation.

### Preferences

![JobCtrl Preferences workspace with application, tailoring, resume style, and template preview controls](../assets/screenshots/preferences.png)

Preferences organizes the existing application fields, tailoring content and
voice rules, quality gates, resume style, and template versions into adaptive
sections and semantic tabs. The template toolbar sits above the full-width
production resume preview; autosave/undo and every original value, validation,
locked reason, version, and default action remain available.

### Settings — General

![JobCtrl General Settings route with runtime, Apply, scoring, and compensation policy sections](../assets/screenshots/settings-general.png)

General groups shared spend/capacity and runtime settings with Apply runtime,
scoring guidance, and compensation-source policy. Effective values, defaults,
overrides, activation timing, validation, autosave/undo, and reset controls stay
visible at the owning section.

### Settings — Credentials

![JobCtrl Credentials Settings route with provider readiness and guided secret setup](../assets/screenshots/settings-credentials.png)

Credentials shows provider readiness, supported authentication modes, secret
presence metadata, sanitized errors, and add/update/remove/verify actions. It
never displays stored secret values. A failed provider replacement preserves the
previous stored configuration; a failed model-catalog read does not change
credentials.

### Settings — Model Selection

![JobCtrl Model Selection Settings route with provider catalogs and AI execution policy](../assets/screenshots/settings-models.png)

Model selection shows authenticated provider catalogs, preferred models,
generator/judge choices, analysis perspectives, and AI execution policy. Ready,
unready, invalid, default, and override states remain distinct.

### Settings — Browser & Extension

![JobCtrl Browser and Extension Settings route with capability and pairing ledgers](../assets/screenshots/settings-browser.png)

Browser & extension shows capability availability and supported local Chrome or
Chromium candidates by label. Detection is read-only: it does not launch,
enable, or persist a browser. Explicitly enabling a detected candidate adopts it;
an advanced manual executable path remains available. If a candidate disappears
before confirmation, enable fails without changing capability state. Extension
pairing and authenticated-profile copying remain separate explicit actions.

## Mobile Reflow

The intended mobile captures verify that the same information remains reachable
in reading order at 390×844; they are not reduced-content mockups.

| | |
| --- | --- |
| ![JobCtrl Dashboard mobile reflow](../assets/screenshots/dashboard-mobile.png) | ![JobCtrl Pipelines mobile reflow](../assets/screenshots/pipelines-mobile.png) |
| **Dashboard** — navigation sheet and operational sections | **Pipelines** — controls, scoped ledger, and inspector remain reachable |
| ![JobCtrl Job Detail mobile route workspace](../assets/screenshots/job-detail-mobile.png) | ![JobCtrl Application Review mobile route workspace](../assets/screenshots/apply-review-mobile.png) |
| **Job Detail** — evidence before inspector history in reading order | **Apply Review** — queue, evidence, material, and approval flow without hidden state |
| ![JobCtrl Profile mobile workspace](../assets/screenshots/profile-mobile.png) | ![JobCtrl Browser Settings mobile workspace](../assets/screenshots/settings-browser-mobile.png) |
| **Profile** — form and baseline resume remain usable | **Browser settings** — detection, adoption, and pairing facts reflow without clipping |

::: info Generating these screenshots
Run `pnpm docs:screenshots` as documented in
[Documentation Screenshots](../local-development.md#documentation-screenshots).
The opt-in Playwright workflow seeds an isolated synthetic workspace and writes
the canonical assets above. Never point it at a normal `~/.jobctrl` workspace
or use real profile, resume, credential, browser, or application data.
:::
