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
| `/jobs` | Filters and URL state, list/detail agreement, score/evidence explanation, stage actions, and drawer layout. |
| `/artifacts` | Registered artifact metadata, previews, comparison, provenance, and explicit missing-audit states. |
| `/apply-review` | Readiness/blocker truth, editable draft persistence, binding decisions, and accepted-artifact preservation. |
| `/runs` | Workflow type, progress/timeline, cancellation, and terminal reconciliation. |
| `/discovery` | Source controls, quarantine/manual capture, schedules, and safe feedback commands. |
| `/outreach` | Contact provenance, supervised candidate confirmation, draft gates, copy-only delivery, and reminders. |
| `/evidence-map` | Evidence usage/gaps and deep links back to the owning job or artifact. |
| `/profile`, `/preferences`, `/settings` | Ownership boundaries, autosave, preview, validation, and secret-status handling. |

## High-Value Smokes

- [Jobs drawer audit](complete-checklist.md#jobs-drawer-audit-smoke)
- [Apply Review](complete-checklist.md#apply-review-smoke)
- [Materials inspector](complete-checklist.md#materials-generation--inspector-smoke)
- [Evidence map](complete-checklist.md#evidence-map-smoke)
- [Outreach planner](complete-checklist.md#outreach-planner-product-smoke)
- [Interview prep](complete-checklist.md#interview-prep-smoke)
- [Browser extension](complete-checklist.md#browser-extension-qa)

## Responsive And Theme Pass

For a visible UI change, check at least one desktop viewport and 390×844 mobile
in light and dark themes. Verify keyboard focus, overlays, empty/loading/error
states, long content, and horizontal overflow—not only the populated happy path.
