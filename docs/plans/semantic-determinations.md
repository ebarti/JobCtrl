# Semantic Heuristics Audit And LLM-Determination Plan

Date: 2026-10-06. Base: `main` @ `315aa3238`. Trigger: PR #1063 and
`workers/automation/src/jobctrl/domain/interview/question_generation.py`.

Paths below are relative to `workers/automation/src/jobctrl/` unless they start
with `apps/` or `packages/`.

## 1. Verdict

`question_generation.py` is the worst case, not an exception. JobCtrl decides
**what text means** with word lists, regexes, token overlap and hand-tuned
thresholds in 54 production files across Python and TypeScript. These
heuristics:

- silently drop jobs during discovery and soft-delete stored ones afterwards;
- reject generated resumes, cover letters, outreach drafts, interview prep and
  employer-analysis legs;
- block tailoring with hard blockers they invent from posting prose;
- set Gmail outcome suggestions with fixed confidences;
- choose which compensation evidence becomes the displayed estimate;
- write "seniority signals" into the canonical profile evidence table, where
  every later consumer treats them as user-authored facts.

The same fuzzy judgments are implemented again and again, and the copies
disagree with each other. Several exist in both runtimes:

- seniority: 10 classifiers with 7 different label sets, plus one 17-word
  "seniority signal" list copied 4 times;
- role family: 8 taxonomies;
- remote/work model: 13 marker lists;
- country/region: 8 gazetteers;
- same employer: 4 definitions;
- claim support and "reads like AI": 3 or 4 implementations each.

The repo already contains the correct pattern and a decision that mandates it
for one feature: `domain/profile/required_bullet_coaching.py` (85 lines) and
"Required-Bullet Coaching Uses LLM Determinations (2026-10-05)". The plan below
generalizes that decision to every semantic judgment.

Verification:

- Of the 80 critical and high candidates, an adversarial re-read confirmed 70
  (14 critical, 49 high, 7 medium), merged 9 as duplicates and refuted one:
  `ResumeAuditPins.tsx` line-kind parsing, which reads a layout the system
  rendered itself and is legitimate.
- The verifiers also spotted 15 further medium/low sites while reading.
- The 14 critical findings are in `question_generation.py`,
  `fabrication_detector.py` (2), `analysis_content.py`, `quality.py` (2),
  `requirement_coverage.py`, `compensation/benchmarks.py` (2),
  `title_filter.py` (2), `role_title_matcher.py`, `location_filter.py` and
  `config.py`.

## 2. Method And Coverage

- 18 readers covered every source directory: the Python worker (173k lines,
  including migrations), `apps/api`, `apps/web`, `apps/extension`,
  `apps/demo-edge` and `packages/*`. Each reader read its slice, followed the
  callers, and classified every deterministic site it examined.
- About 460 deterministic sites were examined and cleared as legitimate
  (section 4). The audit was never "count the regexes".
- 126 candidate findings came out (23 critical, 57 high, 37 medium, 9 low).
  An adversarial verifier re-read the code for every critical and high finding
  and tried to refute it first. Medium/low findings are sweep-level only and
  are marked as such.
- A docs/tests mapper listed every document that mandates or advertises the
  heuristics and every test that pins them. Three architecture reviews covered
  interview preparation, the materials gate stack, and the duplicated
  taxonomies.

Verdict definitions:

- **should_be_llm**: correctness depends on understanding meaning. The code is
  wrong in principle, not just buggy.
- **hybrid**: one legitimate mechanical check (ID membership, verbatim quote,
  exact number) wrapped around a semantic one. The mechanical part stays; the
  semantic part moves to a model.

## 3. Where Code Pretends To Understand Text

Grouped by the judgment being faked. Severity: **C** critical, **H** high,
**M** medium. Rows marked † are sweep-level only (medium/low, not re-verified).

### 3.1 Is this generated text true? (claim support)

| Where | What the code decides | Effect today |
| --- | --- | --- |
| `domain/interview/question_generation.py` (whole file) **C** | Whether a model-written sentence asserts the candidate's real history or is hypothetical, target-role or advice. About 67 regexes plus about 100 functions forming an English grammar (subject slots, modal operators, "reduced conditions", word-to-role tables). | Every heading, gap, probe and outline item is gated; a hit fails the whole prep. Pinned by about 500 hand-written sentences. |
| same file: title, authority, employer and C07 rules **H** | Title words ("staff", "principal"), `_AUTHORITY` words, `_QUERY_EMPLOYER` ("at/for" + capital), literal salary-guidance words. | Rejects "senior stakeholders", "staff turnover", "at Google scale" and "Get their band first and keep asking". Misses "led a team of 12" and "40 engineers reported to me". |
| `domain/materials/fabrication_detector.py` **C** | Whether a named technology is claimable: a 170-entry `KNOWN_TECHNOLOGY_LEXICON`, homograph list, 29-suffix stemmer. Whether a sentence claims a title (seniority lexicon matched anywhere). Whether a company is an employer claim (suffix list). | Hard-rejects resumes, cover letters, outreach drafts and interview prep. "Partnered with the VP of Sales", "Managed a staff of 12" and "Reported to the CTO" read as title fabrication. |
| `domain/materials/services.py` **H** | Skill and certification word lists (an older twin of the detector), assistant self-talk detection, cliché/AI voice. | Hard error in every mode: "Delivered swift incident response", "Spring 2023 launch", "guard rails". Costs retries and can exhaust the budget. |
| `domain/materials/quality.py` **C/H** | Prohibited claims by keyword; whether a pinned achievement is "represented" (two shared tokens after a stoplist that still holds one old posting's words: 'barcelona', 'orthodontics', 'smile'); whether the resume "shows seniority" (17 words matched as bare substrings, so "own" matches "down" and "led" matches "enabled"). | Each one is a hard error that rejects the candidate. Paraphrased false claims pass; legitimate paraphrases fail. |
| `domain/materials/analysis_content.py` **C** | Whether employer-analysis prose "narrates the process" (a grammar compiled into one regex). | Fails ensemble legs and, after retries, the whole employer analysis, which scoring requires. |
| `domain/contact/outreach_gates.py` **H** | Stock phrases, greeting and sign-off shape, dash bans, technology claims via the detector's lexicons. | Any hit makes a draft unapprovable, including drafts the user edited. |
| `domain/interview/preparation.py` **H** | Which evidence is relevant to a question (keyword plan); whether an excerpt shows direct management authority. | Decides the only facts the model may cite and labels authority in the prompt. |
| `apps/api/src/read-model.ts` **H** | At read time, additive text-similarity scores invent evidence links for changes the model never cited. | The tailoring explanation shows provenance nobody asserted and hides the "audit metadata incomplete" warning. |
| `apps/web/.../ResumeAuditPins.tsx` **H** | Which source a rendered line came from (substring and token overlap). Whether a judge finding refers to a line (prose overlap with pin fields). | Drives every Apply Review pin. A fabrication finding that does not textually overlap its line shows "line evidence" (OK). The status is persisted as `risk_label`. |
| `apps/api/src/resume-review-drafts.ts` **H** | Whether a user edit still contains "unsupported-claim language" or discouraged tone; why the user edited (fact vs policy vs style). | Refuses to render or promote drafts containing "fabricated prototypes". Edit intent selects which tailoring rule learning updates. |

### 3.2 How senior is this person or role?

The owner's literal example. About 12 independent implementations:

| Where | What | Effect |
| --- | --- | --- |
| `domain/materials/quality.py` `_target_seniority` **C** | Regex over title **plus the whole description**: "intern" anywhere means junior. | Injected into generator and judge prompts; arms the hard "Seniority mismatch" error; shown in the audit. |
| `profile_import.py` **H** | Track, seniority floor, functions and industries from resume keywords. | Seeds the new profile's targets, which drive discovery. |
| `resume_profile.py` **H** and `apps/api/src/profile-store.ts` **H** | `seniority_signal` and canned evidence strength on every achievement row, in both runtimes. | Persisted into `candidate_profile_achievement_evidence` on every profile save; downstream treats it as authored data. |
| `domain/profile/target_role_suggestions.py` **H** + `infrastructure/rpc/handlers.py` | Title-to-track/seniority grammar. Production passes `llm=None, allow_model=False`. | "Suggest target roles" is always keyword-derived, even with a model configured. |
| `discovery/title_filter.py` **C** | `_SENIORITY_RANKS` and track lexicons. | Recall-mode postings are dropped before the model is consulted. |
| `domain/compensation/benchmarks.py` **C**, `market.py` **H** | Level from title tokens; level "compatibility" scores. | Benchmark slice keys, which provider pages are fetched, and which rows set the displayed range. |
| `domain/interview/question_generation.py`, `fabrication_detector.py` | Title lexicons (see 3.1). | Rejections. |
| `apps/api/src/read-model.ts` **H**, `StructuredProfileEditor.tsx` † | `seniorityIds` display; free text mapped to track/seniority. | Audit completeness and profile UI. |
| `domain/scoring/eligibility.py` | Seniority/years grammar inside the "real hard constraint" regex (see 3.5). | Tailoring gate. |

### 3.3 Is this the same role, occupation or opening?

| Where | What | Effect |
| --- | --- | --- |
| `discovery/title_filter.py` **C/H** | Strict mode: synonym tables, stopword stripping, one-extra-token window. Recall mode: lexicons. Business-function reject list ("Sales Engineer"). | Main admission gate for every source family; rejects happen before any model call. |
| `discovery/role_title_matcher.py` **C** | Lexical fallback when the model is disabled, not ready, under pytest, or errors. | Without a model, every non-verbatim title is accepted; with an erroring model, it is rejected. |
| `infrastructure/discovery/production_wiring.py`, `ats_adapters.py` (folded into `title_filter.py`'s rows) | Admission policy (title filter plus geography, with the **title** concatenated into the location evidence) and per-adapter copies. The adapters' title half never runs in production, because they are called with an empty query. | Intake drops, plus retroactive soft-delete of stored jobs in discovery hygiene. |
| `discovery/target_queries.py` **H** | Track, seniority and "adjacent titles" from the user's free-text target role. | Defines which board queries run at all. |
| `domain/compensation/benchmarks.py` **C**, `market.py` **H**, `infrastructure/compensation/levels_fyi_public.py` **H** | Occupation family from phrase rules; Jaccard role similarity floored at 0.55; Levels.fyi job-family slug. | Gate for the entire market-benchmark feature, and the evidence behind the displayed range. |
| `domain/apply/repeat_application.py` **H** + `apps/api/src/repeat-application.ts` **H** | "Materially equivalent role" at the same employer (both runtimes). | Forces confirmation before a live apply. |
| `domain/job_content_identity.py` **H**, `scoring/scorer.py` **H** | Shingle similarity merges distinct openings; agency-repost detection; the repost reuses another posting's score. | Distinct jobs never get scored; reposts show another job's rationale. |
| `apps/api/src/discovery-controls.ts` **H** | "Scored low because of the role" (regex over rationale). | Generates exact-title exclusion suggestions. |

### 3.4 Where is this, and is it remote?

| Where | What | Effect |
| --- | --- | --- |
| `config.py` **C/H** | Free-text target location turned into a system-authored gazetteer of accept/reject strings; "prefers Europe" and "Americas-only source" by substring (`canada`, `dice`, `' eu'`). | Every discovery run filters on it. Whole sources vanish from the registry with no event. Users in Eugene OR, Euless TX or Eureka CA are treated as preferring Europe. |
| `infrastructure/discovery/location_filter.py` **C/H** | `REJECT_ALIASES` (50 states and codes), `ACCEPT_ALIASES` ("europe" means 7 tokens), remote markers. | Hard admission gate and retroactive soft-delete. "Barcelona (teletrabajo)" is treated as on-site. |
| `domain/compensation/market.py` **H**, `levels_fyi_public.py` † | Location "compatibility" scores; Levels.fyi location route. | Which rows set the estimate. |
| `domain/profile/target_role_suggestions.py` **H** | Experience location strings mean place or work model. | Seeds target locations. |
| `domain/scoring/services.py` † | On-site-only and location containment from prose. | Scoring constraints. |
| `infrastructure/projections/location_normalization.py` + `apps/api/src/location-normalization.ts` †, migrations † | Remote detection for display labels, also baked into migrated rows. | Labels. |

### 3.5 What does this posting or prompt require or forbid?

| Where | What | Effect |
| --- | --- | --- |
| `domain/scoring/eligibility.py` **H** | Re-reads the **scoring model's** blocker sentence with three lexicons to decide whether it is "compensation-only advice" or a real constraint. | Decides whether Tailor/Cover run or the job is parked as `SCORE_ELIGIBILITY_BLOCKED`. |
| `domain/scoring/services.py` **H** | "Sponsorship unavailable" phrases mean a HARD blocker; exclusion phrases captured from the user's free-text criteria by regex, then substring-matched against postings. | Hard-blocks jobs regardless of context. |
| `domain/materials/requirement_coverage.py` **C** | About 45 regexes reclassify requirement scope (resume vs eligibility/logistics/employer condition), overriding the model's declaration. | Moves requirements out of the generation prompt and turns them into prohibited claims. |
| `domain/materials/analysis_eeo_screen.py` **H** | Protected-class regex. | Removes requirements from the canonical analysis before persistence. |
| `apps/extension/src/content-script.ts` **H** | Which saved profile fact an employer form question asks for; which option means the saved answer. | Autofill proposals. |

### 3.6 What does this page, email or agent report mean?

| Where | What | Effect |
| --- | --- | --- |
| `infrastructure/gmail/feedback.py` **H** | Outcome class (offer, rejection, interview...) by phrase lists with fixed confidences (0.95/0.9/...); header relevance scored by keywords with a 0.70 cutoff. | Writes outcome suggestions shown on the dashboard. "Congratulations on completing the assessment – unfortunately we are not moving forward" becomes an **offer** at 0.95. Emails below 0.70 are silently dropped. |
| `domain/enrichment/snapshot_services.py` **H** | "Posting closed" from a 10-phrase list; login wall; Apply button; description "trust bucket". | Persists availability verdicts, quarantines jobs, and gates tailoring. |
| `apply/launcher.py` **H**, `infrastructure/apply/claude_code_cli.py` † | Whether the apply agent's prose describes a permanent or transient failure; terminal result class. | Sets `retryable` and `next_action`. |
| `profile_import.py` **H** | Resume structure: headers, role lines, bullets, companies. | Produces the whole imported draft. |
| `infrastructure/compensation/sqlite_repository.py` **H**, `domain/compensation/posted.py` **H** (hybrid) | Which sentence states pay; what the numbers mean (period, base vs OTE, floor vs ceiling). | The posted-compensation fact for most ATS jobs. |
| `discovery/job_url_import_workflow.py` † | Page state (bot wall, listing vs posting) from prose. | URL import outcome. |

### 3.7 Does this read well?

| Where | What | Effect |
| --- | --- | --- |
| `domain/materials/voice_metrics.py` **H** | AI-isms and buzzwords lexicon "delta". | Accepts or discards the entire LLM voice pass. |
| `domain/materials/services.py` **H**, `domain/materials/use_cases.py` †, `domain/contact/outreach_gates.py` **H** | Cliché lists and stock phrases. | Rejections and warnings. |

### 3.8 What is relevant, and why was this line written?

| Where | What | Effect |
| --- | --- | --- |
| `domain/scoring/retrieval.py` **H** | Vocabulary overlap with the resume ranks the pending pool. | With `--limit`, only the top-N by word overlap get scored. |
| `domain/materials/provenance_builder.py` **H** | Which requirement each shipped line serves and the human-readable reason, by keyword. | Canonical `job_bullet_provenance` rows behind the audit chips and the "N/M covered" audit. |
| `infrastructure/analysis/ensemble.py` † | Whether ensemble drafts "agree" on a requirement (string equivalence). | Divergence flags. |

## 4. Legitimately Deterministic (Keep)

These were examined and are correct uses of code, because correctness does not
depend on understanding meaning:

- **Structured parsing**: ATS/JSON-LD/`__NEXT_DATA__` payloads, Levels.fyi's
  fixed Markdown format, HTML-to-text, DOM noise stripping before prompts
  (`discovery/smartextract.py`, `discovery/workday.py`,
  `infrastructure/compensation/levels_fyi_public.py` parsers), and numeric,
  currency and explicit-period token parsing (`domain/compensation/posted.py`
  `_AMOUNT_PATTERN`, `/hr`, `/yr`).
- **Security and privacy rails**: `infrastructure/network/*` (URL safety,
  robots, proxy grammar, Retry-After), `native_credentials.py`, and redaction
  blocklists in `infrastructure/projections/projection_builder.py`.
- **Identity**: canonical-field normalization for hashes
  (`domain/job_content_identity.py` `normalize_identity_text`), exact
  identity-key collisions (`discovery/jobspy.py`), and enumerated board
  sentinels.
- **Structural checks on model output**: verbatim quotes must exist in the
  shipped text, cited IDs must be in the supplied set, and location IDs must
  map to bullet IDs (`domain/materials/claim_grounding.py`). This is the right
  verifier primitive and stays.
- **Arithmetic over model verdicts**: `domain/scoring/requirement_fit.py`
  (weights, caps and bands over the model's typed per-requirement verdicts),
  and score banding in projections.
- **Provider errors**: `infrastructure/llm/provider_errors.py` classifies by
  enum, type name and HTTP status, with an exact-string allowlist.
- **Rendering**: `infrastructure/materials/html_resume_pdf.py`, location
  display codes, and code-to-copy tables keyed by structured warning codes.
- **Projection enum maps**: the 27 set literals in
  `projection_builder.py` are code-to-message and state-machine tables, not
  text understanding. The pipeline/projections slice produced zero findings.
- **Literal user-authored filters** executed literally, such as approved exact
  title exclusions.

## 5. Architecture

### 5.1 Interview preparation: spaghetti

- **Size.** The family is 3,609 lines, and `question_generation.py` is 67% of
  it. About 1,960 of its 2,423 lines (81%) are a grammar engine:
  - 58 functions and 17 private parse-witness types;
  - 67 module-level regexes, 50 more inline regexes, 12 word-to-role lexicon
    dicts and 48 inline word sets.
  - The longest functions: `_account_request_attachment` (138 lines,
    recursive, returning 9 untyped tuple variants that callers read by
    position), `_personal_content_bindings` (128), `_generic_property_binding`
    (119, a six-way branch explosion over whole-sentence templates).
- **It was fitted to test sentences.** The entire engine landed in one squashed
  commit (#994, 2026-10-04) already at `GATE_VERSION` v29. Some lexicons exist
  for exactly one test phrase: `_account_criterion_operand` requires the three
  trailing tokens `that ended badly`, from the test sentence "ideally a
  well-reasoned choice that ended badly?".
- **It borrows resume gates by faking a resume.** It wraps excerpts as
  `{"resume": {"experience_entries": [{"id": "selected", ...}]}}` and runs the
  resume title and technology scanners on them. Grounding goes through the
  resume-coverage adapter with sentinel values, so it always falls back to a
  text scan.
- **The grounding check it relies on is broken.** `_claim_binds_line` accepts
  `padded_line in padded_claim`, so a claim containing a whole excerpt **plus
  invented content** counts as grounded. The prompt promises facts are exact
  excerpts; the code does not enforce it.
- **The only model check is not a real judge.** It is the resume adversarial
  review prompt reused, run only after the regex gate passes, and it returns a
  thresholded score. No per-proposition determination is persisted.
- **Plumbing defects**:
  - The activity runs selection and evidence planning, discards the result, and
    the use case runs them again.
  - `execute` has five near-identical ten-argument `_fail` calls.
  - Typed findings are re-split by the substring `"fabricat"`.
  - There are unused parameters (`profile`, `evidence_entries`) and dead code
    (`_own_proposition_ends`).
  - Selection bounds are duplicated with hard-coded numbers across Python and
    `packages/contracts`.
- **Layering.** Interview imports Materials internals (`fabrication_detector`,
  `claim_grounding`, `requirement_coverage`, `services`) and another context's
  use-case module, so tuning a resume lexicon silently changes interview
  outcomes.
- **Test burden.** 1,838 test lines (44 tests, about 533 English sentence
  literals) pin the parser. They import private symbols and assert character
  offsets and tuple layouts. Every new model phrasing adds cases.

The sound parts stay: `catalog.py`, `evidence.py`, selection fencing,
generation context and digest, the response schema, and the structural checks
in `question_items_from_candidate`. The target (section 7) leaves about 150
lines of determination code in place of the grammar.

### 5.2 Materials gate stack: spaghetti

- **Size.** 6,379 lines across seven modules:
  - `quality.py`: 1,890 lines, 70 functions.
  - `requirement_coverage.py`: 1,857 lines, 45 English regexes.
  - `fabrication_detector.py`: 1,005 lines, about 190 technology terms, 21
    homographs, a 29-suffix stemmer.
  - `services.py`: 620 lines, with `BANNED_WORDS` (58), `LLM_LEAK_PHRASES` (38)
    and `FABRICATION_WATCHLIST` (19).
  - `provenance_builder.py` and `voice_metrics.py` make up the rest.
- **God modules.** `quality.py` mixes plan building, budget feasibility, prompt
  serialization, the quality gate, rationale templates, a claim-collision
  corpus and about 15 text primitives that other modules import as private
  names. `requirement_coverage.py` mixes eight concerns, including
  hand-rolled validation that pydantic should do.
- **About 300 lines of `requirement_coverage.py` are dead.** The coverage
  planner schema and prompt, `validate_coverage_graph`,
  `validate_metric_support` and `validate_prohibited_claims` are referenced
  only from tests.
- **Contradictory sources in one prompt.** The plan carries both
  `_target_seniority` (regex over title and description) and the employer
  analysis's model-inferred seniority, and both are serialized into the same
  generator prompt.
- **Coverage gets laundered across modules.** Bare-substring seniority terms
  mark nearly every evidence item as "seniority evidence".
  `provenance_builder` binds those IDs and keyword-matched requirement IDs onto
  every bullet, and the fit report then counts a requirement "covered" from any
  such link. The model-grounded links and the keyword links are unioned, so
  the audit cannot tell them apart.
- **Wrong in both directions.**
  - The title gate grounds title words against title words anywhere in profile
    prose, so "presented to senior stakeholders" grounds a fabricated "Senior"
    title.
  - `_BENIGN_NUMERIC_TOKENS` exempts 0 to 5, so an invented "led a team of 5"
    is never checked.
  - `FABRICATION_WATCHLIST` rejects "spring 2024 launch" when the candidate
    lacks Spring.
- **Duplicate implementations of the same idea**:
  - prohibited claims: 3;
  - metric grounding: 3;
  - skill fabrication: 2, plus a third use in outreach;
  - "reads like AI": 4 lists, plus a loop re-implemented in outreach;
  - requirement-to-line binding: 2 channels unioned;
  - rationale templates: 2.
- **Test burden.** About 5,700 test lines across seven files pin this slice,
  and roughly 45% of them pin heuristics or dead code.

`claim_grounding.py` is the healthy shape here: the model declares, code binds
IDs and checks verbatim text. The target keeps it and its exact-number check,
without the benign-number exemption, as the mechanical arm of claim
verification.

### 5.3 Duplicated taxonomies: spaghetti

The same fuzzy taxonomies are reimplemented across 22 files (28,350 lines; 16
Python, 6 TS):

| Taxonomy | Independent copies | How they disagree |
| --- | --- | --- |
| Seniority ladder | 10 classifiers, 7 different label sets | "head" is rank 6, `senior_manager` or `director` depending on the copy. "lead" is IC, management, `staff_plus`, unknown or a literal "Lead". "Senior Manager" is `senior_manager`, manager or senior. Benchmark "entry" becomes "mid" in market. `title_filter.py` contradicts itself: "head" is rank 6, but its alias "head of engineering" ranks 5. |
| Track (IC/management/executive) | 5 | `target_role_suggestions.py` has two tables that disagree with each other; the web editor's TS mirror has drifted from the worker's aliases. |
| Role family / domain | 8 | `benchmarks._ROLE_RULES`, `market.ROLE_FAMILY_MARKERS` and the 24 Levels.fyi regexes classify the same title differently. |
| Remote / work-model markers | 13 lists | Different members everywhere; display adds `remoto`/`teletrabajo`, scoring lacks `anywhere`. |
| Country / region gazetteers | 8 | Config knows 45 European countries; `location_filter`'s "europe" expands to 4 tokens; market's `EUROPE_MARKERS` has 30. |
| Same employer | 4 definitions | Different legal-suffix lists and thresholds, so "Acme Corp" matches in one place and not another. |

Each copy drives a different decision: discovery admission, query planning,
suggestion vetoes, import seeding, compensation rows, Levels.fyi pages, editor
chips, evidence flags and repeat-apply confirmation. The copies have already
drifted, so the product disagrees with itself about who a job is for.

Two more structural problems:

- `title_matches_query` looks like a pure predicate but opens SQLite behind a
  module-global cache that swallows every exception.
- Under pytest, the "auto" mode silently switches the model off.

The target is one owner of codes (section 7.4) and one determination per
entity (section 7.3). No copies remain.

### 5.4 Cross-cutting patterns

1. **The model writes, regex judges.** Gates on LLM output reject correct text
   and pass wrong text. Each false positive gets a new special case; false
   negatives stay invisible. Interview, materials, analysis, outreach and
   scoring eligibility all have this shape.
2. **Silent deterministic fallbacks.** `role_title_matcher` accepts everything
   when the model is off and rejects when it errors. Target-role suggestions
   are hard-wired to the keyword branch in production. Both contradict the
   coaching decision ("no lexical fallback").
3. **Heuristic output persisted as fact.** `seniority_signal` and canned
   evidence strength are written into the canonical evidence table by both
   runtimes, and Apply Review's `risk_label` comes from text overlap. Later
   consumers cannot tell inference from data.
4. **Read-time inference.** The TS read model and Apply Review UI rebuild
   provenance by text similarity because generation did not record anchors.
   This breaks the Auditability rule that every displayed claim has an explicit
   source of truth.
5. **One judgment, many copies.** Seniority, role equivalence, geography and
   claim support each live in about 8 to 12 places across two runtimes and
   disagree. Fixing one copy changes nothing elsewhere.

## 6. PR #1063

The PR mixes a correct fix with more of the problem:

- **Keep**: drafting each question separately with only its own evidence
  (`domain/interview/use_cases.py` loop; `question_generation_prompt` strips
  other questions' evidence). That closes the cross-question evidence leak in
  #1045 and does not depend on the grammar engine.
- **Do not merge**: `_EXPECTED_ROLE_RESPONSIBILITY` and the new
  "prospective speech act" regex in `_property_input_binding`. They are the
  30th patch to the gate (`GATE_VERSION` v29 to v30), each one added because a
  real model output tripped the grammar. The version counter is the history of
  the approach failing.

Recommendation: land the isolation as its own change, without the grammar
edits, or fold it into the interview rewrite in section 8. Merging the rest
entrenches the grammar engine further.

## 7. Target State

### 7.1 The rule

Any decision whose correctness depends on understanding meaning is an **LLM
determination**. That covers the meaning of a posting, a resume, a profile,
generated text, an email, a web page, an agent's report, or the user's own free
text. Code never creates, suppresses, upgrades or downgrades such a decision,
and never stands in for it when the provider is unavailable.

Code keeps everything mechanical:

- canonical source binding and ID membership;
- verbatim-quote existence and exact number, date and currency equality;
- schema and enum validation, and version fencing;
- identity keys built from canonical fields;
- arithmetic over typed verdicts;
- security rails, structural parsing and rendering;
- literal execution of filters the user typed.

### 7.2 What a determination is

Every determination has the same shape as `required_bullet_coaching.py`:

- **Input**: a minimized canonical payload of IDs and texts. It never dumps
  free-form context.
- **Output**: a pydantic model with `extra="forbid"` and closed enums. Every
  judgment cites the source IDs and verbatim spans it rests on, plus a short
  rationale.
- **Call**: `LlmPort.chat_json(response_schema=...)`, inside a Temporal
  activity or a sync RPC handler for interactive features. It is bound to a
  lane in `llm_lanes.py` and checked by the spend preflight (BR-050) first.
- **Mechanical validation**: IDs must be in the supplied set, quotes must be
  verbatim in the source, numbers must be exact, enums must be members. A
  failure raises an error that carries no private text.
- **Persistence with provenance**: determination kind, schema version, prompt
  version, provider and model, input fingerprint and the typed result. It is
  cached by fingerprint and versions, so re-runs do not spend again.
- **Failure**: provider unavailable, budget denied or invalid output blocks the
  stage with a distinct, actionable status. The last accepted artifact stays.
  There is no lexical fallback, and the offline demo reports the capability
  unavailable.
- **Read side**: the TS API, web app and extension only read persisted
  determinations and join by ID. Nothing infers meaning at read time.

### 7.3 A few shared determinations replace about 60 copies

Meaning is computed once per entity, and every consumer reads it:

1. **Posting triage** (high volume, at intake). Inputs are the user's confirmed
   target profile and a batch of listing rows (title, location, company,
   structured remote flag). Output per row is admit, reject or uncertain, with
   reason codes. Batched, cached, on the discovery lane. Rejected rows are
   persisted and visible. Nothing is soft-deleted later by a lexicon. If the
   provider is unavailable, rows wait as `pending_triage`; they are never
   admitted or rejected by keyword.
2. **Job interpretation** (per job snapshot, alongside or inside employer
   analysis). Each field carries its verbatim span:
   - track, seniority level, occupation family and work model;
   - locations as structured place codes;
   - eligibility constraints (sponsorship, clearance, citizenship, language);
   - posted compensation (amount, currency, period, component);
   - requirement scope (resume, eligibility, logistics, employer condition);
   - protected-class flags.

   Its consumers are scoring constraints, requirement coverage, tailoring's
   target seniority, compensation slicing, repeat-application checks,
   interview framing and display labels.
3. **Candidate interpretation** (per profile version, on import and save). It
   produces track, seniority, functions, target-role suggestions with evidence
   IDs, and locations and work models drawn from experience. Resume import
   becomes an extraction determination into the profile schema, with a span
   per field. The output is a **suggestion the user confirms**. Nothing
   heuristic is written into evidence rows as a fact again.
4. **Claim verification** (per generated artifact: resume, cover letter,
   outreach, interview prep, employer-analysis prose). Generators return
   structured claims tied to evidence IDs. A verifier call extracts every claim
   from the final text and classifies it as candidate fact, hypothetical,
   target-role or employer statement, or advice. It judges support against the
   supplied evidence, citing evidence IDs and verbatim spans, and applies
   rubric items for the artifact type: voice, model self-talk, C07 negotiation
   guidance, process narration, and prohibited claims from the fit report. Code
   checks the citations; anything unsupported feeds the existing repair loop.
5. **Line provenance recorded at generation time**. Generators emit a per-line
   anchor: line ID, evidence IDs, requirement IDs, transform type and reason.
   Verifier findings carry line IDs. The UI joins by ID. A line with no anchor
   says "no recorded source"; nothing guesses one.
6. **Message, page and report interpretation**:
   - **Gmail**: a linking determination across candidate applications in a
     bounded window, then an outcome classification with a closed enum and a
     verbatim quote. Exact recipient, date, thread and domain checks stay code.
   - **Pages**: an availability determination over the rendered page. HTTP
     status and URL identity stay code.
   - **Apply agent**: returns a typed terminal result.
   - **Extension autofill**: a mapping from form question to profile fact that
     the user confirms.
7. **Benchmark matching**. Each provider row's title, level and location gets a
   cached classification into the same codes the job interpretation uses.
   Matching is then code equality plus arithmetic. The Levels.fyi family comes
   from a static code-to-slug table.
8. **User free text** (exclusion criteria, target location) is interpreted once
   into structured preferences the user confirms, then matched by code against
   job interpretations. Literal exact filters stay literal.

Nothing ranks by vocabulary overlap. With `--limit`, order is mechanical
(recency or source priority) or the triage result.

### 7.4 One taxonomy, codes only

One versioned taxonomy holds codes and labels for track, seniority, occupation
family, work model and region. It is shared by Python and TS through
`packages/contracts`, and contains no synonyms, aliases or regexes. The model
maps text to codes; code compares codes.

### 7.5 Shape of the code afterwards

- Each determination lives in its owning bounded context: triage and job
  interpretation in Discovery/Enrichment, candidate interpretation in Profile,
  claim verification in Materials. Outreach and Interview call the claim
  verifier through a port; neither imports Materials internals.
- One thin shared helper covers call, validate, error without text, and the
  provenance envelope. It is not a framework.
- `question_generation.py` shrinks to prompt construction, structured parsing
  and citation checks. The grammar engine and its sentence corpus are deleted.
- `fabrication_detector.py`, `voice_metrics.py`, `analysis_content.py`'s
  grammar, the semantic parts of `quality.py`, `services.py`,
  `requirement_coverage.py` and `provenance_builder.py`, and all TS read-time
  matching collapse into claim verification and generation anchors.
  `claim_grounding.py`'s verbatim and ID checks stay as the verifier
  primitive.
- Python/TS twins (`repeat_application`, seniority signals, location labels,
  edit intent) disappear; both runtimes read one persisted determination.

## 8. What Needs To Change

These are areas, not steps. Each area is rip-and-replace, with no dual paths.

- **Contract**:
  - Add a decision, "Semantic Judgments Are LLM Determinations", that
    generalizes the 2026-10-05 coaching decision.
  - Amend the Interview Preparation decision: its gates become claim
    verification.
  - The Requirement-Fit Ledger decision stands, since it is arithmetic over
    model verdicts, but requirement scope now comes from the interpretation.
  - Add an `AGENTS.md` rule: regex is for formats, never for meaning.
  - Generalize the coaching paragraph in the regression catalog's
    Auditability Checks to every determination.
  - Update every owning doc the mapper lists (section 9.1).
- **Interview**: delete the grammar, its sentence tests and the keyword
  evidence planner. Keep per-question isolation. Prep is checked by claim
  verification with the C07 rubric.
- **Materials**: replace the technology/title/company lexicons, stemmer,
  self-talk, cliché and voice lexicons, the seniority and representation
  gates, prohibited-claim keywords, requirement-scope regexes, EEO regexes and
  keyword provenance linking with claim verification, generation anchors and
  the job interpretation.
- **Scoring**: the scoring model returns typed blockers (category plus span);
  delete `eligibility.py`'s re-reading of the model's prose. Constraints come
  from the job interpretation matched against confirmed preferences. Delete
  overlap ranking.
- **Discovery**: replace title lexicons, alias tables, the lexical fallback,
  keyword query expansion, the location gazetteer, substring source removal,
  per-adapter filter copies and lexicon-driven retroactive soft-deletes with
  posting triage and a query-plan determination built from the confirmed
  target profile. Adapters only fetch and parse.
- **Enrichment and identity**: availability and description quality become
  determinations. Duplicate merging and repost score reuse require exact
  identity or a duplicate determination over identity-key candidates.
- **Compensation**: occupation, level and location matching come from codes.
  Pay-in-prose becomes an extraction determination with exact number checks.
- **Profile**: resume import and track/seniority inference become extraction
  plus candidate interpretation. Delete `seniority_signal` and canned evidence
  strength in both runtimes and purge their persisted values. Target-role
  suggestions use the model in production.
- **Apply and feedback**: Gmail linking and classification, apply-failure
  interpretation, repeat-application equivalence (one runtime) and extension
  form mapping become determinations.
- **TS read side and demo**: `read-model.ts`, `ResumeAuditPins.tsx`,
  `resume-review-drafts.ts`, `discovery-controls.ts`, `profile-store.ts` and
  `StructuredProfileEditor.tsx` read persisted determinations by ID. The demo
  reports affected capabilities unavailable; it never re-implements
  heuristics.
- **Data**: an exact-schema version bump for determination storage, following
  the existing native migration boundary. Heuristic-derived persisted values
  are purged and recomputed.
- **Tests**: delete tests that pin lexical behavior, including the hand-written
  sentence corpora. Add model-authority tests (section 9). No eval sets or
  baseline comparisons: the model's judgment is the point, not something to
  re-litigate with fixtures.

## 9. Validation

### 9.1 Contract and docs

The docs mapper found 41 statements that mandate or advertise deterministic
handling of a semantic judgment. Each must be rewritten to describe the
determination, with code keeping only binding and validation:

- **`docs/decisions.md`**:
  - Application-Outcome Feedback Loop ("deterministic v1 classification").
  - Resume Tailoring Quality ("deterministic quality checks").
  - Generated-Materials Audit (keyword coverage).
  - Cross-Source Deduplication (content similarity).
  - Interview Preparation (gates).
  - Confirmed Facts And Canonical Identity (role normalization for repeat
    applications).
  - Add the new decision alongside the 2026-10-05 coaching decision.
- **`docs/architecture/tailoring.md`**: the gate table, Validation Layers 2, 5,
  6 and 10, and the Tailoring Plan's `target_seniority` and
  `seniority_evidence_ids`.
- **`docs/architecture/materials.md`**: the employer-analysis grounding gate,
  "Deterministic Truthfulness Gates", interview proposition grounding, and the
  voice pass.
- **`docs/architecture/scoring.md`** and
  **`docs/architecture/pipeline/stages.md`**: lexical retrieval preselection,
  and recall queries enforcing track and seniority.
- **`docs/architecture/domain-model/strategic.md`**, plus `tactical.md`:
  deterministic tailoring quality checks.
- **`docs/api/complete-contract.md`**:
  - target-role suggestions (the production "no provider call" note);
  - deterministic recall expansion;
  - deterministic interview selection;
  - the voice-pass audit fields.
- **`docs/requirements.md`**: BR-056, "deterministic profile-backed autofill
  suggestions".
- **User docs**: `discovery.md` (role title filtering modes, seniority floors,
  suggestions), `enrichment-and-extraction.md` (the 0.85 token-Jaccard
  duplicate rule), `outcomes-and-feedback.md` ("does not ask a model to read
  the inbox"), `materials-and-tailoring.md`, `compensation-evidence.md`,
  `contacts-and-outreach.md`, `normal-flows.md`, `security.md`, and
  `getting-started.md`.
- **Guides and comparison**: `resume-tailoring-without-fabrication.md` and
  `comparison.md` ("deterministic fabrication and claim-grounding gates").
- **QA docs**: generalize the regression catalog's Auditability Checks and add
  a section to `local-reliability-qa.md`, alongside the existing
  Required-Bullet Coaching section.

About 24,800 lines across 34 test files pin heuristic behavior. Their fate:

- Delete the lexical pins and the sentence corpora:
  - interview operator, prose-classifier, review and framing sentence tables;
  - `test_content_validator.py`;
  - the requirement-scope regex cases;
  - the title-filter and location alias cases;
  - the classification tables in `test_gmail_feedback.py`;
  - EEO and analysis-narrative minimal pairs;
  - and similar.
- Re-drive the behavior tests with a fake `LlmPort` that returns the verdicts
  under test: materials use cases, interview generation, outreach gates, repeat
  application, availability.
- Keep structural tests as they are: claim grounding, HTTP/identity/lease
  checks, numeric parsing, schema validation.

### 9.2 Proof that the code no longer decides

For every determination, using a fake `LlmPort`:

- The same input with two different valid model decisions produces two
  different outcomes. This is the coaching QA rule and proves no code path
  decides on its own.
- Each failure mode fails distinctly, with no heuristic fallback, and preserves
  the last accepted artifact:
  - provider unavailable;
  - budget denied;
  - malformed JSON;
  - schema violation (extra field, unknown enum);
  - a foreign ID;
  - a non-verbatim quote;
  - a mismatched number.
- The captured prompt contains exactly the canonical sources: for example,
  per-question evidence isolation and no other question's evidence.
- The lane binding and spend preflight run before the call.
- One-off deletion proof at PR time: `rg` finds none of the removed symbols
  (`KNOWN_TECHNOLOGY_LEXICON`, `SENIORITY_SIGNAL_TERMS`, `_target_seniority`,
  `REJECT_ALIASES`, `ACCEPT_ALIASES`, `_SENIORITY_RANKS`, `_TOKEN_ALIASES`,
  `_CLOSED_MARKERS`, the Gmail phrase table, the `question_generation.py`
  grammar). This is a PR acceptance check, not a permanent shape test.

### 9.3 Product-path QA (risk tier 2/3, owned synthetic workspace)

These checks prove wiring, persistence, visibility and failure handling. They
do not grade the model's judgment.

- **Discovery**: run a target profile against a seeded listing batch.
  - Every admit and reject decision comes from a persisted triage
    determination with its reason code, and the user can see it.
  - No job is dropped or soft-deleted without one.
  - With the provider off, rows sit in `pending_triage`.
- **Tailoring, cover letter, outreach, interview prep**: each generated
  artifact has a persisted claim-verification determination. An unsupported
  verdict drives the existing repair/fail path with the cited reason, and a
  failed refresh keeps the last accepted artifact. Interview prep keeps
  per-question evidence isolation: an explicit empty selection yields gaps,
  never another question's evidence.
- **Profile**: import and save produce candidate-interpretation suggestions
  the user must confirm. Nothing is written into evidence rows unconfirmed.
- **Gmail**: outcome suggestions come from the determination with a verbatim
  quote. With the model off, no suggestion appears and the status says
  unavailable.
- **Compensation**: the displayed estimate cites rows matched by taxonomy codes
  from persisted classifications.
- **Apply Review**: every pin joins by line ID; judge findings land on their
  line IDs; unanchored lines say so.
- **Offline demo**: affected capabilities report unavailable.

### 9.4 Auditability, cost and runtime

- An auditability fixture per surface: every displayed judgment traces to a
  persisted determination with prompt version, model, input fingerprint and
  cited IDs (regression catalog, Auditability Checks).
- Spend:
  - A synthetic discovery run of N listings records batch count, cost and
    latency.
  - A re-run with unchanged inputs makes zero new calls.
  - A spend-ceiling denial shows its own actionable status.
- Determinations run only in activities, and Temporal replay tests pass on
  persisted results.
- `rg` over the TS read side finds no text-similarity matching left for these
  judgments. Contract tests cover the determination read shapes.

## 10. Owner Decisions

1. **Discovery triage economics**: batch size and model per lane, and whether
   to triage at intake (titles only) or admit everything and interpret after
   fetch.
2. Whether claim verification is folded into the existing judge call or runs
   separately (separate schema either way).
3. Offline demo: confirm "unavailable" for every affected capability (the
   coaching precedent).
4. Ensembles: BR-058 makes one ready provider sufficient. Should any
   determination besides employer analysis use an ensemble?
5. **Priority (a ranking, not a sequence)**:
   - First: truthfulness gates. They reject correct material and miss real
     fabrication, and this is where the trigger came from.
   - Second: discovery admission, which silently loses jobs.
   - Third: candidate and job interpretation, which removes the seniority and
     geography copies.
   - After those: compensation, Gmail and page state.


## Confirmed owner choices (2026-10-06)

- Triage at intake. Default batch size 20, configurable; use the configured Discovery provider/model.
- Keep the artifact-quality judge and add a separate structured claim-verification call.
- One configured provider per new determination. Employer analysis retains its existing optional ensemble; one ready provider remains sufficient.
- Affected offline-demo capabilities report unavailable.
- Priority: truthfulness, discovery, candidate/job interpretation, then compensation, Gmail and page state.
- No eval sets, labeled corpora, recorded-output replay fixtures or lexical fallbacks.
- Merge and release require scoped owner authorization.
