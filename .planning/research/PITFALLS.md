# Pitfalls Research

**Domain:** Grounded, inspectable, provenance-tracked LLM resume tailoring + structured job/employer analysis
**Researched:** 2026-06-08
**Confidence:** MEDIUM-HIGH (HIGH where grounded in repo constraints in `.planning/PROJECT.md`, `.planning/codebase/CONCERNS.md`, and the CLAUDE.md auditability discipline; MEDIUM where based on general grounded-LLM / RAG-faithfulness domain knowledge — live web search and the research-plan seam were unavailable in this environment, so external post-mortems are not directly cited.)

> Phase names below are *topic* labels, not committed roadmap phases. The roadmap author should map them onto the milestone's actual phase breakdown. The natural decomposition implied here is: **P1 Job/Employer Analysis (reasoned keywords)** → **P2 Grounded Tailoring + Per-Bullet Provenance** → **P3 Granular Control Enforcement** → **P4 Coverage/Audit computed against rendered text** → **P5 Human Voice** → **P6 Inspector UI**. Several pitfalls span phases; the mapping table at the end is the authoritative cross-reference.

---

## Critical Pitfalls

### Pitfall 1: Hallucinated provenance — the model writes its own citations

**What goes wrong:**
You ask the LLM to emit, per bullet, "the profile evidence this came from" and "the job requirement this serves." The model happily produces evidence IDs, quotes, and requirement references that *look* canonical but are invented, paraphrased, or point at the wrong source. The provenance reads as authoritative in the inspector, but the cited profile fact was never in the canonical profile, or the quoted JD line does not exist in the snapshot. This is the single most dangerous failure for this milestone: it manufactures *false trust*, which is strictly worse than no provenance.

**Why it happens:**
LLMs are fluent at producing plausible-looking references and will fabricate an ID/quote rather than say "no source." Free-text provenance has no referential integrity. When provenance is a *generation output* rather than a *binding to pre-existing records*, nothing forces the cited evidence to actually exist.

**How to avoid:**
- Make provenance a **binding to canonical IDs, not free text.** The model selects from an enumerated, pre-supplied set of profile-evidence records (each with a stable ID) and an enumerated set of requirement records produced by the job-analysis stage. The model emits IDs; the system resolves them to text.
- **Validate every emitted ID against the canonical set at generation time.** Any bullet referencing a non-existent profile-evidence ID or requirement ID is a hard generation failure (reject + repair), never silently rendered.
- For any quoted JD span, verify the quote is a literal substring of the persisted posting snapshot before accepting it.
- Persist provenance as foreign keys into the profile-evidence and requirement tables, with a NOT-NULL / referential constraint — not as a JSON blob of strings.

**Warning signs:**
- Provenance fields are free-text strings rather than resolved IDs.
- Inspector shows an evidence quote that does not appear verbatim in the canonical profile.
- A "regenerate" produces different evidence IDs for the same bullet with the same inputs.

**Phase to address:**
P2 (Grounded Tailoring + Per-Bullet Provenance). The provenance *schema* (IDs, not strings) must be designed here; a fixture that feeds a fabricated ID and asserts a hard reject is the gate.

---

### Pitfall 2: Reasoned keyword extraction that looks reasoned but isn't reproducible

**What goes wrong:**
The new job-analysis stage produces keywords with attached "reasoning," replacing today's flakey extraction. But run it twice on the same JD and you get a different keyword set, different priorities, or different must-have/nice-to-have splits. The reasoning text is post-hoc narration, not a determinant of the output. You have replaced *visibly* random extraction with *invisibly* random extraction wearing a reasoning costume — which is harder to detect and erodes trust once a user notices it.

**Why it happens:**
- Non-zero temperature + unconstrained free-form keyword lists yield run-to-run variance.
- "Explain your reasoning" prompts produce rationalization after the fact; the model isn't actually constrained by it.
- No anchoring: keywords aren't tied to specific JD spans, so the model free-associates from the role title.
- The repo explicitly names today's extraction as "flakey, random" (`PROJECT.md` Pillar A) — the failure mode is already present and must be designed out, not merely re-prompted.

**How to avoid:**
- **Anchor every keyword to a JD span.** A keyword is only valid if it is grounded in a quoted substring of the persisted posting snapshot; the analysis records `(keyword, source_span, must_have|nice_to_have, priority)`. No span → not a keyword.
- **Make extraction deterministic enough to be reproducible:** low/zero temperature for the analysis call, and a stable, ordered output contract. Treat reproducibility as a testable property, not a hope.
- Add a **reproducibility fixture**: run the analysis twice on a canonical JD and assert the keyword set + must/nice classification is stable (exact or within a defined tolerance). This is the direct regression for "flakey."
- Separate *extraction* (grounded, deterministic) from *prioritization* (reasoned) so each is independently inspectable and testable.

**Warning signs:**
- Two runs on the identical JD snapshot yield different keyword sets.
- Keywords present that have no substring match in the JD.
- "Reasoning" text references requirements not in the JD (it's narrating, not extracting).
- Priorities/weights with no recorded basis.

**Phase to address:**
P1 (Job/Employer Analysis). This is the root-cause phase named in `PROJECT.md` ("fix it upstream"). The reproducibility + span-anchoring fixtures are the phase gate.

---

### Pitfall 3: Fabrication leaking past "never invent metrics/dates" rules

**What goes wrong:**
The granular controls say "rephrasing always allowed, invention only for closely-related experience, never fabricate metrics/dates." But fabricated numbers, percentages, dollar figures, team sizes, durations, and dates still appear in output — because the rule lived only in the prompt, and the model occasionally ignores it (especially when a JD emphasizes quantified impact and the profile lacks numbers). A single fabricated "increased revenue 35%" that the user doesn't catch can sink a real application or an interview.

**Why it happens:**
- Prompt-only guardrails are probabilistic, not enforced. "Never invent metrics" is a strong prior the model usually follows and occasionally violates.
- The model is trained to make resumes impressive; quantified bullets are a learned pattern it reaches for under pressure.
- No post-generation verifier checks that every number/date in the output traces to a profile fact.

**How to avoid:**
- **Defense in depth, not prompt-only.** Add a deterministic **post-generation fabrication detector**: extract every numeric token, percentage, currency value, and date from the generated resume text and require each to be present in (or derivable from) the canonical profile evidence. Any unsourced metric/date is a hard fail → repair or reject.
- Record per bullet which control level governed it (`PROJECT.md` Pillar C), so a bullet produced under "invention permitted" is distinguishable from one that should have been rephrase-only.
- Treat metric/date provenance as a first-class column: a generated metric must point at the profile fact it came from, or it cannot ship.
- Fixture: feed a JD that screams for metrics + a profile with **no** numbers, and assert the output contains zero unsourced numerics.

**Warning signs:**
- Numbers in the output that don't appear anywhere in the profile.
- Dates/durations more specific than the profile records.
- The fabrication check is "the prompt says not to" with no detector behind it.

**Phase to address:**
P3 (Granular Control Enforcement) for the per-decision rule recording; the deterministic numeric/date verifier is shared with P4 (audit computed against rendered text). The fabrication-detector fixture is the gate for both.

---

### Pitfall 4: Provenance/coverage drifts from the final rendered (PDF) text

**What goes wrong:**
Provenance and keyword-coverage are computed against the LLM's *structured candidate output* (the JSON it returned), but the bullet that ends up in the rendered resume and the PDF is different — truncated to fit a page, reflowed, edited by a repair pass, de-buzzworded by the voice pass, or transformed by the LaTeX/HTML renderer. The inspector then shows provenance/coverage for text the user never sees in their PDF. This directly violates the repo's auditability discipline: *"keyword coverage be computed against actual generated text … never inferred."* (CLAUDE.md)

**Why it happens:**
- The pipeline has multiple transform stages (candidate → repair → voice pass → render → PDF). Audit data computed at an early stage goes stale by the final stage.
- The repo already has **two render paths** (LaTeX + Playwright HTML; `PROJECT.md` Validated) — easy for the audited text and the rendered text to diverge.
- It's tempting to compute coverage once, early, where the data is cleanly structured.

**How to avoid:**
- **Compute coverage and finalize provenance against the *last* canonical text that maps 1:1 to what renders** — after the voice pass and any repair, against the exact bullet strings that go into the renderer. Re-extract the rendered text (or the immediate pre-render canonical string set) and compute coverage there.
- Carry a **stable bullet identity** through every transform stage so provenance survives rephrasing (provenance binds to a bullet ID, and the bullet's text is updated as it transforms, never the binding silently dropped).
- Add a **round-trip fixture**: generate → voice-pass → render, then assert the audited bullet text equals the rendered bullet text and that covered/missing keyword lists were computed against that final text.
- If the renderer drops/truncates content (page fit), the audit must reflect the dropped state, not the pre-drop state.

**Warning signs:**
- Coverage computed in the same function that parses the model's raw JSON.
- Voice/repair passes run *after* coverage is computed.
- Inspector quote ≠ PDF text.
- No single "final canonical text" artifact that both the renderer and the auditor consume.

**Phase to address:**
P4 (Coverage/Audit computed against rendered text). This is the phase that most directly enforces the auditability discipline. Voice pass (P5) and render must be sequenced *before* the final audit, and the round-trip fixture is the gate.

---

### Pitfall 5: Audit data synthesized from heuristics instead of generation-time truth

**What goes wrong:**
Instead of recording what actually happened during generation, the system reconstructs audit data after the fact: it infers "covered keywords" by string-matching JD keywords against the resume, infers "missing keywords" from the JD alone, infers which profile fact "probably" produced a bullet, or — worst, given existing tech debt — synthesizes artifact/provenance rows from sibling files on disk. This produces audit data that is plausible but not *true*, and the user can't tell the difference.

**Why it happens:**
- Generation-time capture is more work than post-hoc reconstruction.
- The repo already has two concrete instances of this anti-pattern: **material artifact rows synthesized from sibling `.txt` files** with no DB record (`CONCERNS.md` "Material artifact records can be synthesized from sibling files") and **legacy wide-table fallbacks** (`tailored_resume_path`, etc.). It is very easy to extend that habit to provenance.
- CLAUDE.md explicitly forbids exactly this: "Missing/covered keyword lists are useful only when computed against the actual generated resume text or explicitly recorded generation-time coverage. Never infer misses from job keywords alone."

**How to avoid:**
- **Capture provenance and coverage at generation time and persist them canonically (DB-backed), as the milestone requires** (`PROJECT.md` Pillar B + Constraints: "computed at generation time … persisted canonically").
- Do **not** source any new provenance/coverage from sibling files, legacy `jobs.*` columns, or post-hoc inference. New audit tables are the single source of truth; the inspector reads only DB-backed rows.
- "Missing keywords" must be computed as `analysis_keywords − keywords_actually_present_in_final_text`, not derived from the JD alone.
- Mark provenance rows with their generation run/event so they're traceable to a specific generation, never reconstructed.
- Fixture: delete/skew the sibling files and legacy columns; assert the inspector still shows correct audit data from canonical tables (and shows *nothing fabricated* when canonical data is absent).

**Warning signs:**
- Any code path that reads `.txt`/PDF neighbors or legacy columns to populate provenance/coverage.
- "Missing" keyword list derived without referencing generated text.
- Provenance rows with no link to a generation event/run.
- Audit data that survives even when the generation never recorded it.

**Phase to address:**
P2 (provenance capture) and P4 (coverage capture) — both must write canonical DB rows at generation time. A cross-cutting "no-heuristic-synthesis" guard fixture spans both. This is the highest-alignment pitfall with the repo's stated discipline and tech debt.

---

### Pitfall 6: Re-tailor/retry destroys the current accepted artifact

**What goes wrong:**
A user clicks re-tailor (`retailor_job` / `retailor_current_policy` exist today, `PROJECT.md`). The new run fails, produces worse output, or errors mid-way — and the previously accepted, reviewable resume + its provenance/coverage are gone or overwritten. The user is left with a broken/empty state and no way back to the material they trusted. CLAUDE.md: "Re-tailor/retry actions must not hide or suppress the last accepted artifact until a replacement is approved. Failed refreshes remain audit history."

**Why it happens:**
- In-place mutation of the artifact row is the simplest implementation.
- The provenance/coverage tables get truncated-and-rewritten per run instead of versioned.
- Failure handling overwrites before the new candidate is validated/accepted.

**How to avoid:**
- **Version generations.** Each tailoring run is a new immutable generation record (with its own provenance + coverage). The "accepted/current" pointer only advances when a new generation is approved/valid.
- A failed re-tailor leaves the previous accepted generation as current and records the failure as audit history.
- Provenance/coverage are keyed by generation ID, never overwritten in place.
- Fixture: accept generation v1, run a re-tailor that throws, assert v1 is still current + still fully inspectable, and the failed run is visible as history.

**Warning signs:**
- Tailoring writes to a single mutable artifact row.
- Provenance table has one row-set per job (not per generation).
- Re-tailor clears old data before the new candidate passes validation.

**Phase to address:**
P2 (generation versioning is part of the provenance data model) with verification surfacing in P6 (Inspector UI shows current vs. history). The destroy-on-failure fixture is the gate.

---

### Pitfall 7: Prose still reads as AI despite grounding

**What goes wrong:**
Bullets are perfectly grounded and provenance-clean, but still reek of LLM: uniform "Spearheaded X to drive Y, resulting in Z" structure, buzzword density (leverage, spearhead, synergize, robust, seamless), em-dash cadence, every bullet the same length and rhythm. Grounding fixed *truthfulness*; it did nothing for *voice*. The explicit milestone goal (`PROJECT.md` Pillar D) is unmet, and users still feel the resume isn't theirs.

**Why it happens:**
- Voice is treated as a side effect of grounding rather than an explicit, separately-verified pass.
- Grounding constraints (must cite evidence, must serve a requirement) can *increase* template-iness because the model falls back to a safe rigid pattern under constraint.
- "Sound human" is hard to test, so it gets no fixture and silently regresses.

**How to avoid:**
- Make voice an **explicit transform stage with measurable, testable proxies**, not a vibe: deterministic checks for banned buzzword list density, sentence-structure variety (not every bullet starting with the same verb pattern), bullet-length variance, and em-dash/cliché frequency. These are crude but catch the worst regressions.
- **Sequence voice before final audit** (see Pitfall 4) so the audited/rendered text is the human-voiced text.
- Keep voice subordinate to grounding: the de-buzzword/rephrase pass must not introduce unsourced claims or break provenance bindings (re-validate provenance + fabrication after the voice pass).
- Optionally use the existing persona/judge scoring (kept as the quality gate this milestone per `PROJECT.md`) to score "reads as human," but back it with the deterministic proxies so the gate isn't purely LLM-judged.

**Warning signs:**
- Every bullet matches one template.
- High buzzword density; uniform length/rhythm.
- Voice has no fixture and no deterministic proxy metric.
- Voice pass runs but provenance/fabrication checks don't re-run after it.

**Phase to address:**
P5 (Human Voice), sequenced before final render/audit. Deterministic voice-proxy fixtures + re-validation-after-voice are the gates.

---

### Pitfall 8: Latency/cost blowup from multi-step LLM analysis

**What goes wrong:**
The new pipeline is now job-analysis → grounded tailoring → repair → judge → voice pass → (maybe re-judge). Each is an LLM call (some large). With the existing 180s client timeout and "large candidate/judge token budgets" (`CONCERNS.md` "LLM calls have large token/time budgets"), a single tailoring can take minutes and cost multiples of today's, with retries compounding it. Users perceive the flagship feature as slow/expensive; long calls also pin the cooperative-cancellation worker (`CONCERNS.md` Fragile Areas).

**Why it happens:**
- Each new inspectability requirement is naively implemented as another full LLM round-trip over the whole resume + JD.
- No per-stage latency/cost budget; no caching of the (expensive, reusable) job-analysis output.
- Retries + judge loops multiply calls without a cap.

**How to avoid:**
- **Cache and persist the job-analysis artifact** (`PROJECT.md` Pillar A persists it anyway) so re-tailors reuse it instead of re-analyzing.
- Set **explicit per-stage latency + token budgets** and a total-call cap; the repo already flags adding "local cost/latency budgets" and "per-stage LLM spend in the Operations view" (`CONCERNS.md`). Build that meter in this milestone since you're adding the stages.
- Prefer deterministic checks (fabrication detector, coverage, voice proxies) over LLM judge calls where a non-LLM check suffices — they're free and reproducible.
- Bound judge/repair loops to a fixed max iterations; surface when the cap is hit rather than looping.
- Make each long LLM call cancellation-aware at its I/O boundary (ties to `CONCERNS.md` cooperative cancellation).

**Warning signs:**
- Wall-clock per tailoring approaches/exceeds the 180s timeout.
- Re-tailor re-runs job analysis from scratch.
- No per-stage spend/latency visibility.
- Unbounded judge/repair loops.

**Phase to address:**
P1 (persist/cache analysis), and a cross-cutting budget/metering concern surfaced in P6 (Operations/Inspector). Gate: a latency/cost regression fixture that fails if a tailoring exceeds the per-stage budget.

---

### Pitfall 9: Inspector UI masks missing audit data instead of exposing it

**What goes wrong:**
The inspector shows clean per-bullet provenance — but when provenance is missing, low-confidence, or a coverage value is embarrassing (e.g., a must-have keyword is missing), the UI silently hides the field, shows an empty default, or back-fills a plausible-looking value. This is the exact symptom the CLAUDE.md root-cause discipline warns against: "do not start by hiding, filtering, renaming, or moving the displayed value … do not remove the UI field just because the current data is embarrassing." `PROJECT.md` Pillar E: "no UI masking of missing audit data."

**Why it happens:**
- Missing/ugly data is easier to hide than to compute correctly or render honestly.
- Frontend defaults (empty string, `?? "—"`) quietly swallow nulls that should be loud.
- The team conflates "the bullet has no provenance" (a real defect to surface) with "render nothing."

**How to avoid:**
- The inspector must render **distinct, explicit states**: provenance present / provenance missing (a flagged defect, not blank) / keyword covered / keyword missing (shown prominently, never suppressed).
- Missing must-have coverage is a *feature of the audit*, not a thing to hide — surface it so the user can act.
- Wire through the existing contracts/projection/read-model boundaries with no client-side fabrication (CLAUDE.md frontend anti-patterns; `PROJECT.md` Pillar E).
- Fixture/Storybook: per-state stories (provenance-present, provenance-missing, coverage-complete, coverage-with-misses) proving the missing/embarrassing states render explicitly, not blank.

**Warning signs:**
- Inspector components with `?? "—"` / conditional render that hides nulls.
- Missing-keyword list never shown when non-empty.
- A bullet with no provenance renders identically to one with provenance.
- No empty/missing-state stories.

**Phase to address:**
P6 (Inspector UI). Per-state Storybook stories (loading/populated/empty/missing/error) are the gate — and they must reflect honest backend data, not masked UI.

---

### Pitfall 10: Coverage gamed by keyword stuffing / surface matching

**What goes wrong:**
To make coverage look good, the tailoring stuffs JD keywords into bullets verbatim, or coverage is computed by naive substring match so "managed" counts as covering "management," "lead" matches "leadership/misleading," and a keyword crammed into a skills-dump line counts as genuinely demonstrated. Coverage rises while resume quality and truthfulness fall — and the audit *endorses* the degradation.

**Why it happens:**
- Coverage is an easy target metric; optimizing the metric instead of the outcome (Goodhart's law).
- Naive string matching over-counts (substring false positives) and under-counts (synonyms/morphology).
- No link between a "covered" keyword and a *grounded* bullet that legitimately demonstrates it.

**How to avoid:**
- Count a keyword as covered only when it appears in a bullet that is itself **grounded in profile evidence** (covered ⇒ provenance-backed), not merely present as a string.
- Use token/lemma-aware matching with care, and record *where* each keyword is covered (which bullet) so coverage is inspectable, not just a count.
- Surface keyword stuffing as a smell in the voice pass (repetition density).
- Fixture: a keyword present only in an unsourced skills-dump line must **not** count as covered.

**Warning signs:**
- Coverage computed by bare `includes()` substring matching.
- Covered keywords with no associated grounded bullet.
- Skills section padded with JD terms; rising coverage with falling judge scores.

**Phase to address:**
P4 (coverage definition) building on P1 (the analysis keyword set) and P2 (grounding link). Gate: substring-false-positive and stuffing fixtures.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Provenance as free-text JSON instead of FK bindings to canonical IDs | Fast to prompt and store | Hallucinated/unverifiable provenance, no referential integrity, can't validate | Never |
| Compute coverage on the model's raw JSON candidate (early) | Clean structured input | Drifts from rendered/PDF text; violates auditability discipline | Never |
| Infer missing keywords from the JD alone | No need to parse generated text | Audit lies about what the resume actually covers | Never |
| Synthesize provenance/artifact rows from sibling files or legacy columns | Reuses existing tech-debt path | Fake-but-plausible audit; extends a known anti-pattern (`CONCERNS.md`) | Never |
| In-place mutation of the single artifact/provenance row on re-tailor | Simplest persistence | Destroys accepted reviewable material on failure; violates discipline | Never |
| Prompt-only "never fabricate metrics" with no detector | Quick guardrail | Fabrication leaks past prompt occasionally — the costly cases | Only as a *complement* to a deterministic detector, never alone |
| Re-run job analysis from scratch on every re-tailor | No caching code | Latency/cost blowup; the analysis is supposed to be persisted anyway | Never (analysis is persisted by design) |
| LLM judge as the only voice/quality check | Easy to add | Non-reproducible, costly, can't fixture-gate "reads human" | Only alongside deterministic voice proxies |
| Higher temperature for keyword extraction "for richness" | Slightly more varied keywords | Non-reproducible extraction — the exact flaw being replaced | Never for extraction (OK for prose phrasing under grounding) |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| LaTeX + Playwright HTML render paths (`PROJECT.md`) | Audit one path's text while the other renders differently | Compute audit against the single final canonical text both renderers consume; round-trip-test both paths |
| Persisted posting snapshot (enrichment) | Quote/keyword-anchor against the live JD or model memory | Anchor every keyword + quote to the persisted snapshot; verify substrings against it |
| Canonical profile store | Let the model paraphrase profile facts into "evidence" | Bind to profile-evidence record IDs; resolve text from the store, validate IDs exist |
| Projection layer (duplicated TS↔Python, `CONCERNS.md`) | Project provenance/coverage in only one runtime → drift | Add cross-runtime projection parity fixtures whenever provenance/coverage projections change |
| `job_events` + frontend invalidation router | New tailoring/analysis events without a frontend handler | Add contract + projection + invalidation handler + parity test in the same slice (`every-event-has-handler.test.ts`) |
| Langfuse export (`CONCERNS.md` security) | New analysis/provenance prompts silently exported with profile/JD content | Keep export opt-in; treat new prompts as sensitive; consider redaction/metadata-only mode |
| Persona/judge LLM (kept as quality gate) | Treat judge pass/fail as the audit trail | Make prompt, rubric, response, blockers inspectable (CLAUDE.md); don't let judge summary substitute for computed audit |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Multi-step LLM chain per tailoring (analysis→tailor→repair→judge→voice) | Wall-clock minutes, near/over 180s timeout, high spend | Per-stage budgets + total-call cap; persist/cache analysis; prefer deterministic checks | Immediately, on the first real multi-step run |
| Re-analyze JD on every re-tailor | Re-tailor as slow/costly as first run | Reuse the persisted job-analysis artifact | As soon as users iterate on a resume |
| Unbounded judge/repair loops | Variable, occasionally very long tailoring | Fixed max iterations; surface cap-hit | Under adversarial JDs or marginal candidates |
| Long LLM call pins cooperative-cancel worker (`CONCERNS.md`) | Cancel "requested" but generation continues | Make long calls cancellation-aware at I/O boundary; chunk where possible | Whenever a user cancels a long tailoring |
| Coverage/provenance recomputed on every read (projection-refresh-on-read, `CONCERNS.md`) | Read latency includes audit recompute | Compute once at generation time, persist; reads serve stored rows | As local history grows |
| In-memory artifact/audit filtering (`CONCERNS.md`) | Slow inspector list as artifacts accumulate | Push audit list filters/pagination into SQL | Artifact-heavy local DBs |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| New analysis/provenance prompts exported to Langfuse by default | Profile, JD, resume, rationale leak to telemetry (`CONCERNS.md`) | Keep export opt-in; redact or metadata-only mode for new spans |
| Debug prompt dumps now include richer grounded prompts | Sensitive profile+JD+evidence written to local files (`CONCERNS.md`) | Keep debug gen opt-in; ignore generated paths; retention guidance |
| Inspector/API returns local artifact paths or DB-sourced paths to client | Path leakage / poisoned-row file access (`CONCERNS.md`) | Don't return local paths to the inspector; realpath-contain under artifact roots |
| Provenance/coverage rows treated as non-sensitive | They contain profile evidence + JD content | Treat audit tables as sensitive generated data; never commit; same handling as resumes |
| New cross-runtime tables created independently in TS + Python | Schema drift breaks audit reads (feedback-schema precedent, `CONCERNS.md`) | Single migration source or schema-contract test for new audit tables |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Hiding missing/low-confidence provenance | User over-trusts an unverified bullet | Render "provenance missing" as an explicit, visible state (Pitfall 9) |
| Suppressing the missing-keyword list when non-empty | User ships a resume missing must-haves, unaware | Always surface missing must-haves prominently |
| Showing judge pass/fail with no inspectable basis | User can't tell *why* a bullet was accepted/flagged | Expose prompt/rubric/response/blockers (CLAUDE.md) |
| Re-tailor clears current view until new result lands | User loses access to trusted material mid-iteration | Keep accepted generation current; show new run as in-progress alongside |
| Provenance shown but un-actionable (read-only narration) | User can see the trail but can't fix a bad bullet | Tie inspection to a per-bullet re-tailor/override path (still versioned, never destructive) |
| Coverage shown as a single number | A high % hides specific must-have misses | Show per-keyword, per-bullet coverage with must/nice distinction |

## "Looks Done But Isn't" Checklist

- [ ] **Per-bullet provenance:** Often missing *ID validation* — verify a fabricated evidence/requirement ID is hard-rejected, not rendered (Pitfall 1).
- [ ] **Reasoned keywords:** Often missing *reproducibility* — verify two runs on the same JD snapshot produce the same keyword set + must/nice split (Pitfall 2).
- [ ] **"Never fabricate metrics":** Often missing the *detector* — verify a numbers-hungry JD + numberless profile yields zero unsourced numerics (Pitfall 3).
- [ ] **Coverage:** Often computed against the *wrong text* — verify covered/missing are computed against the final rendered/PDF text, post-voice-pass (Pitfall 4).
- [ ] **Audit data:** Often *synthesized* — verify it survives only from canonical DB rows when sibling files/legacy columns are removed/skewed (Pitfall 5).
- [ ] **Re-tailor:** Often *destructive* — verify a failing re-tailor leaves the prior accepted generation current + inspectable (Pitfall 6).
- [ ] **Human voice:** Often *unverified* — verify deterministic voice proxies (buzzword density, structure variety) gate output, and provenance re-validates after the voice pass (Pitfall 7).
- [ ] **Latency/cost:** Often *unbudgeted* — verify per-stage budgets exist and re-tailor reuses persisted analysis (Pitfall 8).
- [ ] **Inspector states:** Often *masking* — verify missing/empty/error/embarrassing states render explicitly, not blank (Pitfall 9).
- [ ] **Coverage integrity:** Often *gameable* — verify substring false positives and unsourced keyword stuffing don't count as covered (Pitfall 10).
- [ ] **Projection parity:** Often *one-runtime-only* — verify new provenance/coverage projections match across TS + Python (`CONCERNS.md`).

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Hallucinated provenance shipped (free-text) | HIGH | Migrate provenance to ID bindings; backfill is impossible for past runs — mark old generations as un-audited rather than fabricate; add validation going forward |
| Non-reproducible keywords | MEDIUM | Lower temperature, add span-anchoring, add reproducibility fixture; re-run analysis to repopulate persisted artifact |
| Fabricated metric in shipped resume | HIGH (reputational to user) | Add deterministic detector; re-tailor affected jobs; surface a "contains unsourced numeric" flag for prior generations |
| Audit/rendered drift | MEDIUM | Move audit computation to post-voice/pre-render text; add round-trip fixture; recompute coverage for current generations |
| Heuristic-synthesized audit | MEDIUM | Stop sourcing from files/legacy columns; recompute from generation-time data where available; mark un-recoverable as un-audited (never fabricate) |
| Destructive re-tailor data loss | HIGH | Introduce generation versioning; past losses unrecoverable — restore from event log if generation events were emitted |
| AI-sounding prose | LOW | Add voice pass + deterministic proxies; re-tailor; cheap relative to truthfulness bugs |
| Latency/cost blowup | LOW-MEDIUM | Add budgets, cache analysis, cap loops; mostly config + sequencing |
| UI masking | LOW | Add explicit missing/empty states + per-state stories; frontend-only fix |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Hallucinated provenance | P2 Grounded Tailoring + Provenance | Fixture: fabricated evidence/requirement ID → hard reject; provenance is FK-bound, not free text |
| 2. Non-reproducible reasoned keywords | P1 Job/Employer Analysis | Fixture: same JD snapshot → identical keyword set + must/nice; every keyword has a JD span |
| 3. Fabrication past "never invent" | P3 Control Enforcement (+ P4 detector) | Fixture: numbers-hungry JD + numberless profile → zero unsourced numerics; per-decision rule recorded |
| 4. Provenance/coverage ↔ rendered drift | P4 Audit vs Rendered Text (after P5 voice) | Round-trip fixture: audited bullet text == rendered/PDF text; coverage computed on final text |
| 5. Heuristic-synthesized audit | P2 + P4 (generation-time capture) | Fixture: remove sibling files/legacy columns → audit still correct from canonical DB, nothing fabricated |
| 6. Destructive re-tailor | P2 (versioning), surfaced P6 | Fixture: failing re-tailor leaves v1 current + inspectable; failed run kept as history |
| 7. AI-sounding prose | P5 Human Voice (pre-render) | Fixture: voice proxies gate output; provenance/fabrication re-validated after voice pass |
| 8. Latency/cost blowup | P1 (cache analysis) + cross-cutting metering (P6) | Fixture: per-stage budget exceeded → fail; re-tailor reuses persisted analysis |
| 9. Inspector masks missing audit | P6 Inspector UI | Per-state Storybook stories (present/missing/empty/error) render honestly, not blank |
| 10. Coverage gamed/surface-matched | P4 (definition) + P1/P2 (grounding link) | Fixture: substring false positive + unsourced stuffing → not counted as covered |

## Sources

- `.planning/PROJECT.md` — milestone scope, pillars A–E, constraints, key decisions (HIGH confidence — canonical project context).
- `.planning/codebase/CONCERNS.md` — projection duplication, synthesized artifact rows, legacy fallbacks, LLM cost/latency budgets, cooperative cancellation, Langfuse/debug-prompt security, in-memory read paths (HIGH confidence — repo-grounded).
- `CLAUDE.md` "Root-Cause And Auditability Discipline" — source-of-truth-per-claim, coverage-against-generated-text, no-UI-masking, non-destructive re-tailor (HIGH confidence — repo policy).
- General grounded-LLM / RAG-faithfulness and resume-tailoring domain knowledge — provenance-as-binding, fabrication detection as defense-in-depth, Goodhart/coverage-gaming, voice-as-separate-pass (MEDIUM confidence — established practice; live external post-mortems were not citable because web search and the research-plan seam were unavailable in this environment).

---
*Pitfalls research for: grounded, inspectable LLM resume tailoring + structured job/employer analysis*
*Researched: 2026-06-08*
