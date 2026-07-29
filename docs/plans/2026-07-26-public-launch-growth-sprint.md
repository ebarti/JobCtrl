# JobCtrl Public Launch Growth Sprint

- **Date:** 2026-07-26
- **Status:** Active
- **Window:** 30 days from the first approved campaign publication
- **Scope:** Conversion surface, public launch assets, channel sequencing,
  measurement, and feedback capture
- **Boundary:** This plan prepares external posts but does not publish them.
  Every account action and public submission requires owner approval.

### Delivery update — 2026-07-29

The conversion surface and campaign kit landed in #509. Consent-gated
documentation analytics and its release-check compatibility landed in
#511–#512. The outcome-led site, public paths, README star prompt, product
social card, crawl metadata, release copy, and Discussions are live. The demo
video, clean-Mac preflight, analytics-optional owner decision, search
submissions, directory launches, article, and external campaign publications
remain open.

## 0. Why This Sprint Exists

JobCtrl has a launchable product but almost no qualified distribution.
The 2026-07-26 baseline is:

| Signal | Baseline | Interpretation |
| --- | ---: | --- |
| GitHub stars | 3 total; 2 external | Too little awareness to judge product demand |
| Latest release acquisition assets | `install.sh`: 11 downloads; installer and release ZIP: 6 each | Small but non-zero install intent |
| Forks / watchers / open issues | 0 / 0 / 0 | No contributor or user feedback loop yet |
| Search discoverability | No result found for the product domain or repository | Launch traffic currently has no durable search tail |
| GitHub Discussions | Disabled | Interested visitors have no low-friction community surface |
| Latest GitHub Release body | Empty | The release page does not explain why to try the product |

Owner-only repository traffic confirms that qualified awareness is the primary
bottleneck. Keep exact private traffic and referrer snapshots in the campaign
tracker rather than committing them to this public repository. Treat clone
counts as automation noise until a human source is proven; never use them as a
growth KPI.

## 1. Growth Invariant

Aggressive means high output and fast learning, not spam.

Every campaign action must:

1. Lead with a real user problem or an inspectable engineering decision.
2. Send visitors to a working product path, not an announcement-only page.
3. Follow the exact community rules checked on the day of posting.
4. Identify the maker honestly and avoid manufactured votes, comments, stars,
   testimonials, or install claims.
5. Use only synthetic product data in screenshots, recordings, and examples.
6. Keep application submission, personal data, credentials, and user artifacts
   out of marketing demonstrations.
7. Measure visits, demo exploration, installs, feedback, and retained users;
   stars are a useful distribution signal, not the product outcome.

## 2. Thirty-Day Targets

Targets are directional and should be revised after the first two launch waves.

| Outcome | Commit | Target | Stretch |
| --- | ---: | ---: | ---: |
| Qualified visits to `jobctrl.dev` or the repository | 1,000 | 3,000 | 7,500 |
| Visitors who enter and explore the demo | 100 | 350 | 1,000 |
| Installer or release-binary downloads | 40 | 125 | 300 |
| Confirmed successful first runs volunteered by users | 8 | 25 | 60 |
| External GitHub stars | 35 | 100 | 250 |
| Actionable external feedback threads | 10 | 30 | 75 |
| First-time external contributors | 1 | 3 | 8 |

Do not claim a confirmed install or first run from a download alone. Count it
only when a user reports success or an explicitly consented, privacy-approved
product signal proves it.

## 3. Conversion Work Before the Flagship Launch

### P0 — Required before Show HN or Product Hunt

- [x] Land and deploy the outcome-led docs-site hero.
- [x] Put the signed Apple-silicon install path in the deployed hero.
- [x] Add explicit demo, install, tour, comparison, and repository paths above
  the fold.
- [x] Add a direct but non-coercive star request to the repository README.
- [x] Replace the generic logo-only social card with a product-led 1200×630
  preview.
- [x] Generate `sitemap.xml` and publish a `robots.txt` sitemap pointer.
- [x] Replace the stale pre-launch root checklist with current public status.
- [x] Add a substantive `v2.0.7` GitHub Release body.
- [x] Enable GitHub Discussions with **Announcements**, **Ideas**, **Q&A**, and
  **Show and tell** categories; link it from the README after it is live.
- [ ] Record a 60–90 second synthetic demo showing discovery, evidence-backed
  scoring, truthful tailoring, review, and dry-run apply.
- [ ] **Owner decision:** decide whether visitors may use the demo after
  declining analytics. If approved, keep analytics opt-in, make the local
  synthetic workspace functional either way, and run the full privacy/edge
  Tier 3 gate before deployment.
- [ ] Verify the public install path on a clean supported Mac immediately before
  each flagship post.

The demo consent change is deliberately separate from this editorial patch. It
changes a privacy boundary and must not ship without an explicit owner decision,
updated owning docs, regression fixtures, reviewer approval, QA approval, and
production evidence.

### P1 — Required during the first week

- [ ] Submit `https://jobctrl.dev/sitemap.xml` to Google Search Console and Bing
  Webmaster Tools.
- [ ] Add JobCtrl to AlternativeTo after the submitting account satisfies its
  age requirement.
- [ ] Create and schedule a Product Hunt draft with two or more gallery assets
  and a public YouTube demo.
- [ ] Publish one technical article that stands alone without a product pitch.
- [ ] Publish the first weekly metrics-and-learning recap.

## 4. Message Architecture

### Primary promise

> Run your job search. Keep your data.

### One-sentence explanation

> JobCtrl is an open-source, local-first workspace that discovers jobs, explains
> fit from your real evidence, tailors truthful materials, and keeps live
> submission approval-gated by default.

### Differentiators to rotate, not stack

1. **Local ownership:** no JobCtrl account or hosted backend; the workspace
   stays on the user's machine by default.
2. **Proof instead of opaque scores:** requirement-level evidence explains why
   a role fits or does not.
3. **Truthful tailoring:** tailored resume bullets trace to profile evidence,
   while deterministic fabrication gates can reject bad resumes or cover
   letters.
4. **Human control at the consequential step:** dry runs cannot submit; live
   applications are approval-gated by default and bind to reviewed materials.
5. **Durable work:** Temporal histories, retries, and stable identities preserve
   long-running work and avoid duplicate submission.
6. **A real operator UI:** the web application is the product surface, not a
   generated report or a collection of prompt files.

### What not to say

- Do not call the product fully private or offline; configured providers, job
  sources, and optional integrations can receive scoped data.
- Do not promise more interviews, offers, or a better hiring outcome.
- Do not call interview preparation production-validated; it remains Beta.
- Do not imply native Windows or Intel macOS support.
- Do not advertise `pip install jobctrl` while PyPI exposes only the `0.0.1`
  identity marker.
- Do not describe the demo as tracking-free while it requires analytics
  acceptance.

## 5. Channel Sequence

Run one flagship launch at a time so the maker can answer every substantive
question.

### Wave A — Owned and proven channels

1. Publish the GitHub Release body and enable Discussions.
2. Publish a personal LinkedIn founder post with the short demo.
3. Follow with a five-part LinkedIn carousel or thread, one differentiator per
   part.
4. Publish the same factual update on the maker's existing X and Bluesky
   accounts when those accounts have real history.

LinkedIn goes first because the maker already has an audience there and can use
the post to seed direct product feedback before the flagship community launch.

### Wave B — Show HN

Use a direct product or repository URL and make the maker available for at least
six hours after submission.

HN's current rules require something people can try, prefer no signup or email
barrier, prohibit vote solicitation, and say not to post generated or
AI-edited text. Therefore this repository contains a **founder writing brief**,
not final HN copy. The owner must write the title, submission text, and every
reply personally.

Suggested factual spine:

- The maker built JobCtrl after rejecting the choice between loose scripts and
  opaque hosted auto-apply tools.
- It runs locally and has a real web control plane over durable workflows.
- Every fit score exposes requirement evidence.
- Every tailored resume bullet traces to the user's profile; resumes and cover
  letters both pass fabrication checks.
- Dry runs cannot submit; live submission is approval-gated by default.
- The public demo starts with synthetic browser-local data, causes no external
  product action, and should not receive personal data or secrets.
- The sharpest technical trade-off was using Temporal and at-most-once
  submission semantics in a single-user local application.
- Ask for criticism of setup friction, trust communication, and whether the
  evidence surfaces are actually useful.

Possible title concepts for the owner to rewrite:

- `Show HN: JobCtrl – a local-first, auditable job-search control plane`
- `Show HN: I built a local job-search app that shows its evidence`

Do not coordinate votes, ask friends to comment, repost a weak submission, or
publish generated replies.

### Wave C — Reddit

Recheck each community's live rules immediately before posting.

| Community | Decision | Current constraint |
| --- | --- | --- |
| `r/opensource` | Candidate after genuine participation | Promotional flair is required; excessive self-promotion is disallowed; its rules ban AI-generated content. Owner writes the post personally and stays to discuss it. |
| `r/selfhosted` | Use the current New Project Megathread until JobCtrl is at least three months old | Newer projects are restricted to that megathread; production readiness and documentation are required. Recheck the project-age rule on posting day. |
| `r/SideProject` | Secondary test | No community-specific rule was exposed on 2026-07-26, but site-wide spam rules still apply. Use a detailed self-post and disclose maker status. |
| `r/jobsearchhacks` | Do not post | Its rules prohibit advertising products, apps, sites, and sneaky plugs. |

Reddit post structure for the owner to write:

1. Disclose `I built this`.
2. Explain the concrete problem and why existing approaches felt unsafe or
   uninspectable.
3. Show one workflow with a screenshot or short clip.
4. State supported platform and external-service boundaries plainly.
5. Link once, at the end, only where the community permits it.
6. Ask one specific product question.

The removed first Reddit post is not a reason to repost unchanged. Identify its
subreddit, removal reason, post format, account history, and whether it violated
a new-project, self-promotion, flair, or link-post rule before another attempt.

### Wave D — Product Hunt and durable directories

Create the Product Hunt draft only after the maker's personal account is more
than one week old. Current submission requirements call for a direct product
URL, short tagline, a 260-character description, a 240×240 thumbnail, and at
least two gallery assets; YouTube is the supported video path.

Draft fields:

- **Name:** JobCtrl
- **Tagline:** Run your job search. Keep your data.
- **Description:** Open-source, local-first job-search mission control. Discover
  roles, score fit with evidence, tailor truthful materials, rehearse with dry
  runs, and keep live submission approval-gated by default.
- **Topics:** Open Source, Productivity, Artificial Intelligence
- **Pricing:** Free
- **Primary URL:** `https://jobctrl.dev`

Gallery sequence:

1. Outcome-led social card.
2. Dashboard and durable pipeline.
3. Requirement-level fit evidence.
4. Apply Review with truthful-material audit.
5. Data and submission boundary.

AlternativeTo is a durable search surface. Its current rules require a
one-week-old account before suggesting a new application. Submit JobCtrl as
open-source macOS software and propose only defensible alternatives backed by
the comparison page.

### Wave E — Technical authority

Publish one deep technical artifact each week:

1. **At-most-once browser submission in a crash-resumable local workflow**
2. **Why AI-generated resume claims need provenance, not another reviewer
   prompt**
3. **Using Temporal for a single-user local application**
4. **Designing a public demo that cannot touch the real product backend**

Each article must teach the engineering problem independently. JobCtrl is the
worked example and the final call to action, not the entire premise.

Candidate destinations: the project docs, DEV Community, Hashnode, the Temporal
community, Lobsters when the maker has a legitimate account, and relevant
local-first communities after contributing to their discussions.

## 6. Ready-to-Adapt Owned-Channel Copy

The owner should personalize these drafts with the real motivation and any
first-user evidence. Do not reuse this text on HN or communities that prohibit
generated content.

### LinkedIn launch draft

> I built JobCtrl because I did not want to choose between a pile of job-search
> scripts and a black box that applies on my behalf.
>
> JobCtrl is open source and runs locally. It discovers roles, scores each
> requirement against evidence in your real profile, gives tailored resume
> bullets traceable provenance, checks resumes and cover letters for fabricated
> facts, and keeps live applications behind your approval by default.
>
> The part I care about most is not “AI automation.” It is being able to inspect
> why a job scored well, where a resume claim came from, what will be submitted,
> and what happens after an interruption.
>
> There is now a synthetic live demo and a signed Apple-silicon macOS install.
> I would especially value blunt feedback on setup friction and whether the
> evidence trail earns your trust.
>
> Demo: https://demo.jobctrl.dev
> Source and install: https://github.com/ebarti/JobCtrl

### Short social post

> Job search automation should not require surrendering your career data or
> trusting an unexplained score.
>
> JobCtrl is open source and local-first: discover jobs, inspect requirement
> evidence, tailor truthful materials, and approve before live submission.
>
> Live synthetic demo: https://demo.jobctrl.dev
> Source: https://github.com/ebarti/JobCtrl

### GitHub Release body draft

> JobCtrl `v2.0.7` is the first stable public release.
>
> It provides one signed Apple-silicon macOS install for the local web app,
> TypeScript API, Python automation worker, Temporal workflows, PDF tooling, and
> managed browser runtime.
>
> **Try it first:** https://demo.jobctrl.dev starts with synthetic browser-local
> data and cannot contact employers, providers, Gmail, job boards, or a local
> JobCtrl installation. Do not enter personal data or secrets.
>
> **Install**
>
> ```bash
> curl -fsSL https://jobctrl.dev/install.sh | sh
> # or
> brew install ebarti/tap/jobctrl
> ```
>
> Then run:
>
> ```bash
> jobctrl start
> jobctrl setup
> jobctrl doctor
> ```
>
> This public acquisition path supports Apple-silicon Macs running macOS 15 or
> newer. Native Windows and Intel macOS are not supported public install paths.
> Review the getting-started and data-boundary documentation before connecting
> providers or enabling application capabilities.

## 7. Demo Video Storyboard

Target length: 75 seconds. Use only the public synthetic demo or a reproducible
synthetic QA workspace.

| Time | Visual | Narration point |
| --- | --- | --- |
| 0–7s | Dashboard and local-data statement | The whole job-search pipeline in one local workspace |
| 7–18s | Discovery target and incoming jobs | Find and deduplicate roles from configured sources |
| 18–32s | Job Detail requirement evidence | See why a role fits, requirement by requirement |
| 32–47s | Apply Review and provenance | Tailor a resume without inventing experience |
| 47–60s | Dry-run evidence and approval | Rehearse safely; approve the exact reviewed application |
| 60–70s | Run history after a simulated interruption | Durable workflows preserve progress and avoid duplicates |
| 70–75s | Demo, install, repository | Try it, install it, or inspect every line |

Do not show real names, employers, resumes, credentials, local paths, browser
profiles, logs, databases, or provider responses.

## 8. Measurement

Append UTM parameters to campaign-owned links:

```text
utm_campaign=jobctrl_public_launch
utm_source=<linkedin|hackernews|reddit|producthunt|devto|bluesky|x>
utm_medium=<social|community|referral|article>
utm_content=<founder_story|demo_video|architecture_article|release>
```

Capture a weekly snapshot:

- GitHub unique views and top referrers;
- external stars, forks, watchers, issues, discussions, and contributors;
- release asset downloads by asset name;
- landing-to-demo clicks;
- consent accepted and declined counts;
- demo initialization and key synthetic workflow completions;
- voluntarily confirmed installs and first-run failures;
- support questions grouped by setup, trust, platform, provider, and product
  value.

Analytics from an acceptance-required demo is selection-biased. Report it as
**consented demo behavior**, not overall visitor behavior. Keep clone counts out
of campaign reporting unless their source becomes attributable.

After each launch wave, record:

1. exact URL and publication time;
2. channel rule snapshot;
3. visits, demo starts, downloads, stars, and feedback after 1h, 24h, and 7d;
4. the three strongest questions or objections;
5. one conversion change and one content change for the next wave.

## 9. Stop Rules

Pause the campaign when:

- the public install path fails;
- a privacy, credential, application-submission, or data-integrity concern is
  credible and unresolved;
- the maker cannot remain present for the flagship thread;
- a post is removed and its rule violation is not yet understood;
- campaign replies require exposing user data or making an unverified product
  claim;
- a channel begins producing low-quality traffic without installs, feedback, or
  retained discussion.

Fix the trust or product problem before increasing traffic again.
