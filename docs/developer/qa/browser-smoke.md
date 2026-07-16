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
| `/pipelines` | Source-family versus reconciliation topology, execution/sweep/backlog scope, stage ledger, active work, privacy masking, ETA, freshness, queue, and worker capacity. |
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
and compact/regular/comfortable density.

Exercise shared Rhea/Base UI behavior through product routes: labelled Select
triggers and keyboard navigation, overlay focus return and Escape dismissal,
disclosures that preserve mounted form state, destructive confirmations,
visible focus, and no document-level horizontal overflow. Status must remain an
icon/dot plus text, while coherent cards retain the shared radius and quiet
elevation without becoming one card per fact.

On `/pipelines`, use the seeded three-source execution and verify exactly two
separate reconciliation rows, honest scope/freshness/ETA/capacity/queue states,
two active work items, and no raw/private identifier leakage. On
`/settings/browser`, verify the initial capability read has no launch,
adoption, persistence, or path disclosure; enabling is a second explicit action;
a stale detected ID fails closed; and the advanced manual path plus separate
profile-copy consent still work.

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
