---
pageClass: jh-visual-doc jh-comparison-page
description: "Compare JobCtrl's local-first, auditable workflow with Career-Ops, JobOps, and AI Job Search across discovery, tailoring, safety, and operations."
---

# How JobCtrl Compares

JobCtrl, [Career-Ops](https://github.com/santifer/career-ops),
[JobOps](https://github.com/DaKheera47/job-ops), and
[AI Job Search](https://github.com/MadsLorentzen/ai-job-search) address the same
broad problem through four different operating models. Across the capabilities
reviewed here, JobCtrl is the only option that combines a supported graphical
product, durable workflows, deterministic source-to-claim grounding gates, and
guarded submission paths. The competitor snapshots were last reverified on
**2026-08-12**. JobCtrl's reviewed snapshot was advanced on **2026-08-15**
during conflict resolution to incorporate the shipped missing-salary
intelligence shown below. The [snapshot method](#snapshot-and-delta-method)
pins every open-source claim to an immutable commit.

## Four operating models

<div class="jh-compare-grid" role="list">
  <article class="jh-compare-card jh-compare-card--featured" role="listitem">
    <div class="jh-compare-card__header">
      <p class="jh-compare-card__model">Local application</p>
      <h3>JobCtrl</h3>
      <span class="jh-compare-badge">Supported web UI</span>
    </div>
    <p>A React control plane backed by a local API, Python worker, Temporal workflows, and a supporting CLI.</p>
    <ul>
      <li>SQLite, generated files, and browser state stay local.</li>
      <li>Long-running work has durable history, retries, and visible recovery.</li>
      <li>Dry runs and review-bound approvals guard live submission.</li>
    </ul>
    <p class="jh-compare-card__verdict"><strong>Why JobCtrl leads:</strong> it is the only reviewed option with a supported web UI, durable workflow execution, and guarded live-submission paths in one product.</p>
    <a href="./user/product-tour">Explore the product tour →</a>
  </article>

  <article class="jh-compare-card" role="listitem">
    <div class="jh-compare-card__header">
      <p class="jh-compare-card__model">Files + coding CLIs</p>
      <h3>Career-Ops</h3>
      <span class="jh-compare-badge jh-compare-badge--partial">Web UI: opt-in alpha</span>
    </div>
    <p>Human-readable Markdown, YAML, and TSV files drive modes run through several AI coding CLIs.</p>
    <ul>
      <li>A terminal dashboard is established; the optional Next.js UI remains alpha.</li>
      <li>Freshness, company exclusions, spend tiers, and a candidate fact gate now strengthen the file-first workflow.</li>
      <li>Application autofill stops before the user clicks Submit.</li>
    </ul>
    <p class="jh-compare-card__verdict"><strong>Gap versus JobCtrl:</strong> the operator experience remains file- and CLI-first, the optional web UI is alpha, and interrupted work has no durable workflow engine.</p>
    <a href="#appendix-evidence-backed-capability-matrix">Open the evidence matrix →</a>
  </article>

  <article class="jh-compare-card" role="listitem">
    <div class="jh-compare-card__header">
      <p class="jh-compare-card__model">Self-hosted web application</p>
      <h3>JobOps</h3>
      <span class="jh-compare-badge">Supported web UI</span>
    </div>
    <p>A React and Express application backed by SQLite, packaged for Docker self-hosting with an optional hosted service.</p>
    <ul>
      <li>Searches multiple boards, scores roles, tailors structured resumes, renders PDFs, and tracks applications.</li>
      <li>High-confidence Gmail matches update the timeline automatically; uncertain matches go to review.</li>
      <li>Applications remain manual, and running pipelines do not survive a server restart.</li>
    </ul>
    <p class="jh-compare-card__verdict"><strong>Gap versus JobCtrl:</strong> no deterministic candidate source-to-claim gate, durable workflow history, or exact-approval submission path was evidenced in the reviewed snapshot.</p>
    <a href="#appendix-evidence-backed-capability-matrix">Open the evidence matrix →</a>
  </article>

  <article class="jh-compare-card" role="listitem">
    <div class="jh-compare-card__header">
      <p class="jh-compare-card__model">Claude Code workflow</p>
      <h3>AI Job Search</h3>
      <span class="jh-compare-badge jh-compare-badge--partial">Generated HTML dashboard</span>
    </div>
    <p>Claude Code commands and skills coordinate local utilities and a LaTeX-first application workflow.</p>
    <ul>
      <li>The drafter-reviewer path produces CV, cover-letter, and PDF artifacts.</li>
      <li>Optional Gmail and Notion sync commands extend its local tracker.</li>
      <li>Submission remains a user handoff after document preparation.</li>
    </ul>
    <p class="jh-compare-card__verdict"><strong>Gap versus JobCtrl:</strong> no stateful graphical product, browser-form assistance, or checkpointed apply recovery was evidenced in the reviewed snapshot.</p>
    <a href="#appendix-evidence-backed-capability-matrix">Open the evidence matrix →</a>
  </article>
</div>

## At a glance

<div class="jh-compare-table-wrap" role="region" aria-label="At-a-glance comparison table" tabindex="0">
  <table class="jh-compare-summary">
    <caption>Selected differences between the four reviewed job-search tools</caption>
    <thead>
      <tr>
        <th scope="col">Capability</th>
        <th scope="col">JobCtrl</th>
        <th scope="col">Career-Ops</th>
        <th scope="col">JobOps</th>
        <th scope="col">AI Job Search</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th scope="row">Primary surface</th>
        <td>Web app + local API/worker; supporting CLI</td>
        <td>Files + AI coding CLIs; terminal dashboard</td>
        <td>Self-hosted web app + local API and SQLite</td>
        <td>Claude Code commands/skills + local utilities</td>
      </tr>
      <tr>
        <th scope="row">Graphical UI</th>
        <td><strong>Supported product surface</strong></td>
        <td><strong>Partial:</strong> optional Next.js alpha</td>
        <td><strong>Supported product surface</strong></td>
        <td><strong>Partial:</strong> generated offline HTML dashboard</td>
      </tr>
      <tr>
        <th scope="row">Tailored documents</th>
        <td>Resume, cover letter, HTML, and PDF</td>
        <td>CV/HTML/PDF and cover letter</td>
        <td>Structured resume tailoring and PDF</td>
        <td>LaTeX CV, cover letter, and PDF</td>
      </tr>
      <tr>
        <th scope="row">Submission boundary</th>
        <td>Dry run + guarded browser/Gmail paths; approval on by default</td>
        <td>Form autofill; the user clicks Submit</td>
        <td>Prepared materials; the user applies manually</td>
        <td>Reviewed documents; the user submits</td>
      </tr>
      <tr>
        <th scope="row">Interrupted work</th>
        <td>Temporal history, retries, and stable workflow identities</td>
        <td>File integrity + resumable batch flags; no workflow engine</td>
        <td>Persisted run records; active run state is in memory</td>
        <td>No checkpointed apply resumption evidenced</td>
      </tr>
      <tr>
        <th scope="row">Application-level cost control</th>
        <td>Daily estimated-spend ceiling</td>
        <td>Spend tiers, batch pre-screen/cap, dry run, and resume controls</td>
        <td>Hosted action quotas; no self-hosted spend ceiling evidenced</td>
        <td>Token-efficiency instructions; no app-level budget evidenced</td>
      </tr>
    </tbody>
  </table>
</div>

The compact view highlights operating-model differences. The
[full evidence matrix](#appendix-evidence-backed-capability-matrix) preserves
the qualifications, issue evidence, and source links behind every row.

## What changed since 2026-07-20

All three previously reviewed projects moved materially, and JobOps now belongs
in the main matrix as a closer graphical alternative. These are changes between
exact Git snapshots, not deductions from mutable marketing pages.

| Project | Verified additions | Effect on this comparison |
| --- | --- | --- |
| **JobCtrl** | Across [246 commits](https://github.com/ebarti/JobCtrl/compare/446056bb623df813365a302df35c6e04412c2446...b4063e1a3227d31eebacbc7d2c620ae5236f744b), it activated the exact-v8 data model through a sealed v7 transition, added canonical job identity, repeat-application prevention, reviewed learning recommendations and tailoring-policy rollback, more durable preparation recovery, richer workflow cancellation/progress, browser-profile selection, and automatic lineage-preserving compensation benchmarks. | The supported graphical, auditability, durable-recovery, and missing-salary intelligence assessments are stronger. The product still requires Apple-silicon macOS for its public bundled installation. |
| **Career-Ops** | Across [413 commits](https://github.com/santifer/career-ops/compare/16367add3f7291add757fc672a530294ae231bab...03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182), it expanded to 74 provider modules, added outcome archives, follow-up and reply tooling, offer-stage support, application-email drafts, more languages, context-budget controls, and a fact gate that now covers selected employers, titles, tools, and metric-like claims. | Discovery and post-application support are substantially stronger. Grounding remains **Partial** because the gate still does not prove every generated claim, and [full faithfulness](https://github.com/santifer/career-ops/issues/1411) plus [final rendered keyword coverage](https://github.com/santifer/career-ops/issues/1285) remain open. |
| **JobOps** | The newly added [2026-08-12 snapshot](https://github.com/DaKheera47/job-ops/tree/c834c6502bf4685904b6abc3d5a008294b8b7020) provides a supported React/Express UI, multi-board discovery, AI scoring, structured resume tailoring, PDF generation, a Gmail outcome inbox, and Docker self-hosting. | JobOps is the closest reviewed graphical alternative. It narrows JobCtrl's UI advantage, but its active pipeline state is process-local, candidate grounding is prompt-based, and its AGPLv3 distribution carries the additional Commons Clause restriction. |
| **AI Job Search** | Across [76 commits](https://github.com/MadsLorentzen/ai-job-search/compare/faa479973aeaa7b8a1463112d088fdefff202961...670d30ae7e9709bbf624deb2d9962ba5733331f5), it added work-authorization and language gates, optional application-form artifacts, posting archives, follow-up drafting, portal-health safeguards, custom-portal hardening, and release-aware fork update tooling. | Evaluation and post-application continuity are stronger. The generated-dashboard, manual-submission, interruption-recovery, and application-level cost-control assessments do not change. |

### Adjacent market watch

[JobSync](https://github.com/Gsync/jobsync/compare/1a8647bdb0108b26481b509323d503d0ab433184...8212d02bea35cdff15137b1432c9466bf9cb9a5c)
also moved materially across 178 commits, adding automated discovery, resume
review and job-match tools, cover-letter generation, and an in-product agent
chat. It remains on the adjacent watchlist because its primary product is a
self-hosted application tracker and career assistant rather than the same
guarded, durable end-to-end execution model. Commercial tools are excluded from
this source-level delta because they do not expose equivalent immutable code
snapshots.

## JobCtrl's UI is part of the product

JobCtrl's web app is the supported operator surface, not an optional viewer. It
can start work, edit and approve materials, show requirement-level evidence,
and follow durable runs as server-side changes arrive.

[![JobCtrl dashboard showing pipeline progress, job counts, source health, and apply runs](assets/screenshots/dashboard.png)](user/product-tour.md)

<ComparisonScreenshotCarousel />

All screenshots use synthetic sample data. Open the [Product Tour](user/product-tour.md)
for the complete Profile → Discovery → Pipeline → Jobs → Apply Review → Runs
workflow, including job-detail evidence and resume editing.

## Appendix: evidence-backed capability matrix

| Capability | JobCtrl | Career-Ops | JobOps | AI Job Search |
| --- | --- | --- | --- | --- |
| **Primary experience** | **Present.** A local product composed of a React client, TypeScript API, Python worker, Temporal workflows, and a supporting CLI. See [Runtime & Processes](architecture/runtime.md). | **Present.** A file-first system whose Markdown modes run through several AI coding CLIs. Agent-driven modes remain the broadest path, with standalone scripts for scanning, evaluation, tailoring, PDF generation, and tracking. [Architecture](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/ARCHITECTURE.md) | **Present.** A React/Vite client and Express API backed by SQLite, packaged for Docker self-hosting and also offered as a hosted instance. [Architecture](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/orchestrator/README.md) | **Present, intentionally narrow.** A Claude Code command-and-skill framework with Python/Bun utilities and LaTeX output. PDF/LaTeX remains the verified first-class document path. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/README.md) |
| **Graphical user interface** | **Present — supported product surface.** The React/Vite SPA is the main control plane, not an optional viewer. It provides Profile, Discovery, Pipelines, Dashboard, Jobs and job-detail audit, Apply Review with rich-text resume editing, Runs, Artifacts, Evidence, Analytics, Outreach, Preferences, and Debug views, with API mutations and SSE-driven refresh. See the screenshot-backed [Product Tour](user/product-tour.md) and [Frontend Architecture](architecture/frontend/index.md). | **Partial — alpha.** The established UI is a Go terminal dashboard. The optional Next.js web UI reads and writes the same local files, but its own README remains alpha and an open defect can resolve a tracker row to the wrong report ([issue #1623](https://github.com/santifer/career-ops/issues/1623)). [Alpha README](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/web/README.md) | **Present — supported product surface.** The primary Orchestrator UI manages discovery, tailoring, PDFs, application states, notes, and post-application handoff. [Orchestrator](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/docs-site/docs/features/orchestrator.md) | **Partial — generated report.** `/html-report` creates a self-contained offline HTML dashboard with stat cards, charts, and a filterable application table. It is regenerated output rather than a stateful application surface. [Command](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/.claude/commands/html-report.md) |
| **Job discovery** | **Present.** Configured sources feed a durable discovery and preparation pipeline; optional scheduling is off until enabled, and manual browser capture is also supported. See [Pipeline Operations](architecture/pipeline/operations.md) and [Daily Workflow](user/normal-flows.md#configure-discovery). | **Present.** A zero-token scanner reads open, no-auth ATS and board sources through 74 provider modules, with liveness, freshness, deduplication, health, and blacklist controls. [Providers](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/providers/README.md), [scanner](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/scan.mjs) | **Present.** The application searches LinkedIn, Indeed, Glassdoor, and more than ten other boards, then imports results into its pipeline. [Supported boards](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/README.md#supported-job-boards) | **Present.** `/scrape` searches and deduplicates through market-specific portal skills; shipped portals are Denmark-centered, with broader Freehire and LinkedIn starting points plus a custom-portal generator. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/README.md#job-search-tools) |
| **Missing-salary intelligence** | **Present — auditable numeric range.** JobCtrl preserves employer-posted, direct-market, and extrapolated benchmarks as separate authorities. Discover automatically refreshes missing or seven-day-old role-family, level, and country slices. A missing country can use official price levels and evidence-weighted same-company cross-country ratios; the UI exposes the exact anchor, inputs, raw factor, freshness, confidence, and review bounds. See [Compensation Evidence](user/compensation-evidence.md). | **No automatic missing-range estimate.** Career-Ops performs bounded salary research during evaluation, but if the posting lacks an advertised number it explicitly collapses the compensation output and skips detailed market rows; machine state records `advertised_comp` as `null` rather than substituting research. [Evaluation boundary](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/modes/oferta.md#L121-L156), [machine-summary rule](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/modes/oferta.md#L608) | **Advertised values only.** Its job record stores crawler-provided salary text and JobSpy range fields; deduplication retains the first non-null values, but the snapshot does not evidence automatic benchmark discovery or geographic extrapolation. [Job fields](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/shared/src/types/jobs.ts#L174-L197), [merge behavior](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/shared/src/job-matching.ts#L220-L247) | **BYO data only.** Its optional salary lookup reads a user-supplied dataset and the apply workflow skips salary benchmarking when none is configured; the reviewed snapshot does not evidence automatic missing-range discovery or geographic extrapolation. [Salary benchmark tool](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/tools/README_SALARY_TOOL.md#L1-L16) |
| **Fit evaluation** | **Present.** An LLM-produced 1–10 fit score is governed by a versioned rubric; the stored result includes criteria, requirement-level evidence, gaps, blockers, confidence, and model/prompt trace metadata. See [Scoring](architecture/scoring.md#scoring-fit-assessment). | **Present.** The AI produces a structured 1–5 evaluation; the per-job workflow maps requirements to exact CV lines, records gaps, and saves the result as a report. [Scoring](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/modes/_shared.md), [evaluation](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/modes/oferta.md) | **Present.** The AI produces a 0–100 suitability score and reason from the candidate profile, listing, and configurable scoring instructions; job-fact corrections require exact listing evidence. [Scoring prompt](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/shared/src/prompt-template-definitions.ts), [fact review](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/orchestrator/src/server/services/scorer.ts) | **Present.** The AI scores technical skills, experience, behavioral fit, and career alignment with fixed weights, while location, language, and work authorization can act as gates; strengths and gaps accompany the score. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/.claude/skills/job-application-assistant/04-job-evaluation.md) |
| **Tailored documents** | **Present.** JobCtrl generates reviewable resume, cover-letter, HTML, and PDF artifacts for a selected job. See [Tailoring Contract](architecture/tailoring.md). | **Present.** Career-Ops generates tailored CV/HTML/PDF, cover-letter, and application-email drafts through agent-driven modes or standalone paths, with custom templates supported. [Features](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/README.md#features) | **Present.** JobOps tailors a structured resume's headline, summary, skills, and selected projects, then renders a PDF through its configured local or Reactive Resume path. [Prompt](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/shared/src/prompt-template-definitions.ts), [tailoring transform](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/orchestrator/src/server/services/rxresume/tailoring.ts) | **Present.** `/apply` drafts a LaTeX CV and cover letter, sends both through a second-agent review, and compiles and inspects both PDFs; custom templates can be registered. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/README.md) |
| **Grounding and output validation** | **Present.** Resume bullets carry source provenance; deterministic fabrication and claim-grounding gates can reject a candidate; keyword coverage is checked against rendered output. See [Tailoring Contract](architecture/tailoring.md). | **Partial, strengthened.** A zero-LLM gap check separates supported requirements from genuine gaps, and a hard pre-PDF gate rejects selected employer, title, tool, and metric-like claims absent from configured sources. It remains narrower than full source-to-claim faithfulness, and rendered keyword coverage is not fail-closed ([issues #1411](https://github.com/santifer/career-ops/issues/1411) and [#1285](https://github.com/santifer/career-ops/issues/1285)). [Fact gate](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/verify-cv-facts.mjs) | **Partial.** The tailoring prompt says not to invent experience and constrains project selection to stored projects, but the snapshot does not evidence a deterministic source-to-claim validator or per-claim provenance for generated candidate text. [Tailoring prompt](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/shared/src/prompt-template-definitions.ts), [project selection](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/orchestrator/src/server/services/projectSelection.ts) | **Partial, strengthened.** The drafter and reviewer audit dates, roles, metrics, and claims against profile sources, while the compiled PDF's ATS text and truthful requirement coverage are checked. These remain agent instructions and document checks rather than a deterministic source-to-claim provenance gate. [Workflow](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/.claude/commands/apply.md) |
| **Local data and external processing** | **Present.** The database, configuration, generated files, logs, and browser state are local. Selected workflows send necessary content to configured LLMs, job sources, Gmail, CAPTCHA, Maps, or telemetry services. Local data is not encrypted. See [Data, Privacy & Safety](user/data-and-safety.md#local-data) and [What Leaves Your Machine](user/security.md#what-leaves-your-machine). | **Present.** Human-readable Markdown/YAML/TSV files are canonical and SQLite is a derived index; no hosted account is required. AI content goes to the provider chosen through the user's CLI, and local-model paths are available. [Architecture](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/ARCHITECTURE.md) | **Present, with hosted and integration paths.** Self-hosted state uses local SQLite and generated files. Configured LLMs, job boards, Gmail, optional Reactive Resume, anonymous analytics, or the optional hosted service can cross that boundary. [Architecture](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/orchestrator/README.md), [service and analytics disclosures](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/README.md) | **Present, with optional publishing.** Profile sources, generated LaTeX/PDFs, a CSV tracker, and application archives live in the user's fork. `/notion-sync` publishes selected tracker metadata; `/gmail-sync` reads Gmail and proposes local changes after review. [Commands](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/README.md) |
| **Application assistance and submission boundary** | **Present.** The browser path runs transport-locked rehearsals and leaves final browser submit to the user. The owned Gmail path can send only an exact-approved recipient/attachment candidate, with submit intent recorded immediately before the send. See [Approval And Control Gates](user/security.md#approval-and-control-gates). | **Present.** The apply assistant can fill supported ATS fields, but the user reviews the form and clicks Submit; the project states that it never submits, sends, or clicks on the user's behalf. [Boundary](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/docs/APPLY_AUTOFILL.md) | **Partial.** JobOps prepares tailored materials and opens the application target, but states that the user applies manually; no form-filling or owned submission path was evidenced. [Source](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/README.md) | **Partial.** `/apply` prepares reviewed CV and cover-letter files, then hands submission to the user; browser-form filling or submission is not evidenced. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/.claude/commands/apply.md) |
| **Post-application and coaching** | **Present.** JobCtrl records outcomes and supports grounded, stored interview preparation **in Beta**, contact research, outreach drafts, and follow-up reminders; it is not a live interview assistant and does not send outreach. See [Daily Workflow](user/normal-flows.md) and [Responsible Use Boundaries](user/data-and-safety.md#responsible-use-boundaries). | **Present, expanded.** Outcome archives, follow-up and reply tooling, interview preparation, company and compensation analysis, contact research, offer-stage support, and negotiation scripts are shipped. The broader closed learning loop remains open ([issue #1724](https://github.com/santifer/career-ops/issues/1724)). [Outcome mode](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/modes/outcome.md), [features](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/README.md#features) | **Present.** Gmail messages are matched to jobs; high-confidence matches update timelines automatically, while uncertain matches enter a review queue. [Tracking Inbox](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/docs-site/docs/features/post-application-tracking.md) | **Present.** `/outcome` archives results and feeds calibration; `/interview` prepares for stages; `/upskill` creates a gap plan; `/gmail-sync` proposes status changes for approval. [Commands](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/README.md) |
| **Interruption and recovery** | **Present.** Long-running work uses Temporal histories, retries, heartbeats, and stable workflow identities; ambiguous owned-send results park for human verification instead of risking a duplicate. See [Runtime & Processes](architecture/runtime.md) and [Browser Final Submit Is Not Delegated](user/security.md#browser-final-submit-is-not-delegated). | **Partial.** Canonical files, integrity tools, locks, and resumable batch flags preserve some progress, but there is no durable workflow engine. [Architecture](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/ARCHITECTURE.md), [batch recovery](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/docs/RUNNING_ON_A_BUDGET.md) | **Partial.** Run records and job states persist in SQLite, but active, paused, and cancellation state is process-local; the source explicitly says a server restart kills a running or paused pipeline. [Pipeline state](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/orchestrator/src/server/pipeline/orchestrator.ts) | **Not evidenced.** Commands write final artifacts, sync state, and outcome history, but the snapshot does not document checkpointed resumption or durable retry for an interrupted `/apply` run. [Workflow](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/.claude/commands/apply.md) |
| **LLM cost controls** | **Present.** A configurable daily estimated-spend ceiling runs a preflight before spendful workflows and exposes the estimate in health status; it is not provider billing truth. See [Daily LLM Spend Ceiling](user/security.md#daily-llm-spend-ceiling). | **Partial, expanded.** Users can choose hosted or local models, select spend tiers, pre-screen batches, cap/dry-run/resume work, and compress lower-priority context. There is still no application-wide dollar ledger or ceiling. [Budget guide](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/docs/RUNNING_ON_A_BUDGET.md), [context budget](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/lib/context-budget.mjs) | **Partial.** Hosted instances can enforce monthly action quotas, but no self-hosted estimated-spend ledger or ceiling was evidenced. [Hosted quotas](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/README.md#cloud) | **Not evidenced.** The workflow includes token-efficiency instructions but no application-level budget or spend ledger. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/README.md) |
| **Source license** | **Open source.** [AGPL-3.0-only](https://github.com/ebarti/JobCtrl/blob/b4063e1a3227d31eebacbc7d2c620ae5236f744b/LICENSE). | **Open source.** [MIT](https://github.com/santifer/career-ops/blob/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182/LICENSE). | **Source available with an additional restriction.** The repository combines AGPLv3 with the Commons Clause, which restricts selling the software or a service whose value derives substantially from it. [License](https://github.com/DaKheera47/job-ops/blob/c834c6502bf4685904b6abc3d5a008294b8b7020/LICENSE). | **Open source.** [MIT](https://github.com/MadsLorentzen/ai-job-search/blob/670d30ae7e9709bbf624deb2d9962ba5733331f5/LICENSE). |

## Snapshot and delta method

Repository claims were rechecked against default-branch source and documentation
at these immutable commits:

| Project | Previous reviewed snapshot | Reviewed snapshot | Reviewed on |
| --- | --- | --- | --- |
| JobCtrl | [`446056b`](https://github.com/ebarti/JobCtrl/tree/446056bb623df813365a302df35c6e04412c2446) | [`b4063e1`](https://github.com/ebarti/JobCtrl/tree/b4063e1a3227d31eebacbc7d2c620ae5236f744b) | 2026-08-15 |
| Career-Ops | [`16367ad`](https://github.com/santifer/career-ops/tree/16367add3f7291add757fc672a530294ae231bab) | [`03fc92b`](https://github.com/santifer/career-ops/tree/03fc92bb04e1fc8821ff4ec71b26bcc6f0da1182) | 2026-08-12 |
| JobOps | Not previously included | [`c834c65`](https://github.com/DaKheera47/job-ops/tree/c834c6502bf4685904b6abc3d5a008294b8b7020) | 2026-08-12 |
| AI Job Search | [`faa4799`](https://github.com/MadsLorentzen/ai-job-search/tree/faa479973aeaa7b8a1463112d088fdefff202961) | [`670d30a`](https://github.com/MadsLorentzen/ai-job-search/tree/670d30ae7e9709bbf624deb2d9962ba5733331f5) | 2026-08-12 |

The dates above are per-project review dates, not claims that every upstream
default branch was current on the other projects' review dates. A feature
counts as present only when its reviewed snapshot contains an implemented
command, product surface, runtime path, or documented generated artifact. Open
issues qualify limitations; they do not count as shipped roadmap features.
Commercial tools remain outside the snapshot matrix because they do not expose
equivalent immutable source evidence.
