# Feature Research

**Domain:** Grounded, inspectable AI resume tailoring (resume-only this milestone)
**Researched:** 2026-06-08
**Confidence:** MEDIUM

> **Confidence note:** Live web search and the gsd-tools research seams were unavailable in this
> environment (Vertex web_search policy block + missing `gsd-tools` binary). Findings are grounded in
> (a) the milestone scope in `.planning/PROJECT.md`, (b) the auditability discipline and tech-debt in
> `.planning/codebase/CONCERNS.md` and `CLAUDE.md`, and (c) the assistant's training knowledge of the
> AI resume-tailoring product category (Teal, Jobscan, Rezi, Kickresume, Enhancv, Huntr, Careerflow,
> Careerflow/Simplify, plus ChatGPT/Claude-driven manual workflows) as of the Jan 2026 cutoff. Where a
> claim leans on category knowledge rather than the repo, it is tagged. Treat competitor specifics as
> directional, not authoritative.

## Feature Landscape

This milestone's five themes map to the table below:
- **A — Job/employer analysis ("ideal candidate")**
- **B — Per-bullet provenance (evidence × requirement × transform × rationale)**
- **C — Granular tailoring controls (rephrase / invent / never-fabricate)**
- **D — Human-authentic voice ("not AI-sounding")**
- **E — Inspector UI**

### Table Stakes (Users Expect These)

Without these the feature is not credibly "grounded tailoring." Most are present in mainstream tools
in *some* form; the differentiation is in doing them grounded + inspectable, not in having them.

| Feature | Theme | Why Expected | Complexity | Notes |
|---------|-------|--------------|------------|-------|
| Structured requirement extraction from the JD (must-have vs nice-to-have, responsibilities, qualifications) | A | Every serious tool parses the JD into discrete requirements; users assume the tool "read the job" | MEDIUM | Replaces today's flakey extraction. Must be reasoned + reproducible per PROJECT.md, not regex/keyword scrape |
| Reasoned keyword set tied to JD evidence | A | Jobscan-class ATS keyword matching is the category's anchor expectation; "keywords" with no source feel arbitrary | MEDIUM | Each keyword must cite the JD span/requirement it came from. Cures the "random extraction" root cause |
| Keyword coverage computed against the *actual generated resume text* | A,B | Users expect "you covered X of Y keywords"; CLAUDE.md forbids inferring coverage from the JD alone | MEDIUM | Already a hard repo invariant — covered/missing lists must be computed at generation time, never suppressed |
| Bullet-level rewrite anchored to a real profile fact | B | The whole premise of "tailoring" is reshaping *your* experience to the role | MEDIUM | Each output bullet must resolve to a canonical profile evidence item |
| Bullet-level link to the JD requirement it serves | B | Users want to know "why is this bullet here / what does it answer" | MEDIUM | The requirement↔bullet edge is half of "grounded" |
| Never-fabricate guardrail (no invented metrics, titles, dates, employers) | C | This is the trust floor; fabrication is the category's defining failure mode | MEDIUM | Must be a recorded *rule that produced the bullet*, not just a prompt hope. See Anti-Features |
| Side-by-side / diff view (original profile bullet → tailored bullet) | B,E | Users expect to see what changed before trusting it | MEDIUM | Diff is the cheapest, highest-trust inspection primitive |
| Editable output (user can override any bullet) | E | Generated text is a draft; users always edit | LOW–MED | Edits must not destroy provenance/audit trail of the generated version |
| Preserve the last accepted artifact across re-tailor/retry | B,E | A failed refresh must never wipe the current reviewable resume | LOW | Direct CLAUDE.md mandate; mostly a state-machine/audit requirement |
| PDF + previewable rendering of the tailored resume | — | Output must be a usable artifact, not just JSON | LOW | Already exists (LaTeX + Playwright HTML paths) |
| Per-job invocation from the product surface | E | Users expect to trigger tailoring on a job they're looking at | MEDIUM | Currently *broken* — `generate-materials` returns 400 / button disabled / E2E fixme'd (CONCERNS.md). Wiring this is a prerequisite for the inspector UI to be reachable |
| Honest "covered vs not covered" + gap surfacing | A,B,E | Users need to see which requirements they *don't* satisfy, not a falsely complete picture | MEDIUM | Surfacing gaps (without fabricating to fill them) is itself a trust signal |
| Basic de-buzzwording / readable prose | D | Output that "reeks like AI" is the most common user complaint | MEDIUM | Table stakes to *attempt*; doing it measurably well is a differentiator |

### Differentiators (Competitive Advantage)

This is where JobHunter wins. The category baseline is "keyword match + rewrite"; almost no
mainstream tool exposes *why* each line exists or governs *how aggressively* it may transform. The
inspectability-first posture is the moat.

| Feature | Theme | Value Proposition | Complexity | Notes |
|---------|-------|-------------------|------------|-------|
| Persisted, inspectable "ideal candidate" profile from the employer's POV | A | Goes beyond keyword lists to "what is this employer actually hiring for, and why" — the reasoning users can't get from Jobscan-style scores | HIGH | The upstream root-cause fix. Drives all downstream tailoring; must be a canonical DB artifact, not a transient prompt |
| Must-have vs nice-to-have *with priority/weighting* | A | Lets tailoring (and the user) spend resume real estate on what matters most | MEDIUM | Enables prioritized bullet ordering and honest gap triage |
| Full per-bullet provenance card: evidence × requirement × transform-type × human rationale | B,E | "Chose this because…, worded it like this because…" — no mainstream tool exposes this. This *is* the flagship | HIGH | The richest, most defensible feature. Provenance must be computed at generation time against real text |
| Transform-type taxonomy recorded per bullet (verbatim / rephrase / reframe / synthesize-from-related / quantify-from-evidence) | B,C | Makes the *kind* of edit legible, so the user can audit aggressiveness line by line | MEDIUM | The vocabulary that makes controls and provenance coherent together |
| Granular tailoring-control model with the governing rule recorded *per decision* | C,B | User sets policy (e.g. "rephrase always; invent only for closely-related experience; never fabricate metrics") and sees which rule produced each bullet | HIGH | The control model + per-decision attribution is a genuine differentiator; ties C and B together |
| Voice/authenticity controls + recorded voice transforms | D | Targets "not AI-sounding" as a first-class, inspectable goal (vary structure, kill buzzwords, match user register) | MEDIUM–HIGH | Differentiator only if the *result* is convincing; otherwise it's a checkbox |
| Inspector UI that exposes analysis + provenance + policy in-app | E | Trust requires *seeing* the reasoning where you work, not a hidden audit log | HIGH | Wired through existing contracts/projection/read-model/frontend boundaries; no UI masking of missing audit data |
| Re-tailor with policy delta visible (what changed and why between attempts) | C,E | Lets users iterate on controls and understand the effect, with history preserved | MEDIUM | Builds on retailor_* RPCs already present |
| Requirement-coverage map (which requirements each bullet answers, which are unaddressed) | A,B,E | A two-way ledger: every requirement → bullets that serve it; every bullet → its requirement | MEDIUM | Strongest "honest gaps" surface; depends on A + B edges |
| Evidence-strength signaling (strong direct match vs stretch vs absent) | B,C | Helps the user judge when a bullet is a reach vs a solid claim — and decide whether to keep it | MEDIUM | Pairs with controls: a "stretch" is exactly where invent-vs-rephrase policy matters |

### Anti-Features (Commonly Requested, Often Problematic)

These are the category's traps. Several directly contradict the project's auditability discipline.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Auto-invent metrics / quantify achievements the user never stated ("Increased X by 30%") | "Quantified bullets score better / pass ATS" | Fabrication = the category's cardinal failure; destroys trust, risks the user in interviews/background checks; violates never-fabricate | Quantify *only* from recorded evidence; otherwise prompt the user to supply the number, and mark the bullet as un-quantified |
| Keyword stuffing to maximize an ATS match score | "Higher match % = more callbacks" | Produces incoherent, robotic, human-rejected resumes; gameable score becomes the goal instead of fit | Reasoned keyword integration where the evidence supports it; surface coverage honestly including misses |
| A single headline "ATS score" / match percentage as the primary output | Users (and competitors like Jobscan) anchor on one number | A scalar hides the reasoning, invites gaming, and contradicts inspectability-first; users optimize the number not the resume | Lead with the requirement-coverage map + provenance; if a score exists, make it derived and inspectable, never the headline |
| Fully automated "apply to 100 jobs" mass tailoring with no review | "Save me time" | Removes the human-in-the-loop that grounding exists to serve; mass low-quality output; reputational risk | Keep tailoring review-first; per-job, inspectable, human-approved (apply automation stays separate + opt-in, per repo safety rules) |
| Inferring keyword/coverage status from the JD instead of the generated text | "Faster / cheaper than re-reading output" | Explicitly forbidden by CLAUDE.md; produces fake audit data; the exact root-cause being fixed | Always compute coverage against the actual generated resume text at generation time |
| Hiding/suppressing the missing-keyword or unmet-requirement list | "Looks more complete / less discouraging" | Masks the truth the inspector exists to show; CLAUDE.md forbids suppressing the missing list | Show misses plainly; that honesty is a feature, not a defect |
| Generic LLM "make it professional" rewrite with no profile grounding | Easy to ship; what naive ChatGPT workflows do | Produces interchangeable, buzzword-laden, ungrounded prose — the "reeks like AI" smell | Grounded, evidence-anchored rewriting with recorded transform + voice rules |
| Persona/judge *summary* shown without the underlying prompt/rubric/response | "Cleaner UI" | CLAUDE.md: a shown score/pass-fail must make prompt, rubric, response, blockers, warnings inspectable when data exists | Expose the judge audit trail behind the summary |
| Synthesized artifact rows from sibling files presented as real DB-backed artifacts | "Show the PDF that's on disk" | Overstates provenance; indistinguishable from canonical artifacts (existing CONCERNS.md debt) | Only surface DB-backed artifacts, or mark synthesized entries with explicit provenance |
| Cover-letter tailoring in this milestone | Natural adjacency | Explicitly out of scope; scope creep risks the resume flagship | Defer; the shared employer analysis lets cover letters adopt it later |
| Formal eval/golden-fixture scoring harness this milestone | It's the most direct cure for "inconsistent quality" | Explicitly deferred by choice; large surface; would swamp the milestone | Lean on existing persona/judge gate now; harness is the planned next milestone |

## Feature Dependencies

```
[A1 Structured JD requirement extraction]
    └──requires──> (replaces) flakey keyword extraction
        └──enables──> [A2 Must-have vs nice-to-have + priority/weighting]
        └──enables──> [A3 Reasoned keywords tied to JD evidence]
        └──persisted-as──> [A4 Inspectable "ideal candidate" artifact]
                              └──drives──> all of B and C

[B1 Bullet → profile-evidence link]
[B2 Bullet → JD-requirement link]  (B2 requires A1/A2)
    └──together-form──> [B3 Per-bullet provenance card]
        └──requires──> [B4 Transform-type taxonomy]
        └──requires──> [C1 Tailoring-control model]   (rule recorded per decision)
        └──computed-against──> [A3 keyword coverage on actual generated text]

[C1 Granular control model]
    └──requires──> [B4 Transform-type taxonomy]   (controls govern transform types)
    └──recorded-per-decision──> [B3 provenance]
    └──enhanced-by──> [B-strength evidence-strength signaling]

[D Voice/authenticity transforms]
    └──recorded-in──> [B3 provenance]   (voice edits are a transform class)

[E Inspector UI]
    └──requires──> A4, B3, C1 persisted as canonical, projected read-model data
    └──requires──> per-job generate-materials wiring (currently broken)
    └──requires──> contracts + projection + frontend invalidation handler coverage

[Requirement-coverage map] ──requires──> A2 + B2 edges
[Re-tailor policy-delta view] ──requires──> C1 + preserved artifact history
```

### Dependency Notes

- **A is the keystone.** Pillars B, C, D, and E all consume the persisted employer analysis. A
  must land (and be inspectable/canonical) before B/C provenance is meaningful. This argues for a
  phase ordering of A → B+C → D/voice → E (with E's plumbing partly parallelizable).
- **B requires A.** A bullet can't cite "the requirement it serves" until requirements are
  extracted and prioritized (A1/A2). The B2 edge is gated on A.
- **C requires the transform taxonomy (B4).** Controls govern *transform types*; without a shared
  vocabulary, "rephrase vs invent vs never-fabricate" has nothing to attach to. B4 is the seam
  between B (provenance) and C (controls).
- **Provenance + coverage must be computed at generation time** against the real generated text —
  this is both a CLAUDE.md invariant and a data-flow constraint (you cannot back-fill honest
  provenance later).
- **E depends on canonical persistence of A4/B3/C1**, plus fixing the currently-broken per-job
  generate-materials path (CONCERNS.md: route 400s, button disabled, E2E fixme'd). The inspector is
  unreachable from the product surface until that vertical slice is wired.
- **E depends on cross-cutting contract + projection + frontend-invalidation coverage** — new data
  shapes touch `packages/contracts`, the API read-model/projections, Python materials domain +
  projections, and the web materials/apply-review contexts, each kept in sync (PROJECT.md, CLAUDE.md
  frontend conventions, every-event-has-handler parity test).
- **Conflict: ATS-score-as-headline conflicts with inspectability-first.** Do not let a scalar
  match score become the primary output; it competes with the provenance/coverage surfaces for the
  user's attention and incentivizes gaming.

## MVP Definition

### Launch With (v1) — this milestone

The minimum that makes "grounded, inspectable tailoring" *true and visible*.

- [ ] **A1 reasoned JD requirement extraction** — replaces the flakey extraction; the root-cause fix
- [ ] **A2 must-have vs nice-to-have + priority** — needed for B2 edges and honest gaps
- [ ] **A3 reasoned keywords tied to JD evidence + coverage computed on generated text** — category table stakes done honestly
- [ ] **A4 persisted, inspectable "ideal candidate" artifact** — the upstream source of truth
- [ ] **B1+B2 per-bullet evidence + requirement links** — the two grounding edges
- [ ] **B3 per-bullet provenance card (evidence × requirement × transform × rationale)** — the flagship
- [ ] **B4 transform-type taxonomy** — vocabulary that makes B3 and C coherent
- [ ] **C1 granular control model with rule recorded per decision** — never-fabricate as a *recorded rule*, plus rephrase/invent levels
- [ ] **D de-buzzword + structural variation as recorded voice transforms** — target "not AI-sounding" directly
- [ ] **E inspector UI** exposing A4 + B3 + C1, wired through contracts/projection/read-model/frontend
- [ ] **Per-job generate-materials wiring** — prerequisite for the inspector to be reachable (currently broken)
- [ ] **Preserve last accepted artifact across re-tailor** — trust + CLAUDE.md mandate
- [ ] **Diff view (original profile bullet → tailored bullet)** — cheapest high-trust inspection primitive

### Add After Validation (v1.x)

- [ ] **Evidence-strength signaling (strong/stretch/absent)** — once provenance edges are trusted, add the confidence layer
- [ ] **Requirement-coverage map (two-way ledger)** — once A2 + B2 edges are solid
- [ ] **Re-tailor policy-delta view** — once the control model and artifact history are stable
- [ ] **Per-section policy overrides** (e.g. stricter rules for the metrics-heavy section) — extends C1 granularity

### Future Consideration (v2+)

- [ ] **Formal eval / golden-fixture quality harness** — explicitly the planned *next* milestone (most direct cure for inconsistent quality)
- [ ] **Cover-letter tailoring on the shared employer analysis** — deferred; analysis is built to be reusable
- [ ] **Voice calibration from the user's own writing samples** — deepen D once the baseline voice work proves out
- [ ] **Multi-resume / template-variant tailoring** — defer until single-path is trusted

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| A1 reasoned JD requirement extraction (replace flakey) | HIGH | MEDIUM | P1 |
| A2 must-have vs nice-to-have + priority | HIGH | MEDIUM | P1 |
| A3 reasoned keywords + coverage on generated text | HIGH | MEDIUM | P1 |
| A4 persisted inspectable "ideal candidate" artifact | HIGH | HIGH | P1 |
| B1/B2 evidence + requirement links | HIGH | MEDIUM | P1 |
| B3 per-bullet provenance card | HIGH | HIGH | P1 |
| B4 transform-type taxonomy | HIGH | MEDIUM | P1 |
| C1 granular controls, rule-per-decision | HIGH | HIGH | P1 |
| D de-buzzword + structural variation (voice) | HIGH | MEDIUM | P1 |
| E inspector UI (analysis + provenance + policy) | HIGH | HIGH | P1 |
| Per-job generate-materials wiring | HIGH | MEDIUM | P1 (unblocks E) |
| Preserve artifact across re-tailor | HIGH | LOW | P1 |
| Diff view | HIGH | MEDIUM | P1 |
| Evidence-strength signaling | MEDIUM | MEDIUM | P2 |
| Requirement-coverage map | MEDIUM | MEDIUM | P2 |
| Re-tailor policy-delta view | MEDIUM | MEDIUM | P2 |
| Per-section policy overrides | MEDIUM | MEDIUM | P3 |
| Eval/golden-fixture harness | HIGH | HIGH | P3 (next milestone) |
| Cover-letter tailoring | MEDIUM | HIGH | P3 (deferred) |

**Priority key:** P1 must-have for this milestone · P2 should-have once core works · P3 future/deferred

## Competitor Feature Analysis

Directional (training-knowledge, not live-verified). The pattern across the category: strong on
keyword matching and rewriting, weak-to-absent on *why each line exists* and on *governed
fabrication boundaries*. That gap is JobHunter's opening.

| Feature | Jobscan-class (ATS scoring) | Teal / Rezi / Kickresume / Enhancv-class (AI builders) | ChatGPT/Claude manual workflow | JobHunter approach |
|---------|------------------------------|---------------------------------------------------------|--------------------------------|--------------------|
| JD understanding | Keyword extraction + match % | Keyword/skill extraction, sometimes summary | Whatever the user prompts | Reasoned, persisted "ideal candidate" with must/nice + priority (A) |
| Keyword grounding | Match score vs JD, not vs your real text | Suggested keywords to insert | Ad hoc | Keywords tied to JD evidence; coverage computed on generated text (A3) |
| Per-bullet rationale | None | Rare; some "suggestions" but no provenance | None (opaque generation) | Full provenance: evidence × requirement × transform × rationale (B3) |
| Fabrication control | N/A | Implicit; often *encourages* quantification | Entirely up to the user | Explicit never-fabricate + rephrase/invent rules recorded per decision (C1) |
| Anti-"AI-sounding" | N/A | Templated phrasing (often itself AI-sounding) | Depends on prompting skill | Recorded voice/de-buzzword transforms as a first-class goal (D) |
| Inspectability | Single score | Mostly opaque generation | Opaque | In-app inspector exposing analysis + provenance + policy (E) |
| Mass auto-apply | No (some adjacents do) | Some (LazyApply/Sonara-class) | No | Deliberately *not* coupled to tailoring; review-first, opt-in apply separate |

## Sources

- `.planning/PROJECT.md` — milestone scope, pillars A–E, out-of-scope, key decisions (HIGH confidence, repo canonical)
- `.planning/codebase/CONCERNS.md` — auditability gaps, broken generate-materials path, synthesized-artifact debt, projection parity (HIGH confidence, repo canonical)
- `CLAUDE.md` — root-cause/auditability discipline: coverage computed on real text, no suppression of missing lists, preserve artifacts on re-tailor, judge audit-trail inspectability (HIGH confidence, repo canonical)
- AI resume-tailoring product category knowledge: Jobscan, Teal, Rezi, Kickresume, Enhancv, Huntr, Careerflow, Simplify, LazyApply, Sonara, and ChatGPT/Claude manual workflows (MEDIUM confidence, training knowledge as of Jan 2026, not live-verified — competitor specifics are directional)
- Well-documented LLM-resume failure modes: fabricated metrics, keyword stuffing, generic "AI-sounding" prose (MEDIUM confidence, training knowledge)

---
*Feature research for: grounded, inspectable AI resume tailoring*
*Researched: 2026-06-08*
</content>
</invoke>
