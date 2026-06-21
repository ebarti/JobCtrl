# Phase 21: Jobs Triage UX & Warning-Only Floor - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 21-Jobs Triage UX & Warning-Only Floor
**Areas discussed:** Jobs list compensation scan, Drawer compensation audit layout, Warning-only profile floor

---

## Jobs List Compensation Scan

| Option | Description | Selected |
|--------|-------------|----------|
| Compact column | Add one Compensation column with posted range, market state/confidence, and warning count. | |
| Title subline | Put compensation under the job title, reducing columns but making rows denser. | |
| Separate columns | Use separate Posted, Market, and Warnings columns; easier to compare but wider. | x |

**User's choice:** Separate `Posted`, `Market`, and `Warnings` columns.
**Notes:** The list should favor scan/comparison. When both posted and market data exist, posted salary is the primary employer claim and market estimate is comparison context.

| Option | Description | Selected |
|--------|-------------|----------|
| Posted first | Show posted salary as the concrete employer claim, then market estimate as comparison context. | x |
| Market first | Lead with benchmark estimate and treat posted salary as supporting evidence. | |
| Warnings first | Lead with warning count/state so risky rows stand out before amounts. | |

**User's choice:** Posted first.
**Notes:** Warning count remains visible but does not lead the row when a posted salary exists.

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit muted labels | Show labels like no posted salary, insufficient evidence, or source unavailable. | |
| Minimal dash | Use a compact dash or not recorded label to keep rows shorter. | x |
| Warning only | Only call out missing data when it creates a warning; otherwise keep the row quiet. | |

**User's choice:** Minimal dash.
**Notes:** Context preserves that this is row-level visual compactness only; the drawer must still explain missing and unsupported states.

| Option | Description | Selected |
|--------|-------------|----------|
| Collapse to one | Keep separate desktop columns, collapse to a compact compensation summary on narrow screens. | |
| Horizontal scroll | Keep all separate columns visible in the table and rely on table scrolling. | x |
| Hide details | Show only warning count in the row and rely on the drawer for posted/market detail. | |

**User's choice:** Horizontal scroll.
**Notes:** Keep the three compensation columns structurally stable across viewport widths.

---

## Drawer Compensation Audit Layout

| Option | Description | Selected |
|--------|-------------|----------|
| After audit triage | Place it directly after Why this job is here, before description and actions. | x |
| Inside audit triage | Fold compensation into the existing ranking/apply concerns block. | |
| After description | Keep the job post first, then show compensation audit before diagnostics. | |

**User's choice:** After audit triage.
**Notes:** Compensation is related to audit triage but should not be folded into apply concerns.

| Option | Description | Selected |
|--------|-------------|----------|
| Summary plus evidence | Top row shows posted/market/floor summary; below it lists sources, assumptions, and warnings. | x |
| Dense evidence table | Use a table-like source/factor list first, optimized for auditing over scanning. | |
| Narrative panel | Use short prose explaining what the compensation evidence means for this job. | |

**User's choice:** Summary plus evidence.
**Notes:** The drawer should be inspectable but still scannable.

| Option | Description | Selected |
|--------|-------------|----------|
| Key detail visible | Show source labels, freshness, confidence band, warning names, and assumptions without extra clicks. | |
| Progressive disclosure | Show summary by default and put factor/source detail under expandable rows. | x |
| Full audit visible | Show every factor, reason, source snapshot, and warning in the main section by default. | |

**User's choice:** Progressive disclosure.
**Notes:** The main section should not be crowded; source/factor details can expand.

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit reasons | Explain no posted salary, insufficient evidence, source unavailable, and unsupported states with reason labels. | x |
| Short state labels | Show compact state names only, relying on source/factor disclosure for details. | |
| Only warnings | Show explanations only when the state creates a warning or conflict. | |

**User's choice:** Explicit reasons.
**Notes:** Drawer state explanations compensate for compact table cells.

---

## Warning-Only Profile Floor

| Option | Description | Selected |
|--------|-------------|----------|
| Profile minimum | Use the existing profile compensation minimum when present; otherwise show no floor comparison. | x |
| Free-text expectation | Try to interpret the profile salary expectation text when no numeric minimum exists. | |
| No profile floor | Do not compare against the profile in Phase 21; only show posted and market evidence. | |

**User's choice:** Keep floor comparison using profile numeric minimum.
**Notes:** The user initially selected no profile floor, which conflicted with UI-03/UI-04. On scope-resolution, they chose to keep floor comparison in Phase 21.

| Option | Description | Selected |
|--------|-------------|----------|
| Show each basis | State whether posted, market, both, or neither was used; do not collapse them. | x |
| Use strongest evidence | Pick posted salary first, then market if posted is missing or unusable. | |
| Use lowest available | Warn against the lowest available compensation range as the conservative floor check. | |

**User's choice:** Show each basis.
**Notes:** The UI must expose whether posted salary, market estimate, both, or neither drove the comparison.

| Option | Description | Selected |
|--------|-------------|----------|
| Compensation only | Include in compensation warnings/list count and drawer section, never Apply concerns/readiness/blockers. | x |
| Also apply concerns | Show as an apply concern while still not blocking readiness or dispatch. | |
| Drawer only | Keep floor warnings out of the list warning count; show them only in drawer details. | |

**User's choice:** Compensation only.
**Notes:** Floor warnings can count as compensation warnings but must never become apply concerns, readiness, blockers, scoring, ranking, filtering, or dispatch gates.

| Option | Description | Selected |
|--------|-------------|----------|
| Not configured | Show a muted not configured state in the drawer; keep the list warning count unchanged. | x |
| Hide entirely | Do not render a floor row or label unless a numeric floor exists. | |
| Prompt settings | Show a small link or action directing the user to Preferences to configure compensation. | |

**User's choice:** Not configured.
**Notes:** Missing profile floor should be visible in the drawer but not create a row warning.

## the agent's Discretion

- Component names, microcopy, class names, and exact visual treatment.
- The progressive-disclosure primitive for drawer source/factor detail.
- Exact warning label ordering, provided basis and no-gating semantics stay clear.

## Deferred Ideas

- None.
