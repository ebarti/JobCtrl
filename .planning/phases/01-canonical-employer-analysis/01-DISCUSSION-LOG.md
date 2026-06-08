# Phase 1: Canonical Employer Analysis - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-08
**Phase:** 1-Canonical Employer Analysis
**Areas discussed:** Provider & model, Budget & effort, Lifecycle & reproducibility, Content & evidence

---

## Pre-discussion correction — the "180s timeout"

The user challenged a "180s timeout" mentioned at the plan gate. Traced to source: it is a real, pre-existing constant — `workers/automation/src/jobhunter/llm.py:119` `_TIMEOUT = 180`, applied as `httpx.Client(timeout=180)`, retries 5× then hard-fails. Not introduced by the plan. The user directed: **no wall-clock deadline; cancellation is the control.** Later superseded entirely for new AI by the agent-SDK directive (that transport isn't used).

---

## Provider & model strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: Claude for analysis | Anthropic Messages adapter for analysis, keep Gemini elsewhere | |
| Full Claude default | Latest Claude as pipeline default everywhere | |
| Portable only (no Anthropic dep) | Stay on Gemini-compat + JSON-Schema + validator re-ask | |
| **Other (user freeform)** | **All AI via agent SDKs — Claude Agent SDK, Codex SDK, Antigravity SDK** | ✓ |

**User's choice:** Freeform — "All AI usage must be made through agent SDKs - Claude Agent SDK, Codex SDK and Antigravity sdk." Then: use **all 3** and **mix** them for better data; new usage only (leave existing out-of-scope usages untouched).
**Notes:** Auth — Claude Code session (now), Antigravity via `GOOGLE_APPLICATION_CREDENTIALS`, Codex via existing subscription. Supersedes the research's httpx-based recommendations and PROJECT.md's LLM constraint.

## Budget & effort

**User's choice (freeform):** "I do not care about how much we consume. I need QUALITY."
**Notes:** Max effort / top model per SDK; no token/turn ceiling; no wall-clock deadline; cooperative cancellation only.

## Ensemble — how to mix the 3 outputs

| Option | Description | Selected |
|--------|-------------|----------|
| Merge + synthesize | Parallel run → agreement + span validation → synthesizer reconciliation | ✓ |
| Synthesizer only | All drafts → one reconciler emits final | |
| Deterministic merge only | Union + ≥2 voting, no extra LLM pass | |

**User's choice:** Merge + synthesize.

## Audit trail — what gets persisted

| Option | Description | Selected |
|--------|-------------|----------|
| Persist all 3 + reconciled final | Each SDK sub-analysis + agreement/confidence + canonical final | ✓ |
| Final only | Just the reconciled analysis | |

**User's choice:** Persist all 3 + reconciled final.

## Trigger — when analysis can run

| Option | Description | Selected |
|--------|-------------|----------|
| Both: auto + standalone | `_run_analyze` sub-step of tailor AND standalone `analyze_job` RPC | ✓ |
| Auto sub-step only | Only the front half of tailor | |

**User's choice:** Both (standalone inspector UI deferred to Phase 5).

## Reproducibility + cache key

| Option | Description | Selected |
|--------|-------------|----------|
| Snapshot + version key | snapshot hash + prompt/SDK-set version; recompute on change/bump/force | ✓ |
| Snapshot-hash only | Strict ANALYSIS-06; prompt change won't auto-refresh | |

**User's choice:** Snapshot + version key. Cache is the reproducibility contract (3-way ensemble can't be byte-identical).

## Content — requirement weighting

| Option | Description | Selected |
|--------|-------------|----------|
| Tier + numeric weight | must/nice classification AND 0–1 priority weight | ✓ |
| Tiers only | must/nice (optional ordinal) | |
| Numeric weight only | single 0–1 importance, derive tier | |

**User's choice:** Tier + numeric weight.

## Content — evidence span storage

| Option | Description | Selected |
|--------|-------------|----------|
| Quoted text canonical, offsets derived | verbatim JD quote is source of truth; offsets computed for highlighting | ✓ |
| Quoted text + persisted offsets | store both at generation time | |
| Quoted text only | verbatim substring, no offsets | |

**User's choice:** Quoted text canonical, offsets derived.

## Content — analysis depth

| Option | Description | Selected |
|--------|-------------|----------|
| Rich ideal-candidate | role framing + must/nice w/ priority + keywords w/ evidence + inferred seniority + narrative | ✓ |
| Core | role summary + requirements + keywords only | |

**User's choice:** Rich ideal-candidate.

## Content — keyword → requirement link

| Option | Description | Selected |
|--------|-------------|----------|
| Link keyword → requirement | each keyword carries requirement_ref; orphans flagged | ✓ |
| Independent keyword list | keywords stand alone | |

**User's choice:** Link keyword → requirement.

---

## Claude's Discretion

- Structured-output mechanism per SDK; which SDK synthesizes; Pydantic/table/projection/event shapes; agreement-scoring method.

## Deferred Ideas

- Migrate existing LLM stages to agent SDKs (future, not this phase).
- Standalone analysis inspector UI (Phase 5).
- Update PROJECT.md to retire the superseded LLM constraint.
- Lightweight eval strategy to be defined in the AI-SPEC despite the milestone-level eval-harness deferral.
