# Workflow Cutover Accounting

Baseline: `a1526649a395b9febb4c20ef30dd946945014a21`. The workflow package is
pinned at `41c4ba770b6a34905c2a3ff1b52e2f73d4e1825f` (version `0.2.0`).

## Instruction Ownership

| Prior owner | Cutover |
| --- | --- |
| Root AGENTS / linked CLAUDE | Short project/router/safety entry; devflow owns lifecycle for enrolled host work |
| Web AGENTS | Frontend architecture and tests retained; shared lifecycle removed |
| QA chooser | Short risk/command router; detailed product assertions retained in owning QA references |
| Root auditability discipline | Mandatory scoped contract in regression catalog; source tracing and accepted-artifact preservation retained |
| Complete checklist blanket commands | Removed; checks are selected by risk and changed surface |
| Contributor/developer/setup prose | Public setup preserved; duplicate lifecycle and unsupported fork/stack CI claims removed |
| Shared host review/fix/agent definitions | Preserved for other consumers; JobCtrl routes directly to its pinned devflow role |
| New host skill link | Additive managed installation; manifest inventories existing consumers and permits rollback |

The conservative instruction path includes root AGENTS, scoped web AGENTS,
QA router, devflow common entry and its largest role. Baseline: **11,830 words**;
current: **1,893 words**, with a **457-word QA router**. The limits are 2,000
and 600 words respectively. Product-specific
catalogs load only for the affected invariant; this measures neither the native
host/system prompt nor full model context.

The current package does not generate a universal legacy compatibility router.
No shared review/fix targets were rewritten, and no global model settings were
changed. Historical attempt records remain readable, but old caller-asserted
authority cannot authorize further execution after the security upgrade. Missing
trusted-intake, human-validation, native-launch or protected-merge conformance stays explicit in
[workflow setup](workflow.md#activation-boundaries).

## Backlog Dispositions

Source entries are top-level bullets in the immutable baseline backlog, including
its explicitly deferred hosted-product and frontend fitness-gate ideas. Each ID
appears exactly once below and links to the complete original text. New work uses
GitHub issues. The old notes contain claims predating current code, so converting
all of them directly to Ready bugs would manufacture current evidence.

Accounting: **77 source entries = 1 mapped issue + 76 explicitly deferred entries**. None were silently removed or marked delivered. Revalidation promotes a deferred source ID into a self-contained issue and updates this mapping.

| Source ID | Original item | Disposition |
| --- | --- | --- |
| BK-001 | [Publish `v0.1.1` through the signed stable workflow as sequence 4 while](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L41-L45) | Deferred: revalidate against current code before creating executable work |
| BK-002 | [Treat analytics-optional public-demo access and post-accept](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L46-L50) | Deferred: revalidate against current code before creating executable work |
| BK-003 | [Design local/custom LLM support as a complete provider contract after the](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L51-L57) | Deferred: revalidate against current code before creating executable work |
| BK-004 | [Implement the explicitly deferred W2.4 spend-control delta after the initial](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L58-L65) | Deferred: revalidate against current code before creating executable work |
| BK-005 | [Add a shared schema-contract check for database tables initialized by both](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L66-L68) | Deferred: revalidate against current code before creating executable work |
| BK-006 | [Harden local file and artifact handling with canonical artifact roots,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L69-L72) | Deferred: revalidate against current code before creating executable work |
| BK-007 | [Expand platform and dependency health checks for local-only integrations:](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L73-L75) | Deferred: revalidate against current code before creating executable work |
| BK-008 | [Remove persistent provider-secret support from `.env` files and make an](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L76-L84) | Deferred: revalidate against current code before creating executable work |
| BK-009 | [Add local scalability instrumentation and budgets for projection refresh,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L85-L87) | Deferred: revalidate against current code before creating executable work |
| BK-010 | [Clarify quick versus full local verification by adding a root QA command or](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L88-L92) | Mapped: #879 owns scoped recipes and truthful aggregate documentation |
| BK-011 | [Extend targeted row patching beyond the single `ApplyRunEventRecorded`](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L97-L103) | Deferred: revalidate against current code before creating executable work |
| BK-012 | [Dead `pdfCandidates[0]` references in](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L104-L109) | Deferred: revalidate against current code before creating executable work |
| BK-013 | [Parallelize search-combination execution inside a discovery source family.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L112-L118) | Deferred: revalidate against current code before creating executable work |
| BK-014 | [Record `score_report` artifacts. PR 7 of the Temporal stack wired](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L119-L128) | Deferred: revalidate against current code before creating executable work |
| BK-015 | [Refactor the batch stage runners to accept a single `job_url` so](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L129-L136) | Deferred: revalidate against current code before creating executable work |
| BK-016 | [Managed Temporal Cloud,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L162-L162) | Deferred: existing hosted-product or documented fitness gate |
| BK-017 | [distributed worker fleet (multi-machine task queues),](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L163-L163) | Deferred: existing hosted-product or documented fitness gate |
| BK-018 | [cross-tenant isolation in workflows,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L164-L164) | Deferred: existing hosted-product or documented fitness gate |
| BK-019 | [Temporal-specific production observability stack.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L165-L166) | Deferred: existing hosted-product or documented fitness gate |
| BK-020 | [Cut the `jobs` table over from URL primary key to `JobId`. Domain has](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L169-L176) | Deferred: revalidate against current code before creating executable work |
| BK-021 | [Drop the legacy `jobs.application_url` column and the COALESCE fallback](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L177-L180) | Deferred: revalidate against current code before creating executable work |
| BK-022 | [Stop projection BUILDERS from sourcing legacy nullable `jobs.*` columns.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L181-L187) | Deferred: revalidate against current code before creating executable work |
| BK-023 | [Stop `apps/api/src/projections.ts` from synthesising phantom `*_pdf`](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L188-L191) | Deferred: revalidate against current code before creating executable work |
| BK-024 | [Persist domain `Source.board` and `Employer.name` directly. The domain](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L192-L197) | Deferred: revalidate against current code before creating executable work |
| BK-025 | [Index normalized scoring keywords per job. `keywords_json` is written](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L198-L204) | Deferred: revalidate against current code before creating executable work |
| BK-026 | [Contact-list import supports CSV only in Phase 1. vCard (`.vcf`) import is](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L207-L211) | Deferred: revalidate against current code before creating executable work |
| BK-027 | [Apply-review attestations callout spacing at ~1280px (QA Low, 2026-07-08,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L214-L218) | Deferred: revalidate against current code before creating executable work |
| BK-028 | [The e2e QA seed has no apply-review item with `shippedFit`, so the](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L219-L225) | Deferred: revalidate against current code before creating executable work |
| BK-029 | [Extend saved table views to the Discovery source registry. The R8 Jobs-table](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L226-L229) | Deferred: revalidate against current code before creating executable work |
| BK-030 | [Harden HTML/CSS resume pagination with deterministic page containers if](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L230-L233) | Deferred: revalidate against current code before creating executable work |
| BK-031 | [Auto-suggest target roles, target locations, and work-model preferences in](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L234-L238) | Deferred: revalidate against current code before creating executable work |
| BK-032 | [Add React component tests for persisted profile field save/discard](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L239-L244) | Deferred: revalidate against current code before creating executable work |
| BK-033 | [Add browser smoke for action-status polling. Bulk action buttons are](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L245-L252) | Deferred: revalidate against current code before creating executable work |
| BK-034 | [Decide whether row selection should be URL-persisted or kept as client](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L253-L259) | Deferred: revalidate against current code before creating executable work |
| BK-035 | [Add side-by-side artifact comparison in the app, including AI-assisted](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L260-L261) | Deferred: revalidate against current code before creating executable work |
| BK-036 | [Add AI-assisted improvement suggestions for resume items marked Required,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L262-L266) | Deferred: revalidate against current code before creating executable work |
| BK-037 | [Multi-tenant account model.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L282-L282) | Deferred: existing hosted-product or documented fitness gate |
| BK-038 | [Authentication and authorization.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L283-L283) | Deferred: existing hosted-product or documented fitness gate |
| BK-039 | [Subscription billing and entitlement checks.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L284-L284) | Deferred: existing hosted-product or documented fitness gate |
| BK-040 | [SaaS admin and support tooling.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L285-L285) | Deferred: existing hosted-product or documented fitness gate |
| BK-041 | [Hosted deployment architecture.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L286-L287) | Deferred: existing hosted-product or documented fitness gate |
| BK-042 | [Postgres migration plan.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L290-L290) | Deferred: existing hosted-product or documented fitness gate |
| BK-043 | [Object storage for generated artifacts.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L291-L291) | Deferred: existing hosted-product or documented fitness gate |
| BK-044 | [Encrypted secret vault.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L292-L292) | Deferred: existing hosted-product or documented fitness gate |
| BK-045 | [Audit log.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L293-L293) | Deferred: existing hosted-product or documented fitness gate |
| BK-046 | [Data retention policy.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L294-L294) | Deferred: existing hosted-product or documented fitness gate |
| BK-047 | [Export and deletion workflows.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L295-L296) | Deferred: existing hosted-product or documented fitness gate |
| BK-048 | [Hosted browser isolation.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L299-L299) | Deferred: existing hosted-product or documented fitness gate |
| BK-049 | [Worker fleet orchestration.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L300-L300) | Deferred: existing hosted-product or documented fitness gate |
| BK-050 | [Queue service.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L301-L301) | Deferred: existing hosted-product or documented fitness gate |
| BK-051 | [Per-tenant concurrency and rate limits.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L302-L302) | Deferred: existing hosted-product or documented fitness gate |
| BK-052 | [Policy controls for auto-apply and CAPTCHA-adjacent behavior.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L303-L304) | Deferred: existing hosted-product or documented fitness gate |
| BK-053 | [Central metrics.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L307-L307) | Deferred: existing hosted-product or documented fitness gate |
| BK-054 | [Error tracking.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L308-L308) | Deferred: existing hosted-product or documented fitness gate |
| BK-055 | [Worker dashboards.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L309-L309) | Deferred: existing hosted-product or documented fitness gate |
| BK-056 | [Alerting.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L310-L310) | Deferred: existing hosted-product or documented fitness gate |
| BK-057 | [Uptime monitoring.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L311-L312) | Deferred: existing hosted-product or documented fitness gate |
| BK-058 | [Publish the `v0.1.0` early-access reset at signed sequence 3 without lowering](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L320-L321) | Deferred: revalidate against current code before creating executable work |
| BK-059 | [Run the P7 clean-machine curl/Homebrew, no-toolchain/no-system-Chrome,](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L322-L324) | Deferred: revalidate against current code before creating executable work |
| BK-060 | [Promote the installation claim only after both acquisition paths report the](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L325-L327) | Deferred: revalidate against current code before creating executable work |
| BK-061 | [TanStack Start (SSR) — replaces the Vite SPA bootstrap. §9.1.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L336-L340) | Deferred: existing hosted-product or documented fitness gate |
| BK-062 | [React Server Components (RSC) under TanStack Start. §9.2.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L341-L344) | Deferred: existing hosted-product or documented fitness gate |
| BK-063 | [`JwtSessionAdapter` (Auth0 / Cognito) for the `SessionPort`. §9.3.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L345-L350) | Deferred: existing hosted-product or documented fitness gate |
| BK-064 | [Tenant-scoped routing prefix `/t/$tenantId/*`. §9.4.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L351-L356) | Deferred: existing hosted-product or documented fitness gate |
| BK-065 | [`OpenTelemetryWebAdapter` for the `TelemetryPort`. §9.5.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L357-L360) | Deferred: existing hosted-product or documented fitness gate |
| BK-066 | [CDN-cached projection reads. §9.6.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L361-L367) | Deferred: existing hosted-product or documented fitness gate |
| BK-067 | [IndexedDB persistence for the Query cache (`StoragePort` IDB](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L368-L374) | Deferred: existing hosted-product or documented fitness gate |
| BK-068 | [`WebSocketEventStreamAdapter` for the `EventStreamPort`. §9.8.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L375-L379) | Deferred: existing hosted-product or documented fitness gate |
| BK-069 | [Web Push notifications via a `NotificationsPort`. §7.9.](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L380-L383) | Deferred: existing hosted-product or documented fitness gate |
| BK-070 | [Visual regression (Chromatic / Loki) over the existing Storybook](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L384-L389) | Deferred: existing hosted-product or documented fitness gate |
| BK-071 | [ESLint + dependency-boundary setup — no ESLint config, lint script, or](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L403-L408) | Deferred: revalidate against current code before creating executable work |
| BK-072 | [CI grep guards for cut-over invariants — `grep` rules in CI to fail](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L409-L415) | Deferred: revalidate against current code before creating executable work |
| BK-073 | [`pnpm web:lint` script — named in the migration plan (S-15 / S-28](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L416-L419) | Deferred: revalidate against current code before creating executable work |
| BK-074 | [Frontend ACL `JobId` is unbranded —](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L420-L427) | Deferred: revalidate against current code before creating executable work |
| BK-075 | [`data-testid` attributes on dashboard / jobs row selectors — Phase 6](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L428-L430) | Deferred: revalidate against current code before creating executable work |
| BK-076 | [`apps/api/test/qa-seed.ts` remaining schema parity — The seed now covers](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L431-L436) | Deferred: revalidate against current code before creating executable work |
| BK-077 | [`DryRunCompleted` event addition to `DomainEventUnion` — Phase 6](https://github.com/ebarti/JobCtrl/blob/a1526649a395b9febb4c20ef30dd946945014a21/docs/backlog.md#L437-L442) | Deferred: revalidate against current code before creating executable work |
