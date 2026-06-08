# Stack Research

**Domain:** Grounded, inspectable, LLM-driven resume tailoring (techniques + lightweight libraries for an existing Python httpx + Claude/Gemini structured-output pipeline)
**Researched:** 2026-06-08
**Confidence:** HIGH (techniques verified against current Anthropic platform docs and Instructor docs, dated 2025–2026; cross-checked against the existing codebase's LLM client)

> Scope note: This is a SUBSEQUENT milestone on a mapped codebase. The existing TypeScript/React/Fastify/Python/Temporal/SQLite stack and the general web/app tooling are **out of scope** here and already documented in `.planning/codebase/STACK.md`. This file recommends only the *techniques and supporting libraries/patterns* needed to add (a) typed job analysis with reproducible keyword extraction, (b) per-bullet provenance/grounding, (c) granular tailoring controls, and (d) human-authentic voice — to the Python LLM pipeline that already exists in `workers/automation/src/jobhunter/`.

---

## Reality Check On The Existing Pipeline (read this first)

Three facts about the current code shape every recommendation below. They were verified directly, not assumed:

1. **No LLM framework today.** `infrastructure/llm/llm_client.py` wraps a hand-rolled `jobhunter.llm.LLMClient` over `httpx`. There is no LangChain/LlamaIndex/agent framework. Keep it that way — see "What NOT to Use."
2. **Structured output already exists, as JSON Schema — not tool-use.** The client exposes `chat_json(..., response_schema=dict)` and a `response_schema` kwarg, implemented via OpenAI-compatible `response_format: {"type": "json_schema", ...}` and Gemini-native `generationConfig.responseSchema`. So a typed-output mechanism is already in place; this milestone should *use and harden* it, not replace the transport.
3. **The real default model is Gemini, not Claude.** `model_defaults.py` sets `DEFAULT_PIPELINE_LLM_MODEL_SPEC = "gemini:gemini-3.5-flash"`, and the client speaks OpenAI-compat / Gemini-native — it does **not** use the Anthropic SDK. PROJECT.md states the constraint "default to latest capable Claude models." There is a gap between aspiration and implementation. **Two of the most powerful grounding techniques below (Claude Structured Outputs `output_config.format` and Claude Citations) are native Anthropic Messages-API features that are not reachable through the current OpenAI-compat path.** The roadmap must decide explicitly: either (i) add a first-class Anthropic Messages adapter to unlock those features, or (ii) implement grounding provider-agnostically with JSON Schema + validator-driven re-ask (works on Gemini and Claude-via-compat today). This research recommends (ii) as the portable core, with (i) as an optional accelerator for the provenance call. Do not silently assume Claude-native features are available.

---

## Recommended Stack

### Core Techniques

| Technique | Where it applies | Why recommended (and how it fits the existing pipeline) |
|-----------|------------------|---------------------------------------------------------|
| **Quote-first / evidence-first extraction** (model must emit verbatim source spans *before* deriving structured fields) | Pillar A (job analysis, reproducible keywords) | Anthropic's official grounding recipe: "ask Claude to quote relevant parts of the documents first before carrying out its task." Forcing the model to anchor every requirement/keyword to a verbatim JD span is *the* fix for "flakey/random" extraction — the keyword is now a function of a cited span, not free-association. Provider-agnostic; works through the existing `chat_json` path. HIGH |
| **Typed extraction via JSON Schema constrained decoding** (Pydantic model → JSON Schema → `response_schema`) | Pillar A; provenance records (Pillar B) | The client already supports `response_schema`. Define the job-analysis and provenance shapes as **Pydantic v2 models** and feed `Model.model_json_schema()` as the schema. Constrained decoding eliminates parse errors/missing fields. Pydantic is already an implicit dependency surface in Python DDD code; adding explicit Pydantic models for LLM I/O is low-friction. HIGH |
| **Validator-driven re-ask** (Pydantic `field_validator`/`model_validator` that *rejects* an output not grounded in source, triggering an automatic retry with the error fed back) | Pillars A, B, C (enforce "never fabricate", "keyword must exist in JD", "metric must exist in profile") | This is the deterministic guardrail that makes "never fabricate metrics/dates" a *machine-checked invariant*, not a prompt hope. A validator that does `if quote not in source_text: raise ValueError(...)` forces a correction loop. Aligns exactly with CLAUDE.md's auditability discipline ("every displayed claim must have an explicit source of truth"). HIGH |
| **Prompt chaining: separate Analyze → Tailor → Verify calls** | Whole milestone | Anthropic explicitly recommends explicit chaining "when you need to inspect intermediate outputs or enforce a specific pipeline structure" — exactly this milestone. Persist the job-analysis artifact (Pillar A) from call 1; feed it as grounded input to the tailoring call; run a verification/self-check pass. Each step is a separate, loggable, Temporal-activity-shaped unit, which fits the existing stage/activity architecture. HIGH |
| **XML-tagged, long-context-ordered prompts** (`<job_posting>`, `<profile_evidence>`, `<tailoring_policy>`; long inputs at top, instruction/query at bottom) | All LLM calls | Anthropic: XML tags reduce misinterpretation when mixing instructions + multiple documents; placing long docs first and the query last improves quality "by up to 30%" on multi-document inputs. Directly improves analysis and tailoring fidelity at zero new dependency cost. HIGH |
| **Low/zero temperature + reasoning for reproducibility** | Pillar A keyword extraction | Reproducibility ("replacing today's flakey, random extraction") comes from (a) temperature → 0 on the extraction call, (b) quote-first grounding, and (c) a stable, fully-`required` schema (Claude orders required props deterministically). The client already accepts `temperature`; set it explicitly to 0 for extraction rather than relying on provider defaults. HIGH |
| **Per-decision transform taxonomy as an enum field** (`transform_type ∈ {verbatim, rephrase, reorder, emphasize, synthesize_related}`) recorded on every bullet | Pillar C (granular controls) + Pillar B (provenance) | Encode the tailoring rule that produced each bullet as a constrained enum in the provenance schema. The schema *is* the policy contract: "invent only closely-related" becomes a `synthesize_related` arm whose validator requires a linked profile evidence id; "never fabricate metrics" becomes a validator that rejects any numeric token in a bullet not present in cited profile evidence. MEDIUM-HIGH |
| **De-AI voice via positive style spec + anti-pattern list in the system prompt** | Pillar D (human voice) | Anthropic's guidance: "tell Claude what to do instead of what not to do," give concrete *positive* style examples, and explicitly name the generic patterns to avoid (the same approach as their `<frontend_aesthetics>` anti-slop snippet, transposed to prose). Pair with a small banned-buzzword lexicon and a structural-variety check (see Supporting Libraries). MEDIUM |

### Supporting Libraries

| Library | Version (current) | Purpose | When to use |
|---------|-------------------|---------|-------------|
| **Pydantic** | v2 (2.x) | Typed models for job-analysis output, provenance records, and tailoring-decision records; `model_json_schema()` feeds the existing `response_schema`; validators enforce grounding. | Adopt as the schema/validation layer for all new LLM I/O. Already idiomatic in the Python DDD code; gives the domain layer typed value objects for free. |
| **Instructor** | latest (MIT, ~1.x, `from_provider` API) | Optional thin wrapper that turns "call LLM → validate Pydantic → re-ask on `ValidationError`" into one call (`max_retries`, validator-driven self-correction, `InstructorRetryException` exposing failed attempts). Supports OpenAI, Anthropic, and Gemini via one `from_provider` interface. | Use **only if** you want the retry/re-ask loop pre-built rather than writing ~40 lines around the existing client. It is explicitly "thin, does one thing" — not a framework. Evaluate vs. keeping the hand-rolled client; do not adopt if it would fork the provider-selection logic the codebase already centralizes. See Alternatives. |
| **rapidfuzz** | 3.x | Deterministic verification that a generated bullet's claimed source span actually appears in (or closely matches) the cited profile/JD text — for the validator and for computing *real* keyword coverage against generated resume text. | Use in the verification/validator step so coverage and provenance are computed deterministically against actual generated text (CLAUDE.md mandate), not inferred from the JD alone. Pure-Python/C, no heavy deps. |
| **(stdlib) `difflib` / `re`** | stdlib | Lightweight alternative to rapidfuzz for substring/near-match checks and buzzword regex. | If you want zero new runtime deps; rapidfuzz is faster and more robust for fuzzy span matching. |

### Optional Accelerator (provider-dependent)

| Capability | Mechanism | Why it matters | Caveat |
|-----------|-----------|----------------|--------|
| **Claude Structured Outputs** | Anthropic Messages API `output_config.format = {"type":"json_schema","schema":...}` (GA; **beta header no longer required**; old `output_format` deprecated). Grammar-constrained decoding; compiled grammar cached 24h. | Strongest guarantee of schema-valid typed output for the job-analysis call. SDK helper `client.messages.parse(output_format=PydanticModel)` returns a typed object. | Requires adding an **Anthropic Messages adapter** (not reachable via current OpenAI-compat path). Schema limits: no recursion, no numeric/length constraints (SDK strips + re-validates locally), ≤20 strict tools, ≤24 optional params. **Incompatible with Citations in the same call.** |
| **Claude Citations** | Per-document `citations:{enabled:true}`; response returns `cited_text` + `document_index` + 0-indexed `start/end_char_index` (or `content_block_location` for custom-content chunks). All active models except Haiku 3. | Native, parsed, *guaranteed-valid* span pointers from generated claims back to provided source — a near-perfect fit for per-bullet provenance back to profile evidence and JD requirements, with `cited_text` not counting against output tokens. | Anthropic-only; **cannot be combined with Structured Outputs in one call.** Use *custom-content documents* (one block per profile bullet / per JD requirement) to get block-level citation granularity instead of sentence chunking. |

---

## Installation

```bash
# Python worker — add to workers/automation/pyproject.toml, then `uv sync`
uv --project workers/automation add pydantic        # v2 — typed LLM I/O + validators
uv --project workers/automation add rapidfuzz       # deterministic span/coverage verification

# Optional (only if adopting the prebuilt re-ask loop):
uv --project workers/automation add instructor      # thin Pydantic-validated LLM wrapper

# Optional (only if unlocking Claude-native Structured Outputs / Citations):
uv --project workers/automation add anthropic       # first-class Messages-API adapter
```

> Pydantic may already be transitively present; pin it explicitly and refresh `workers/automation/uv.lock`. No TypeScript/web dependencies are required for the *technique* layer — the new typed shapes surface to the UI through the existing `packages/contracts` Zod schemas + projections, per the architecture rules.

---

## Recommended Call Architecture (how the pieces compose)

Three chained, separately-persisted LLM steps, each a Temporal-activity-shaped unit:

```
Call 1 — Employer Analysis (Pillar A)        temperature=0, effort=high
  in:  <job_posting>
  out: JobAnalysis (Pydantic):
        role_summary, ideal_candidate,
        requirements:[{text, kind: must_have|nice_to_have, priority,
                       evidence_span (verbatim JD quote)}],
        keywords:[{term, evidence_span, requirement_ref}]
  guard: validator rejects any evidence_span not found verbatim in JD → re-ask
  persist: canonical job-analysis artifact (drives all downstream)

Call 2 — Grounded Tailoring (Pillars B + C)  temperature low, effort high
  in:  <job_analysis> + <profile_evidence> + <tailoring_policy>
  out: TailoredResume (Pydantic):
        bullets:[{text,
                  profile_evidence_ref,           # canonical profile fact id
                  requirement_ref,                # from Call 1
                  transform_type: enum,           # rephrase/synthesize_related/...
                  rationale}]
  guard (validators, deterministic, rapidfuzz):
    - every numeric/date token in text must appear in cited profile_evidence  → reject
    - transform_type==synthesize_related requires a closely-related evidence_ref → reject
    - transform_type==verbatim must fuzzy-match the source span               → reject
    re-ask with the specific violation appended.

Call 3 — Verification / Voice Pass (Pillar D + self-check)
  in:  generated resume text + policy
  out: warnings[] (labeled by lifecycle: repaired / residual-accepted / post-accept)
  also: compute keyword coverage with rapidfuzz against ACTUAL generated text
        (never inferred from JD) — satisfies CLAUDE.md coverage mandate.
```

This maps cleanly onto the existing stage/activity model (`materials/activities.py`, `pipeline/runner.py`) and the event/projection backbone. Each call's structured output becomes canonical DB-backed audit data, not a file heuristic.

---

## Alternatives Considered

| Recommended | Alternative | When to use the alternative |
|-------------|-------------|------------------------------|
| Hand-rolled re-ask loop around existing client + Pydantic | **Instructor** | Use Instructor if you want validation+retry+failed-attempt-context out of the box and are willing to route a call path through its `from_provider`. Skip it if it would duplicate/fork the codebase's existing provider/model-spec resolution in `jobhunter.llm`. |
| Provider-agnostic JSON Schema (`response_schema`) grounding | **Claude-native Structured Outputs (`output_config.format`)** | Use Claude-native when you add an Anthropic adapter and want grammar-guaranteed schemas + `messages.parse()` typed objects. Best for the high-stakes analysis call. Not available through today's OpenAI-compat transport. |
| Validator-enforced provenance + quote-first | **Claude Citations** | Use Citations when on Anthropic and you want guaranteed-valid char/block span pointers for the *grounding* call (can't be the same call as Structured Outputs). Strongest provenance fidelity, but provider-locked and incompatible with structured outputs. |
| Pydantic models | Raw `dict` + manual `json.loads` (status quo) | Never preferred for new code — loses typing, validation, and re-ask. Acceptable only for throwaway prototyping. |
| Anthropic `effort` parameter for reasoning depth | `thinking_budget` / `budget_tokens` (current client kwarg) | `budget_tokens` is **deprecated** on Claude 4.6+; prefer `effort` (`high`/`xhigh`) on Anthropic. Keep `thinking_budget` only for Gemini-native thinking config until the Anthropic path lands. |

---

## What NOT to Use

| Avoid | Why (specific problem) | Use instead |
|-------|------------------------|-------------|
| **LangChain / LlamaIndex / agent frameworks** | Heavyweight, opinionated abstractions, churny APIs, and unnecessary control-flow indirection for a 3-call deterministic chain. They would fight the existing hexagonal `LlmPort` + httpx design and the Temporal orchestration that already owns control flow. | The existing `LlmPort`/`LLMClient` + Pydantic + (optionally) Instructor. |
| **Response prefilling to force JSON / strip preambles** | **Removed on Claude 4.6+ / Mythos** — prefilled last assistant turn returns **400**. Any pattern in the codebase relying on assistant prefill will break on current Claude models. | Structured Outputs / `response_schema`, XML output tags, or a direct "respond without preamble" instruction; strip stray preambles in post-processing. |
| **`budget_tokens` / extended-thinking config as the primary reasoning lever** | Deprecated on current Claude models; will be removed. | `effort` (Anthropic) with adaptive thinking; Gemini thinking config only on the Gemini path. |
| **Combining Citations + Structured Outputs in one call** | Hard **400 error** — citations interleave citation blocks with text, incompatible with strict JSON schema decoding. | Split into two calls: structured analysis (schema) and grounded generation (citations), per the chained architecture above. |
| **Inferring keyword coverage / "missing keywords" from the JD alone** | Violates CLAUDE.md auditability discipline and reproduces the current "flakey" defect; the displayed coverage would not reflect the real resume. | Compute coverage with rapidfuzz against the **actual generated resume text** at generation time; persist canonically. |
| **PII inside JSON Schema definitions** (property names, enum/const/pattern values) | Anthropic caches schemas separately (24h) without the same retention protections; do not embed profile data in the schema. | Keep schemas structural; pass profile/JD content only in message documents. |
| **Relying on provider-default temperature for the extraction call** | Non-determinism is the root cause of "flakey/random" keywords. | Set `temperature=0` explicitly for the analysis/extraction call. |

---

## Stack Patterns by Variant

**If you keep the current Gemini-via-OpenAI-compat default (lowest-change path):**
- Use Pydantic → `response_schema` for typed outputs (already supported), quote-first grounding, validator-driven re-ask (hand-rolled or Instructor), and rapidfuzz verification.
- Provenance is enforced by *validators*, not native citations. Fully portable; ships without an Anthropic dependency.
- Because PROJECT.md wants "latest Claude models," flag this as a decision point for the roadmap: the portable path works on any provider but does not get Claude Citations' guaranteed span pointers.

**If you honor PROJECT.md's "default to latest Claude models" and add an Anthropic Messages adapter:**
- Use Claude **Structured Outputs** (`output_config.format`, `messages.parse()` with the Pydantic model) for Call 1 (analysis) — grammar-guaranteed schema, no beta header.
- Use Claude **Citations** with **custom-content documents** (one content block per profile fact and per JD requirement) for Call 2's grounding pointers — block-indexed, guaranteed-valid provenance.
- Keep the two features in *separate* calls (they cannot coexist).
- Set `effort: high`/`xhigh` and a large `max_tokens` (start 64k) for the reasoning-heavy analysis; `temperature` 0 for extraction.

**If latency/cost is tight (existing 180s client timeout):**
- Run analysis on a cheaper/faster model (e.g. Sonnet 4.6 at `low`/`medium` effort, or Gemini Flash) and reserve higher effort for the tailoring + verification calls.
- Apply `cache_control: ephemeral` to the long profile/JD documents (prompt caching works with both Structured Outputs and Citations) to cut repeated-input cost across re-tailor runs.

---

## Version Compatibility / Constraints To Encode

| Constraint | Detail | Source confidence |
|-----------|--------|-------------------|
| Claude Structured Outputs | GA on Opus 4.5–4.8, Sonnet 4.5/4.6, Haiku 4.5 (and Vertex/Bedrock subsets). `output_config.format`; beta header no longer required; `output_format` deprecated. No recursive schemas, no numeric/length constraints, ≤20 strict tools, ≤24 optional params, 180s grammar-compile timeout, grammar cached 24h. | HIGH (platform.claude.com) |
| Claude Citations | All active models except Haiku 3. Plain-text → char indices; PDF → page numbers; custom-content → block indices. `cited_text` free on output. Works with prompt caching, token counting, batch. **Incompatible with Structured Outputs.** | HIGH (platform.claude.com) |
| Prefill removal | Last-assistant prefill → 400 on Claude 4.6+ and Mythos Preview. | HIGH |
| `effort` vs `budget_tokens` | `budget_tokens`/extended-thinking deprecated on 4.6+; use `effort` + adaptive thinking. | HIGH |
| Instructor | MIT, Pydantic-based, `from_provider("anthropic/…" | "google/…" | "openai/…")`, `max_retries`, validator re-ask, `InstructorRetryException`. | HIGH (useinstructor.com) |
| Existing client | `chat_json(response_schema=dict)` already implemented over OpenAI-compat `response_format:json_schema` + Gemini `responseSchema`; default model `gemini:gemini-3.5-flash`; **no Anthropic SDK path**; 180s timeout. | HIGH (repo: `jobhunter/llm.py`, `infrastructure/llm/llm_client.py`, `model_defaults.py`) |

---

## Sources

- platform.claude.com/docs/en/docs/build-with-claude/structured-outputs — `output_config.format`, model availability, schema limits, `messages.parse()`, incompatibility with citations (HIGH)
- platform.claude.com/docs/en/docs/build-with-claude/citations — document/citation request+response format, custom-content block granularity, Structured-Outputs incompatibility (HIGH)
- platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices — quote-first grounding, XML tags, long-context ordering, prompt chaining/self-correction, prefill removal, `effort`/adaptive thinking, anti-"AI slop"/positive-style guidance, "tell what to do not what not to do" (HIGH)
- python.useinstructor.com + python.useinstructor.com/concepts/retrying — Pydantic validators that reject and re-ask, value-in-source ("quote not found") validator example, `max_retries`, `from_provider` multi-provider support, thin-not-framework positioning (HIGH)
- Repo verification: `workers/automation/src/jobhunter/llm.py`, `infrastructure/llm/llm_client.py`, `model_defaults.py` — existing `response_schema`/`chat_json`, Gemini default, OpenAI-compat transport, 180s timeout, no Anthropic SDK (HIGH)

---
*Stack research for: grounded LLM resume-tailoring techniques on an existing Python httpx + Claude/Gemini structured-output pipeline*
*Researched: 2026-06-08*
