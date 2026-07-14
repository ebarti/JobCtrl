# Browser Smoke

Use a disposable synthetic workspace and exercise the product path affected by
the change. The complete checklist contains the long-form assertions for each
surface; this page is the route-level starting point.

## Start A Safe Stack

```bash
corepack pnpm qa:seed /tmp/jobctrl-qa
JOBCTRL_DIR=/tmp/jobctrl-qa corepack pnpm api:dev
VITE_JOBCTRL_API_BASE_URL=http://127.0.0.1:8766 corepack pnpm web:dev -- --port 5173
```

Use the E2E stub dispatcher for commands that would otherwise start a worker,
browser, mailbox, or model. Never submit an application during QA.

## Route Checklist

| Route | Verify |
| --- | --- |
| `/dashboard` | KPI/read-model consistency, source health, funnel, and responsive connection status. |
| `/analytics` | Window/dimension filters, counts and rates, sample/confidence warnings, totals, and empty/loading/error states. |
| `/jobs`, `/jobs/$jobId`, `/jobs/$jobId/run/$runId` | Filters and URL state, list/detail agreement, score/evidence explanation, stage actions, and complete job/run workspaces. |
| `/artifacts`, `/artifacts/$artifactId` | Registered artifact metadata, previews, comparison, provenance, and explicit missing-audit states. |
| `/apply-review` | Readiness/blocker truth, editable draft persistence, binding decisions, and accepted-artifact preservation. |
| `/pipelines` | Source-family versus reconciliation topology, stage ledgers, active work, privacy masking, refresh, ETA, freshness, and capacity. |
| `/runs`, `/runs/$runId` | Workflow type, progress/timeline, cancellation, and terminal reconciliation. |
| `/discovery` | Source controls, quarantine/manual capture, schedules, and safe feedback commands. |
| `/outreach`, `/outreach/$contactId` | Contact provenance, supervised candidate confirmation, draft gates, copy-only delivery, and reminders. |
| `/evidence-map` | Evidence usage/gaps and deep links back to the owning job or artifact. |
| `/debug`, `/activity/$eventId` | Filters, safe payload/audit facts, detail navigation, and no sensitive free-form input leakage. |
| `/profile`, `/profile/import`, `/profile/import/upload`, `/profile/import/preview`, `/profile/import/confirm` | Ownership boundaries, save/discard, every import step, real previews, validation, and mounted form state. |
| `/preferences` | Every legacy preference, autosave/undo, adaptive disclosures/tabs, accessible fields, and the real resume-template workbench. |
| `/settings`, `/settings/credentials`, `/settings/models`, `/settings/browser` | General settings, provider/secret-status boundaries, model policy, browser pairing/capabilities, autosave, validation, and unavailable states. |

## High-Value Smokes

- [Job Detail workspace audit](complete-checklist.md#jobs-drawer-audit-smoke)
- [Apply Review](complete-checklist.md#apply-review-smoke)
- [Materials inspector](complete-checklist.md#materials-generation--inspector-smoke)
- [Evidence map](complete-checklist.md#evidence-map-smoke)
- [Outreach planner](complete-checklist.md#outreach-planner-product-smoke)
- [Interview prep](complete-checklist.md#interview-prep-smoke)
- [Browser extension](complete-checklist.md#browser-extension-qa)

## Integrated Redesign Route Sweep

For an integrated redesign, run the complete Playwright suite first with
`corepack pnpm --filter @jobctrl/web e2e`, then open the disposable stack in the
in-app browser and walk every route and detail route in the table above. A
static screenshot review or Playwright-only pass does not satisfy this
human-facing cutover gate. For each route, check the active rail destination,
heading, URL-backed state, loading/empty/error/unavailable states, long
production-shaped content, and browser console. Record route, state, viewport,
theme, density, and result so a missing surface cannot be hidden by a single
happy-path screenshot.

Use 1440px and 1280px with the rail expanded, a collapsed-rail desktop width,
and 390×844 with the labelled mobile sheet. Repeat light/dark theme and
compact/regular/comfortable density. Adaptive field grids, tool rows, headers,
audit callouts, and action groups must keep intentional gaps and reflow without
clipped text, overlapping controls, or document-level horizontal overflow.

Exercise the redesign primitives through real product routes:

- enabled `ChoiceControl` rows toggle through their labels, while disabled rows
  expose a real disabled checkbox with the visible reason as its accessible
  description;
- every `SelectField` trigger is named by its visible label; Tab reaches it,
  Enter/Space opens it, Arrow keys move, Enter commits, and Escape closes and
  restores focus without changing the value;
- collapsing and reopening a `DisclosureSection` preserves its mounted form
  values and focusable descendants reappear in the same state;
- Profile/Preferences template editing uses `PreviewWorkbench` with compact
  controls above the named, real, full-width `ResumeStandalonePlateEditor`,
  including its production toolbar, rather than a mock, thumbnail, side
  preview, or name-only template swap.

On `/pipelines`, use the production-shaped three-source fixture and verify the
three source families remain under one source-family plan while Enrichment pass
and Preparation fanout remain exactly two separately labelled reconciliation
steps. They must never be flattened into one stage count or whole-pipeline
completion percentage. A URL-shaped job key must render as `Sensitive
identifier withheld`, and private workflow inputs must be absent from both the
API response and DOM.

Trigger a pipeline lifecycle event and observe the SSE invalidation refresh;
then leave events quiet and observe the bounded polling fallback at 15 seconds
for an active execution and 60 seconds for idle/terminal state (with no
background polling). Exercise ETA `available`, `calibrating`, `paused`, `stale`,
and `unavailable`; freshness `fresh`, `stale`, `unsupported`, and `unavailable`;
capacity `available`, `stale`, and `unavailable`; and nested task-queue
`available`, `stale`, `unsupported`, and `unavailable` states. The UI must show
observation time, basis/sample or reason, and real worker/slot facts without
inventing an ETA, inventory total, or capacity value.

Finally, compare each surface with its pre-redesign semantic parity record.
Every old label/role, fixture and data value, control, action, status
discriminant, warning, audit fact, and unavailable/loading/empty/error state
must still be visible or keyboard-reachable through a documented
tab/disclosure/detail route. Do not weaken the baseline after migration.

## Responsive And Theme Pass

For an isolated visible UI change, check at least one desktop viewport and
390×844 mobile in light and dark themes. For the integrated redesign, the full
1440px/1280px/collapsed-rail/390×844 matrix above is required. Verify keyboard
focus, overlays, empty/loading/error states, long content, adaptive spacing, and
horizontal overflow—not only the populated happy path.
