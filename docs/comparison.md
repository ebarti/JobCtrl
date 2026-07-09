---
pageClass: jh-user-guide-page jh-visual-doc jh-comparison-page
---

# How JobCtrl Compares

JobCtrl, [Career-Ops](https://github.com/santifer/career-ops), and
[AI Job Search](https://github.com/MadsLorentzen/ai-job-search) address the same
broad problem through three different operating models. This is an
evidence-backed capability comparison, not a quality ranking.

<p class="jh-compare-eyebrow">Pinned snapshots · issue threads checked · no marketing claims taken at face value</p>

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
    <p class="jh-compare-card__tradeoff"><strong>Trade-off:</strong> the largest local runtime footprint of the three.</p>
    <a href="./user/screenshots">Explore the product tour →</a>
  </article>

  <article class="jh-compare-card" role="listitem">
    <div class="jh-compare-card__header">
      <p class="jh-compare-card__model">Files + coding CLIs</p>
      <h3>Career-Ops</h3>
      <span class="jh-compare-badge jh-compare-badge--partial">Web UI: opt-in alpha</span>
    </div>
    <p>Human-readable Markdown, YAML, and TSV files drive modes run through several AI coding CLIs.</p>
    <ul>
      <li>A terminal dashboard is established; the Next.js UI arrived on 2026-07-02.</li>
      <li>Application autofill stops before the user clicks Submit.</li>
      <li>Files and resumable batches preserve some progress without a workflow engine.</li>
    </ul>
    <p class="jh-compare-card__tradeoff"><strong>Best fit:</strong> people who want inspectable files and CLI choice.</p>
    <a href="#appendix-evidence-backed-capability-matrix">Open the evidence matrix →</a>
  </article>

  <article class="jh-compare-card" role="listitem">
    <div class="jh-compare-card__header">
      <p class="jh-compare-card__model">Claude Code workflow</p>
      <h3>AI Job Search</h3>
      <span class="jh-compare-badge jh-compare-badge--none">No graphical UI evidenced</span>
    </div>
    <p>Claude Code commands and skills coordinate local utilities and a LaTeX-first application workflow.</p>
    <ul>
      <li>The drafter-reviewer path produces CV, cover-letter, and PDF artifacts.</li>
      <li>Submission remains a user handoff after document preparation.</li>
      <li>Shipped search integrations are Denmark-centered, with broader starting points.</li>
    </ul>
    <p class="jh-compare-card__tradeoff"><strong>Best fit:</strong> Claude Code users comfortable with a LaTeX toolchain.</p>
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
        <td><strong>Not evidenced</strong> in the reviewed snapshot</td>
      </tr>
      <tr>
        <th scope="row">Tailored documents</th>
        <td>Resume, cover letter, HTML, and PDF</td>
        <td>CV/PDF and cover letter</td>
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
        <td>Model choice + batch cap, dry run, and resume controls</td>
        <td>Token-efficiency instructions; no app-level budget evidenced</td>
      </tr>
    </tbody>
  </table>
</div>

The compact view highlights operating-model differences. The
[full evidence matrix](#appendix-evidence-backed-capability-matrix) preserves
the qualifications, issue evidence, and source links behind every row.

## JobCtrl's UI is part of the product

JobCtrl's web app is the supported operator surface, not an optional viewer. It
can start work, edit and approve materials, show requirement-level evidence,
and follow durable runs as server-side changes arrive.

[![JobCtrl dashboard showing pipeline progress, job counts, source health, and apply runs](assets/screenshots/dashboard.png)](user/screenshots.md)

| [![Jobs table with fit scores, stages, and filters](assets/screenshots/jobs.png)](user/screenshots.md) | [![Apply Review editing a tailored resume with audit evidence](assets/screenshots/apply-review.png)](user/screenshots.md) |
| --- | --- |
| **Jobs** — scored and filterable, with every score inspectable | **Apply Review** — edit and approve the exact resume that ships |

All screenshots use synthetic sample data. Open the [Product Tour](user/screenshots.md)
for the complete Profile → Discovery → Pipeline → Jobs → Apply Review → Runs
workflow, including job-detail evidence and resume editing.

## Which operating style fits?

<div class="jh-compare-fit-grid">
  <div><strong>Choose JobCtrl</strong><span>when you want a structured application, visible audit records, durable automation, and optional supervised submission.</span></div>
  <div><strong>Choose Career-Ops</strong><span>when human-readable files, several AI coding CLI choices, and a manual final submit click are the priority.</span></div>
  <div><strong>Choose AI Job Search</strong><span>when you already work in Claude Code and prefer a tightly specified LaTeX drafter-reviewer workflow.</span></div>
</div>

## Method and limitations

This page was last verified on **2026-07-09** against these exact snapshots:

| Project | Default-branch snapshot |
| --- | --- |
| JobCtrl | [`15356b39790e8396d1892573f2810d2ebf7fb359`](https://github.com/ebarti/JobCtrl/tree/15356b39790e8396d1892573f2810d2ebf7fb359) |
| Career-Ops | [`e9bacc484185f56cec210ea821bf1774e989acea`](https://github.com/santifer/career-ops/tree/e9bacc484185f56cec210ea821bf1774e989acea) |
| AI Job Search | [`fea59fd8df52082d2a564fe82bdebe587f335d58`](https://github.com/MadsLorentzen/ai-job-search/tree/fea59fd8df52082d2a564fe82bdebe587f335d58) |

Primary evidence came from first-party repository documentation, prompts,
configuration, code, and repository issue threads. The issue pass inventoried
every open Career-Ops issue, reviewed a risk-focused sample of its open and
closed threads, and reviewed every AI Job Search issue on **2026-07-09**.
User-authored reports were treated as field evidence, not proof of universal
behavior.
An issue was treated as a current limitation only when it matched the pinned code
or a maintainer confirmed the behavior; an open fix pull request was not treated
as shipped, and a closed defect fixed before the snapshot was not carried forward
as current. Issue text was not accepted verbatim: for example, AI Job Search
[issue #106](https://github.com/MadsLorentzen/ai-job-search/issues/106) still says
`search_company` has zero tests, while the pinned snapshot already contains
`SearchCompanyTests`; only the remaining direct `match_score` coverage gap is
current, and it is too narrow to affect this product-level table.

The projects were not benchmarked against the same jobs, profiles, models, or
machines, so this page makes no claim about output quality, speed, reliability
rates, or cost in practice. It is also not a security review, legal review, or
certification that automated access complies with every job site's terms.

Re-verify this page for every JobCtrl release and at least quarterly. Comparative
claims should remain pinned to exact upstream commits; if a capability cannot be
confirmed from a current primary source, mark it **Not evidenced** rather than
inferring it from a project name or marketing copy.

### Reading the statuses

- **Present** means first-party documentation and implementation artifacts
  support the capability in the cited snapshot. It does not mean this review
  executed or benchmarked the upstream project.
- **Partial** means the project covers a useful part of the capability, or uses
  a narrower workflow.
- **Not evidenced** means no matching capability was found in the cited public
  snapshot. It does not mean the project could not add one or that a user could
  not build it through customization.

## Appendix: evidence-backed capability matrix

| Capability | JobCtrl | Career-Ops | AI Job Search |
| --- | --- | --- | --- |
| **Primary experience** | **Present.** A local product composed of a React client, TypeScript API, Python worker, Temporal workflows, and a supporting CLI. See [Runtime Boundaries](architecture/runtime.md). | **Present.** A file-first system whose Markdown modes run through several AI coding CLIs, with standalone evaluators for narrower paths. These surfaces are not feature-equivalent: the pinned headless OpenAI-compatible path stops after evaluation, before tailoring/PDF generation ([open issue #1669](https://github.com/santifer/career-ops/issues/1669)). [Architecture](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/ARCHITECTURE.md#L30-L70) | **Present, intentionally narrow.** A Claude Code command-and-skill framework with Python/Bun utilities and LaTeX output. The maintainer declined in-tree OpenCode support to avoid duplicated workflow sources ([issue #45](https://github.com/MadsLorentzen/ai-job-search/issues/45)); PDF/LaTeX is the only verified first-class document path ([issue #47](https://github.com/MadsLorentzen/ai-job-search/issues/47)). [Source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L24-L52) |
| **Graphical user interface** | **Present — supported product surface.** The React/Vite SPA is the main control plane, not an optional viewer. It provides Profile, Discovery, Pipelines, Dashboard, Jobs and job-detail audit, Apply Review with rich-text resume editing, Runs, Artifacts, Evidence, Analytics, Outreach, Preferences, and Debug views, with API mutations and SSE-driven refresh. See the screenshot-backed [Product Tour](user/screenshots.md) and [Frontend Architecture](architecture/frontend/index.md). | **Partial — recent alpha.** The long-standing UI is a Go terminal dashboard. The optional Next.js web UI first landed on **2026-07-02**, six days before the pinned snapshot, and its own README says to expect rough edges. It can view and write the core files across Pipeline, Explore, Apply, Today, Analytics, CV, and Config, but an open alpha defect can resolve a tracker row to the wrong report and application URL ([issue #1623](https://github.com/santifer/career-ops/issues/1623)). [Alpha README](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/web/README.md#L1-L43), [introduction commit](https://github.com/santifer/career-ops/commit/1791dc4e3a14aeb10decd852c927bb636aefe00d) | **Not evidenced.** The reviewed snapshot exposes Claude Code commands, local files, and generated documents; no graphical application or dashboard implementation was found. [Repository structure](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L132-L193) |
| **Job discovery** | **Present.** Configured sources feed a durable discovery and preparation pipeline; optional scheduling is off until enabled, and manual browser capture is also supported. See [Pipeline Operations](architecture/pipeline/operations.md) and [Daily Workflow](user/normal-flows.md#configure-discovery). | **Present, with a current metadata gap.** A zero-token scanner reads open, no-auth ATS APIs and feeds, with 21 provider modules and optional liveness verification. At this snapshot, provider posting dates are dropped before `pipeline.md` and scan history, so freshness cannot be carried forward without another fetch ([open issue #1578](https://github.com/santifer/career-ops/issues/1578)). [Architecture](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/ARCHITECTURE.md#L46-L52), [provider count and verification](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/README.md#L321-L342) | **Present.** `/scrape` searches and deduplicates listings. Four shipped portals focus on Denmark; LinkedIn and FreeHire provide broader starting points, and `/add-portal` scaffolds a market-specific integration in the user's fork. The previously missing `/scrape` command wiring is fixed in this snapshot ([issue #68](https://github.com/MadsLorentzen/ai-job-search/issues/68)); FreeHire is an external best-effort service with no SLA and a self-host option ([issue #62](https://github.com/MadsLorentzen/ai-job-search/issues/62)). [Source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L263-L278) |
| **Fit evaluation** | **Present.** An LLM-produced 1–10 fit score is governed by a versioned rubric; the stored result includes criteria, requirement-level evidence, gaps, blockers, confidence, and model/prompt trace metadata. See [Scoring](architecture/scoring.md#scoring-fit-assessment). | **Present.** The AI produces a structured 1–5 evaluation. The per-job workflow maps requirements to exact CV lines, records gaps, and saves the result as a report. [Scoring source](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/modes/_shared.md#L35-L61), [evidence mapping](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/modes/oferta.md#L65-L81) | **Present.** The AI scores technical skills, experience, behavioral fit, and career alignment with fixed weights, while location acts as a gate; strengths and gaps accompany the score. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.claude/skills/job-application-assistant/04-job-evaluation.md#L102-L151) |
| **Tailored documents** | **Present.** JobCtrl generates reviewable resume, cover-letter, HTML, and PDF artifacts for a selected job. See [Tailoring Contract](architecture/tailoring.md). | **Present.** Career-Ops generates tailored CV/PDF and cover-letter artifacts through its agent-driven modes. [Source](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/README.md#L98-L114) | **Present.** `/apply` drafts a LaTeX CV and cover letter, sends both through a second-agent review, and compiles them to PDF. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L196-L217) |
| **Grounding and output validation** | **Present.** Resume bullets carry source provenance; deterministic fabrication and claim-grounding gates can reject a candidate; keyword coverage is checked against rendered output. See [Tailoring Contract](architecture/tailoring.md). | **Partial.** Prompts restrict claims to named local sources, require exact CV evidence, and forbid invented metrics or skills. Enforcement is instruction- and review-based: the pinned snapshot has neither a fail-closed CV fact/faithfulness gate nor a final generated-CV keyword-coverage checker ([open issues #1411](https://github.com/santifer/career-ops/issues/1411) and [#1285](https://github.com/santifer/career-ops/issues/1285)). [Prompt rules](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/modes/_shared.md#L11-L31), [PDF rules](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/modes/pdf.md#L65-L72) | **Partial.** The drafter-reviewer instructions reject unsupported suggestions and require profile-grounded claims; PDF layout, ATS text extraction, and keyword coverage are also checked. These are agent instructions and document checks, not a deterministic source-to-claim provenance gate. One fork user reported that the reviewer and anti-fabrication rules caught real stretches, but that is useful field evidence rather than a guarantee ([issue #19](https://github.com/MadsLorentzen/ai-job-search/issues/19)). [Review rules](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.claude/commands/apply.md#L152-L174), [PDF and ATS checks](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.claude/commands/apply.md#L178-L255) |
| **Local data and external processing** | **Present.** The database, configuration, generated files, logs, and browser state are local. Selected workflows send the necessary content to configured LLMs, job sources, Gmail, CAPTCHA, Maps, or telemetry services. Local data is not encrypted. See [Data, Privacy & Safety](user/data-and-safety.md#local-data) and [What Leaves Your Machine](user/security.md#what-leaves-your-machine). | **Present.** Human-readable Markdown/YAML/TSV files are canonical and a SQLite index is derived; no hosted account is required. Content sent for AI processing goes directly to the provider chosen through the user's CLI, while a local-model path is available. [Sources](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/ARCHITECTURE.md#L5-L24), [provider boundary](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/README.md#L420-L427) | **Present.** Profile sources, generated LaTeX/PDFs, a CSV tracker, and per-application archives live in the user's fork and personal outputs are gitignored. Claude Code and explicit web-research steps process the content needed by the workflow. [Sources](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L132-L193), [gitignore](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.gitignore#L21-L68) |
| **Application assistance and submission boundary** | **Present.** Browser and approved Gmail paths can submit applications. A dry run cannot submit, and the default approval gate binds live submission to reviewed materials, profile version, URL, and matching evidence; users can explicitly disable that approval requirement. See [Approval And Control Gates](user/security.md#approval-and-control-gates). | **Present.** The apply assistant can fill supported ATS form fields, but the user reviews the form and clicks Submit; the tool states that it never submits. [Source](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/docs/APPLY_AUTOFILL.md#L1-L7) | **Partial.** `/apply` evaluates the role and prepares reviewed CV and cover-letter files. The snapshot documents user submission followed by `/outcome`; it does not evidence browser-form filling or submission. [Source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.claude/commands/apply.md#L263-L284) |
| **Post-application and coaching** | **Present.** JobCtrl records outcomes and supports grounded, stored interview preparation **in Beta** (truthfulness gates are shipped; output quality lacks real-user validation), contact research, outreach drafts, and follow-up reminders; it is not a live interview assistant and does not send outreach. See [Daily Workflow](user/normal-flows.md) and [Responsible Use Boundaries](user/data-and-safety.md#responsible-use-boundaries). | **Partial.** Interview story banks and preparation, company/contact research, and negotiation scripts are present. A structured per-application outcome archive and calibration loop remain proposed rather than shipped ([open issues #1722](https://github.com/santifer/career-ops/issues/1722) and [#1724](https://github.com/santifer/career-ops/issues/1724)). [Current features](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/README.md#L98-L114) | **Present, with a handoff gap.** `/outcome` archives results and feeds future calibration; `/interview` builds stage-specific preparation, while `/upskill` turns recurring gaps into a learning plan. The current `/apply` completion message does not tell users that `/interview` exists ([open issue #108](https://github.com/MadsLorentzen/ai-job-search/issues/108)). [Source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L118-L128) |
| **Interruption and recovery** | **Present.** Long-running work uses Temporal histories, retries, heartbeats, and stable workflow identities; ambiguous apply results park for human verification instead of risking a duplicate. See [Runtime Boundaries](architecture/runtime.md) and [Applications Submit At Most Once](user/security.md#applications-submit-at-most-once). | **Partial.** Canonical files, integrity tools, and resumable batch flags preserve some progress, but there is no durable workflow engine. The pinned snapshot also has open defects in updater migration, tracker numbering, and report analytics ([#1706](https://github.com/santifer/career-ops/issues/1706), [#1704](https://github.com/santifer/career-ops/issues/1704), [#1679](https://github.com/santifer/career-ops/issues/1679)). [Architecture](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/ARCHITECTURE.md#L54-L64), [batch recovery](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/docs/RUNNING_ON_A_BUDGET.md#L104-L127) | **Not evidenced.** The command workflow writes final artifacts and outcome history, but the snapshot does not document checkpointed resumption or durable retry for an interrupted `/apply` run. [Workflow source](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.claude/commands/apply.md#L1-L11) |
| **LLM cost controls** | **Present.** A configurable daily estimated-spend ceiling runs a preflight before spendful workflows and exposes the estimate in health status; it is not provider billing truth. See [Daily LLM Spend Ceiling](user/security.md#daily-llm-spend-ceiling). | **Partial.** Users can choose hosted or local models and cap, dry-run, or resume batch work, but there is no application-wide dollar ledger or ceiling. The pinned API evaluators resend an uncached static prompt, and Claude Code loads duplicated project instructions ([open issues #1709](https://github.com/santifer/career-ops/issues/1709) and [#1713](https://github.com/santifer/career-ops/issues/1713)). Earlier user reports also led to a bounded-research fix after one role evaluation recursively consumed tens of millions of tokens ([fixed issue #1235](https://github.com/santifer/career-ops/issues/1235)). [Budget options](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/docs/RUNNING_ON_A_BUDGET.md#L1-L13) | **Not evidenced.** The workflow includes token-efficiency instructions, but it has no application-level budget or spend ledger. One user reported roughly 17% of a Claude session for a full `/apply`; the maintainer's later changes improved reviewer dispatch but were described as probably token-neutral end to end because PDF inspection spends the savings ([issue #2](https://github.com/MadsLorentzen/ai-job-search/issues/2)). [Sources](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/README.md#L46-L52), [workflow](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/.claude/commands/apply.md#L7-L11) |
| **Open-source license** | **Present.** [AGPL-3.0-only](https://github.com/ebarti/JobCtrl/blob/15356b39790e8396d1892573f2810d2ebf7fb359/LICENSE). | **Present.** [MIT](https://github.com/santifer/career-ops/blob/e9bacc484185f56cec210ea821bf1774e989acea/LICENSE). | **Present.** [MIT](https://github.com/MadsLorentzen/ai-job-search/blob/fea59fd8df52082d2a564fe82bdebe587f335d58/LICENSE). |
