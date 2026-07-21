---
pageClass: jh-visual-doc jh-comparison-page
---

# How JobCtrl Compares

JobCtrl, [Career-Ops](https://github.com/santifer/career-ops), and
[AI Job Search](https://github.com/MadsLorentzen/ai-job-search) address the same
broad problem through three different operating models. Across the capabilities
reviewed here, JobCtrl is the only option that combines a supported graphical
product, durable workflows, deterministic grounding gates, and guarded
submission paths. The comparison was last reverified on **2026-07-20**; the
[snapshot method](#snapshot-and-delta-method) keeps current claims separate from
changes since the prior 2026-07-09 review.

## Three operating models

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
      <li>Freshness, company exclusions, spend tiers, and a metric fact gate now strengthen the file-first workflow.</li>
      <li>Application autofill stops before the user clicks Submit.</li>
    </ul>
    <p class="jh-compare-card__verdict"><strong>Gap versus JobCtrl:</strong> the operator experience remains file- and CLI-first, the optional web UI is alpha, and interrupted work has no durable workflow engine.</p>
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
    <caption>Selected differences between the three reviewed open-source job-search tools</caption>
    <thead>
      <tr>
        <th scope="col">Capability</th>
        <th scope="col">JobCtrl</th>
        <th scope="col">Career-Ops</th>
        <th scope="col">AI Job Search</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th scope="row">Primary surface</th>
        <td>Web app + local API/worker; supporting CLI</td>
        <td>Files + AI coding CLIs; terminal dashboard</td>
        <td>Claude Code commands/skills + local utilities</td>
      </tr>
      <tr>
        <th scope="row">Graphical UI</th>
        <td><strong>Supported product surface</strong></td>
        <td><strong>Partial:</strong> optional Next.js alpha</td>
        <td><strong>Partial:</strong> generated offline HTML dashboard</td>
      </tr>
      <tr>
        <th scope="row">Tailored documents</th>
        <td>Resume, cover letter, HTML, and PDF</td>
        <td>CV/HTML/PDF and cover letter</td>
        <td>LaTeX CV, cover letter, and PDF</td>
      </tr>
      <tr>
        <th scope="row">Submission boundary</th>
        <td>Dry run + guarded browser/Gmail paths; approval on by default</td>
        <td>Form autofill; the user clicks Submit</td>
        <td>Reviewed documents; the user submits</td>
      </tr>
      <tr>
        <th scope="row">Interrupted work</th>
        <td>Temporal history, retries, and stable workflow identities</td>
        <td>File integrity + resumable batch flags; no workflow engine</td>
        <td>No checkpointed apply resumption evidenced</td>
      </tr>
      <tr>
        <th scope="row">Application-level cost control</th>
        <td>Daily estimated-spend ceiling</td>
        <td>Spend tiers, batch pre-screen/cap, dry run, and resume controls</td>
        <td>Token-efficiency instructions; no app-level budget evidenced</td>
      </tr>
    </tbody>
  </table>
</div>

The compact view highlights operating-model differences. The
[full evidence matrix](#appendix-evidence-backed-capability-matrix) preserves
the qualifications, issue evidence, and source links behind every row.

## What changed since 2026-07-09

The two closest peers both moved materially. These are changes between exact
Git snapshots, not deductions from mutable marketing pages.

| Project | Verified additions | Effect on this comparison |
| --- | --- | --- |
| **Career-Ops** | Across [178 commits](https://github.com/santifer/career-ops/compare/e9bacc484185f56cec210ea821bf1774e989acea...16367add3f7291add757fc672a530294ae231bab), it added an end-to-end OpenAI-compatible tailoring/PDF path, economy/standard/premium spend tiers with batch pre-screening, posting-date and freshness handling, an opt-in company blacklist, scanner-run health data, recurring skill-gap analysis, stage-velocity analysis, prompt caching, and a hard gate for unsupported metric-like CV claims. | The earlier headless-path and posting-freshness gaps are closed. Discovery and cost control are stronger. Grounding remains **Partial** because the hard gate covers metric-like claims rather than every generated claim, and [full faithfulness](https://github.com/santifer/career-ops/issues/1411) plus [final rendered keyword coverage](https://github.com/santifer/career-ops/issues/1285) remain open. |
| **AI Job Search** | Across [51 commits](https://github.com/MadsLorentzen/ai-job-search/compare/fea59fd8df52082d2a564fe82bdebe587f335d58...faa479973aeaa7b8a1463112d088fdefff202961), it added a self-contained HTML application dashboard, approval-gated Gmail outcome sync, one-way Notion publishing, recurring-gap learning plans, profile-union grounding audits, portal enable/disable controls, and user-opened LinkedIn referral-search links. | Its UI assessment changes from **Not evidenced** to **Partial**: the HTML report is useful but is generated output, not an interactive product application. Post-application support is stronger; submission, durable recovery, and application-wide cost-control assessments do not change. |

### Adjacent market watch

The broader watchlist was also rechecked. [JobSync](https://github.com/Gsync/jobsync/compare/cf543f49edb516354df15d94d2d2bc13775a8e39...1a8647bdb0108b26481b509323d503d0ab433184)
added Lever discovery and approval-gated MCP writes among 25 commits, but remains
an adjacent self-hosted tracker rather than a closer end-to-end peer.
ApplyPilot and Proficiently had no default-branch feature commits after the
prior review. For the commercial watchlist (Simplify, Huntr, Teal, Jobscan,
Applyd, Offerd, LoopCV, LazyApply, Sonara, JobCopilot, and AIApply), this pass
found no first-party, date-stamped release after the baseline. That does **not**
prove that no private or silent rollout occurred, so unchanged marketing pages
are not presented as product deltas.

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

| Capability | JobCtrl | Career-Ops | AI Job Search |
| --- | --- | --- | --- |
| **Primary experience** | **Present.** A local product composed of a React client, TypeScript API, Python worker, Temporal workflows, and a supporting CLI. See [Runtime & Processes](architecture/runtime.md). | **Present.** A file-first system whose Markdown modes run through several AI coding CLIs. Agent-driven modes remain the broadest path, while a standalone OpenAI-compatible flow now evaluates, tailors HTML, and renders PDF end to end. [Architecture](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/ARCHITECTURE.md#L30-L70), [headless path](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/RUNNING_ON_A_BUDGET.md#L185-L210) | **Present, intentionally narrow.** A Claude Code command-and-skill framework with Python/Bun utilities and LaTeX output. The maintainer declined in-tree OpenCode support to avoid duplicated workflow sources ([issue #45](https://github.com/MadsLorentzen/ai-job-search/issues/45)); PDF/LaTeX is the only verified first-class document path ([issue #47](https://github.com/MadsLorentzen/ai-job-search/issues/47)). [Source](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/README.md#L40-L60) |
| **Graphical user interface** | **Present — supported product surface.** The React/Vite SPA is the main control plane, not an optional viewer. It provides Profile, Discovery, Pipelines, Dashboard, Jobs and job-detail audit, Apply Review with rich-text resume editing, Runs, Artifacts, Evidence, Analytics, Outreach, Preferences, and Debug views, with API mutations and SSE-driven refresh. See the screenshot-backed [Product Tour](user/product-tour.md) and [Frontend Architecture](architecture/frontend/index.md). | **Partial — alpha.** The long-standing UI is a Go terminal dashboard. The optional Next.js web UI reads and writes the same local files across Pipeline, Explore, Apply, Today, Analytics, CV, and Config, but its own README remains alpha and an open defect can resolve a tracker row to the wrong report and application URL ([issue #1623](https://github.com/santifer/career-ops/issues/1623)). [Alpha README](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/web/README.md#L1-L43) | **Partial — generated report.** `/html-report` creates a self-contained offline HTML dashboard with stat cards, charts, and a filterable application table. It is regenerated output rather than a stateful application surface. [Command](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/commands/html-report.md#L1-L43) |
| **Job discovery** | **Present.** Configured sources feed a durable discovery and preparation pipeline; optional scheduling is off until enabled, and manual browser capture is also supported. See [Pipeline Operations](architecture/pipeline/operations.md) and [Daily Workflow](user/normal-flows.md#configure-discovery). | **Present.** A zero-token scanner reads open, no-auth ATS APIs and feeds through 21 provider modules, with optional liveness verification. It now persists posting dates, supports a maximum-age gate, reports scanner health, and can skip a user-owned company blacklist while keeping an explicit audit bypass. [Provider count and verification](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/README.md#L342-L350), [freshness gate](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/modes/scan.md#L224-L227), [blacklist and posting-date evidence](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/SCRIPTS.md#L365-L386) | **Present.** `/scrape` searches and deduplicates listings through market-specific portal skills; each can now be disabled without deletion. Shipped portals remain Denmark-centered, with broader starting points and user-opened LinkedIn people-search links for higher-fit matches; those links are generated, not scraped. [Workflow](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/skills/job-scraper/SKILL.md#L58-L72), [referral links](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/skills/job-scraper/SKILL.md#L131-L153) |
| **Fit evaluation** | **Present.** An LLM-produced 1–10 fit score is governed by a versioned rubric; the stored result includes criteria, requirement-level evidence, gaps, blockers, confidence, and model/prompt trace metadata. See [Scoring](architecture/scoring.md#scoring-fit-assessment). | **Present.** The AI produces a structured 1–5 evaluation. The per-job workflow maps requirements to exact CV lines, records gaps, and saves the result as a report. [Scoring source](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/modes/_shared.md#L35-L61), [evidence mapping](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/modes/oferta.md#L65-L81) | **Present.** The AI scores technical skills, experience, behavioral fit, and career alignment with fixed weights, while location acts as a gate; strengths and gaps accompany the score. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/skills/job-application-assistant/04-job-evaluation.md#L102-L151) |
| **Tailored documents** | **Present.** JobCtrl generates reviewable resume, cover-letter, HTML, and PDF artifacts for a selected job. See [Tailoring Contract](architecture/tailoring.md). | **Present.** Career-Ops generates tailored CV/HTML/PDF and cover-letter artifacts through agent-driven modes or its headless OpenAI-compatible path, with custom templates supported. [Features](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/README.md#L106-L122), [headless path](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/RUNNING_ON_A_BUDGET.md#L185-L210) | **Present.** `/apply` drafts a LaTeX CV and cover letter, sends both through a second-agent review, and compiles and inspects both PDFs; custom LaTeX templates can be registered. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/README.md#L221-L242) |
| **Grounding and output validation** | **Present.** Resume bullets carry source provenance; deterministic fabrication and claim-grounding gates can reject a candidate; keyword coverage is checked against rendered output. See [Tailoring Contract](architecture/tailoring.md). | **Partial, strengthened.** A zero-LLM pre-generation gap check separates supported requirements from genuine gaps, and a hard pre-PDF gate rejects metric-like claims absent from configured sources. That gate is narrower than full source-to-claim faithfulness, and final rendered-CV keyword coverage is still not fail-closed ([open issues #1411](https://github.com/santifer/career-ops/issues/1411) and [#1285](https://github.com/santifer/career-ops/issues/1285)). [PDF flow](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/modes/pdf.md#L3-L31), [fact-gate scope](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/verify-cv-facts.mjs#L80-L95) | **Partial, strengthened.** The drafter and reviewer now audit dates, roles, metrics, and claims against the union of three profile sources, while the compiled PDF's ATS text and truthful requirement coverage are checked. These remain agent instructions and document checks rather than a deterministic source-to-claim provenance gate. [Draft audit](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/commands/apply.md#L67-L80), [reviewer audit](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/commands/apply.md#L127-L128), [PDF checks](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/README.md#L223-L239) |
| **Local data and external processing** | **Present.** The database, configuration, generated files, logs, and browser state are local. Selected workflows send the necessary content to configured LLMs, job sources, Gmail, CAPTCHA, Maps, or telemetry services. Local data is not encrypted. See [Data, Privacy & Safety](user/data-and-safety.md#local-data) and [What Leaves Your Machine](user/security.md#what-leaves-your-machine). | **Present.** Human-readable Markdown/YAML/TSV files are canonical and a SQLite index is derived; no hosted account is required. Content sent for AI processing goes directly to the provider chosen through the user's CLI, while a local-model path is available. [Architecture](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/ARCHITECTURE.md#L5-L24), [model options](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/README.md#L424-L431) | **Present, with optional publishing.** Profile sources, generated LaTeX/PDFs, a CSV tracker, and per-application archives live in the user's fork and personal outputs are gitignored. Explicit `/notion-sync` publishes selected tracker metadata one way, while repo files remain canonical; `/gmail-sync` reads Gmail and proposes local changes only after review. [Commands](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/README.md#L136-L147), [gitignore](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.gitignore#L21-L68) |
| **Application assistance and submission boundary** | **Present.** Browser and approved Gmail paths can submit applications. A dry run cannot submit, and the default approval gate binds live submission to reviewed materials, profile version, URL, and matching evidence; users can explicitly disable that approval requirement. See [Approval And Control Gates](user/security.md#approval-and-control-gates). | **Present.** The apply assistant can fill supported ATS form fields, but the user reviews the form and clicks Submit; the project states that it never submits, sends, or clicks on the user's behalf. [Source](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/README.md#L430-L437) | **Partial.** `/apply` evaluates the role and prepares reviewed CV and cover-letter files. The workflow then hands submission to the user and directs them to `/outcome` or `/interview`; it does not evidence browser-form filling or submission. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/commands/apply.md#L292-L303) |
| **Post-application and coaching** | **Present.** JobCtrl records outcomes and supports grounded, stored interview preparation **in Beta** (truthfulness gates are shipped; output quality lacks real-user validation), contact research, outreach drafts, and follow-up reminders; it is not a live interview assistant and does not send outreach. See [Daily Workflow](user/normal-flows.md) and [Responsible Use Boundaries](user/data-and-safety.md#responsible-use-boundaries). | **Partial, expanded.** Interview story banks, panel preparation, company-risk research, compensation observations, funnel velocity, recurring skill-gap analysis, contact research, and negotiation scripts are present. A canonical per-application outcome archive and closed calibration loop remain proposed rather than shipped ([open issues #1722](https://github.com/santifer/career-ops/issues/1722) and [#1724](https://github.com/santifer/career-ops/issues/1724)). [Current features](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/README.md#L106-L122), [analysis scripts](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/SCRIPTS.md#L193-L245) | **Present, expanded.** `/outcome` archives results and feeds future calibration; `/interview` builds stage-specific preparation; `/upskill` produces a recurring-gap heatmap and learning plan; `/gmail-sync` proposes email-derived status changes for approval. The earlier `/apply` handoff gap is closed: completion now points to both `/outcome` and `/interview`. [Commands](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/README.md#L136-L147), [handoff](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/commands/apply.md#L301-L303) |
| **Interruption and recovery** | **Present.** Long-running work uses Temporal histories, retries, heartbeats, and stable workflow identities; ambiguous apply results park for human verification instead of risking a duplicate. See [Runtime & Processes](architecture/runtime.md) and [Applications Submit At Most Once](user/security.md#applications-submit-at-most-once). | **Partial.** Canonical files, integrity tools, and resumable batch flags preserve some progress, but there is no durable workflow engine. The updater, tracker-numbering, and report-analytics defects open at the prior snapshot are now closed. [Architecture](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/ARCHITECTURE.md#L54-L64), [batch recovery](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/RUNNING_ON_A_BUDGET.md#L104-L127) | **Not evidenced.** Commands write final artifacts, sync state, and outcome history, but the snapshot does not document checkpointed resumption or durable retry for an interrupted `/apply` run. [Workflow source](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/.claude/commands/apply.md#L1-L11) |
| **LLM cost controls** | **Present.** A configurable daily estimated-spend ceiling runs a preflight before spendful workflows and exposes the estimate in health status; it is not provider billing truth. See [Daily LLM Spend Ceiling](user/security.md#daily-llm-spend-ceiling). | **Partial, expanded.** Users can choose hosted or local models, select economy/standard/premium spend tiers, pre-screen batches, cap/dry-run/resume work, and use OpenRouter prompt caching. There is still no application-wide dollar ledger or ceiling. [Spend tiers](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/RUNNING_ON_A_BUDGET.md#L17-L36), [headless-cost path](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/docs/RUNNING_ON_A_BUDGET.md#L180-L210) | **Not evidenced.** The workflow includes token-efficiency instructions, but it has no application-level budget or spend ledger. PDF inspection deliberately spends some of the reviewer-dispatch savings to reduce broken output. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/README.md#L221-L242) |
| **Open-source license** | **Present.** [AGPL-3.0-only](https://github.com/ebarti/JobCtrl/blob/446056bb623df813365a302df35c6e04412c2446/LICENSE). | **Present.** [MIT](https://github.com/santifer/career-ops/blob/16367add3f7291add757fc672a530294ae231bab/LICENSE). | **Present.** [MIT](https://github.com/MadsLorentzen/ai-job-search/blob/faa479973aeaa7b8a1463112d088fdefff202961/LICENSE). |

## Snapshot and delta method

Repository claims were rechecked against default-branch source and documentation
at these immutable commits:

| Project | Previous reviewed snapshot | Current reviewed snapshot |
| --- | --- | --- |
| JobCtrl | [`15356b3`](https://github.com/ebarti/JobCtrl/tree/15356b39790e8396d1892573f2810d2ebf7fb359) | [`446056b`](https://github.com/ebarti/JobCtrl/tree/446056bb623df813365a302df35c6e04412c2446) |
| Career-Ops | [`e9bacc4`](https://github.com/santifer/career-ops/tree/e9bacc484185f56cec210ea821bf1774e989acea) | [`16367ad`](https://github.com/santifer/career-ops/tree/16367add3f7291add757fc672a530294ae231bab) |
| AI Job Search | [`fea59fd`](https://github.com/MadsLorentzen/ai-job-search/tree/fea59fd8df52082d2a564fe82bdebe587f335d58) | [`faa4799`](https://github.com/MadsLorentzen/ai-job-search/tree/faa479973aeaa7b8a1463112d088fdefff202961) |

The main matrix baseline is **2026-07-09**. The adjacent/commercial watchlist
was previously assessed on **2026-07-05**. A feature counts as present only when
the current snapshot contains an implemented command, product surface, runtime
path, or documented generated artifact. Open issues qualify limitations; they
do not count as shipped roadmap features.

Commercial products do not expose equivalent Git history, so the refresh used
first-party product and dated update surfaces, including
[Simplify Copilot](https://simplify.jobs/copilot),
[Huntr product updates](https://huntr.co/product-updates),
[Teal's interview workspace](https://help.tealhq.com/en/articles/14435728-how-to-prepare-for-interviews-using-teal),
and [Jobscan's January 2026 launch](https://info.jobscan.co/en/january-launch-webinar).
Only an explicitly dated post-baseline release would be described as a new
commercial delta; lack of such evidence is reported as unknown rather than as
proof of no change.
