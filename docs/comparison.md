---
pageClass: jh-user-guide-page
---

# How JobCtl Compares

This page compares JobCtl's **approach** to common job-search-tool
capabilities against other approaches, one neutral capability category at a time.

::: warning Scaffold — alternative columns are not yet published
This is the comparison **structure and rules only**. It deliberately names **no
external product or company**. The "Alternative approach" columns are
placeholders for the maintainer to fill, privately and one at a time, only after
verifying each fact against that approach's own public documentation (see
[How this page is maintained](#how-this-page-is-maintained)). Until a cell is
verified it stays a `TODO(owner)` placeholder rather than a speculative claim.
:::

The **JobCtl** column states only shipped, `Current` behavior; each cell cites
the claim-ledger IDs (`CL-0xx`) that back it. Those IDs are governed in the
repository-only claims ledger (`docs/claims-ledger.md`), and each maps to a
user-facing page linked from the capability category on the left.

## Capability comparison

| Capability category | JobCtl | Alternative approach A | Alternative approach B |
| --- | --- | --- | --- |
| **Data ownership** — where your profile, jobs, and materials live | Local-first: one SQLite database and generated files under your home directory; no hosted backend and no account (`CL-060`, `CL-061`). Data at rest is not encrypted — protection is your OS account (`CL-066`). See [Data, Privacy & Safety](user/data-and-safety.md). | `TODO(owner)` | `TODO(owner)` |
| **Outbound data** — what leaves your machine, and when | Nothing leaves by default; each egress path (LLM, apply-agent prompt, job boards, read-only Gmail, Maps, CAPTCHA, telemetry) is opt-in and configuration-gated (`CL-061`, `CL-062`, `CL-065`). See [Security → What Leaves Your Machine](user/security.md#what-leaves-your-machine). | `TODO(owner)` | `TODO(owner)` |
| **Scoring transparency** — how fit is decided and explained | A deterministic, versioned policy scores fit 1–10 from structured evidence, with a per-requirement ledger explaining each score; scoring is an applicant-side triage aid, not a hiring decision (`CL-010`, `CL-011`, `CL-012`). See [Scoring](architecture/scoring.md). | `TODO(owner)` | `TODO(owner)` |
| **Materials integrity** — how tailored resumes stay truthful | Every bullet traces to its source evidence; deterministic fabrication gates block invented facts and fail closed; keyword coverage is computed against the actual rendered resume text (`CL-020`, `CL-021`, `CL-022`). See [Tailoring Contract](architecture/tailoring.md). | `TODO(owner)` | `TODO(owner)` |
| **Apply supervision** — what stands between a job and a submission | Live submission requires an explicit approval bound to the reviewed materials, profile, and URL plus matching dry-run evidence, enforced in the worker claim transaction; dry runs submit nothing (browser-level guard); no application is submitted twice (`CL-030`, `CL-031`, `CL-033`, `CL-034`). See [Security → Approval And Control Gates](user/security.md#approval-and-control-gates). | `TODO(owner)` | `TODO(owner)` |
| **Third-party boundaries** — what the tool refuses to do | Never submits, runs destructive actions, or bypasses CAPTCHA / paywall / login / rate-limit / bot controls without explicit authorization; the apply agent stops on SSO, declines permission prompts, and never enters payment details (`CL-035`). See [Security → No Third-Party Bypass](user/security.md#no-third-party-bypass). | `TODO(owner)` | `TODO(owner)` |
| **Reliability** — how long-running work survives crashes | Every stage runs as a durable Temporal workflow with heartbeats and classified retries; the Runs page shows every run with a deep link into the workflow engine (`CL-050`, `CL-051`). See [Runtime Boundaries](architecture/runtime.md). | `TODO(owner)` | `TODO(owner)` |
| **Cost control** — how automated LLM spend is bounded | A configurable daily spend ceiling runs a budget preflight before each spendful workflow and stops it at the ceiling; today's estimated spend is visible on the health surface (`CL-040`, `CL-041`). It is an estimate, not the provider bill. See [Configuration → LLM spend](user/configuration.md). | `TODO(owner)` | `TODO(owner)` |

## How this page is maintained

This comparison rots unless it is re-verified. Two rules keep it honest:

- **Facts-verified-before-publish.** No comparative cell about an external
  approach is published without (a) a recorded verification date and (b) a dated
  link to that approach's **own public documentation** (README, docs site, or
  official page). No cell asserts a claim from memory, marketing copy, or a
  third-party summary. Every JobCtl-column cell cites a frozen `Current`
  claim-ledger row. Any alternative cell that is not yet verified stays a
  `TODO(owner)` placeholder (or an HTML-commented draft) — never a speculative
  claim.
- **No disparagement.** Alternative entries are neutral, factual descriptions of
  a published approach, with the source and check date recorded. No unverifiable
  or comparative-superlative claims.

**Maintenance cadence.** Re-verify every JobCtl-column cell against the claims
ledger, and every published alternative cell against its cited source, on each
release and at minimum **quarterly**. `TODO(owner)`: confirm the interval and
the sidebar label/placement (plan §11.3). Record the last full re-verification
date here at publish time: **last verified: `TODO(owner)`**.

When you add or change an alternative column, record its entries in this format
inside the cell so the check date travels with the claim:

```text
<neutral factual statement> (source: <url>, verified <YYYY-MM-DD>)
```
