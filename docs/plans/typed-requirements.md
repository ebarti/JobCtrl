# Typed job requirements

Status: implemented; final hosted qualification pending. The accepted contract,
source-bound regression, affected application journeys, documentation and rendered
UI have been exercised. The complete 100-case inventory remains subject to the
three required hosted shards. No production rollout or release is claimed.

## Product contract

Job matching serves two purposes: assess the person's fit and choose effective,
truthful achievement wording. Extraction must preserve the distinction between
those purposes.

- The reusable catalog contains Skills and Professional Experience only.
- Education and Languages are job-local demands. They do not enter the reusable
  catalog, semantic matching, or achievement-wording generation.
- Skills can be supported by structured Profile Skills and factual roles or
  achievements. Experience uses factual roles and achievements. Education uses
  Education records; an explicitly offered equivalent-experience alternative
  may use professional experience, with that route recorded without asserting a
  degree. Languages use structured Language / Proficiency records only.
- Personal traits, certifications and licenses, job conditions and detailed
  years-of-experience analysis are excluded from this iteration. Structured
  certification support is tracked separately.
- Non-English postings are identified by a source-bound model decision before
  requirement extraction. They are skipped, not translated or given zero fit.
- Retain source excerpts, source-bound notes and meaningful alternatives. Do not
  generate importance weights, mandatory labels or an entry for every task.
- Compare the complete incoming Skills/Experience batch with the entire active
  catalog in one prompt. Reuse equivalent meanings, including ordinary facets
  of one competence, without collapsing materially different capabilities.
- Qualify all missing items together, using reusable current assessments when
  valid. Every judgment must cite permitted sources. No lexical fallback.
- A current section-backed match does not create an achievement-wording gap.
  Reuse existing approved wording. New wording requires an actual unsupported
  wording need and factual achievement support; do not rewrite already-covered
  requirements for stylistic variation.
- Tailoring preserves all baseline sections and achievements, changing only
  approved achievement wording. One wording may cover several requirements.
- Refresh of affected matches is a manually started, bounded operation. Profile
  edits and ordinary reads never start cascades of model work.

## Contract generation and history

New JSON documents use `contract_version: requirements-v2`. Missing versions are
legacy. Existing SQL schema strings remain byte-identical; the application's
schema digest rejects edits to those strings. New canonical IDs are namespaced.
The active catalog starts empty and reads only the current generation. Never
promote old meanings merely because their fields resemble the new contract.

Carry the generation through snapshots, occurrences, assessments, scores,
operations, model identities, publication guards and currentness checks. Reject
resumption/replay of incompatible operations. Preserve historical accepted rows,
job revision ordering and accepted resume bytes. Mark old results as requiring
refresh because the contract changed; they cannot prove current ranking or
composition readiness. Publish replacement accepted pointers only on success.

Operational rollout stops old writers and takes a workspace backup first.
Rollback after new-generation writes restores that backup; installing an older
binary alone is not a safe rollback procedure.

## Extraction and qualification representation

The extraction response contains exact quote references, reusable requirements,
job-local education/language demands and unresolved source ambiguities. A
reusable occurrence retains its own extracted meaning and posting evidence
alongside its canonical binding; canonicalization does not erase the original.
Source identities used for cache reuse derive from the complete semantic input,
not arbitrary job IDs. Direct demands have job-local identities and exact source
revisions, so they cannot accidentally reuse another job's assessment.

The same missing-qualification batch accepts all four categories. Structural
validation enforces permitted evidence categories and records the education
alternative route. Semantic degree/proficiency/skill judgments remain model
decisions. Direct demands are absent from the reusable library and wording
authoring. Refresh checkpoints include selected jobs' direct demands as well as
catalog and Profile sources.

## Scoring and composition policy

`requirement-fit-v3-equal` gives every distinct canonical requirement and every
distinct job-local demand one item of weight. An alternatives group is one
demand. Existing support credits remain direct = 1, strong = 0.85,
transferable = 0.6 and missing/blocked = 0.

For N > 0, score = clamp(1 + floor(9 * sum(credits) / N + 0.5), 1, 10).
For N = 0, no score is calculated. There is no must-have multiplier, blocker
cap, or invented source priority. Persist the formula version, assessed count
and qualification coverage. Source notes do not affect arithmetic.

Composition gives each eligible canonical requirement one policy point,
preserving complementary achievement depth and stable tie breaking. A unit
coefficient is internal policy, never metadata attributed to the posting.

## Profile and product surfaces

Add structured Language / Proficiency entries with stable IDs, editable through
the existing autosave Profile flow. Do not infer them from a Skills category.
Keep them in baseline rendering, Plate, text, PDF and other supported exports.
Existing four-section templates remain usable. An empty language section does
not imply a factual edit or remove any previous content.

Requirements and Fit views display the new categories, supporting sources and
historical/current status truthfully. Update the synthetic demo and owning
documentation with the same contract.

## Verification

Use owned synthetic workspaces and real public application journeys, controlled
only at external provider boundaries. Do not add unit/snapshot/internal-mock
tests or real-posting replay fixtures.

1. Upgrade an owned legacy workspace: unchanged history/artifacts, no automatic
   calls, empty active catalog, incompatible replay rejected.
2. Exercise complete-batch matching, exact reuse, partial/invalid response and
   concurrent/failed publication; accepted pointers survive failure.
3. Qualify all four categories, including education's explicit alternative and
   rejection of cross-section language evidence.
4. Verify equal scoring, duplicate-occurrence invariance and no-score behavior.
5. Exercise manual targeted refresh, preserving unrelated jobs and accepted
   artifacts on failure/cancellation.
6. Exercise Language / Proficiency editing and baseline/Plate/export retention;
   direct fields and supported Skills never request achievement rewrites.
7. Inspect the final rendered UI and demo, then run required static, documentation
   and end-to-end checks before publishing the stacked pull request.

## Observed implementation evidence

The revised matching prompt passed the original failing FinOps input before
implementation. Only instructions and prompt identity changed; the complete
incoming inventory and empty catalog were preserved. All three FinOps
occurrences resolved to one meaning, all decisions validated, and protected
application state remained unchanged. The live determination took 155.646 seconds.
Private source descriptions and receipts are retained outside the repository.

Affected real-application journeys exercise typed extraction, exact reuse,
category-specific evidence, equal scoring, manual refresh and generation upgrade.
The predecessor upgrade preserves the schema fingerprint, historical scores and
accepted PDF bytes, starts with an empty active catalog, rejects incompatible
action replay and permits deliberate new-generation refresh. Languages survives
autosave, reload, Plate and PDF/text/HTML/DOCX exports. Correction-form transitions
and unsupported-language ranking/keyword exclusions also pass. The exact partial
and final-candidate boundaries are recorded in the
[journey ledger](../developer/qa/python-journeys.md).

Static API/Python and web type/boundary checks pass. The documentation build and
rendered documentation checks pass. The changed demo screens were inspected at
desktop and mobile sizes without console errors or page overflow. The demo uses
explicit synthetic illustrations; it does not claim fresh model judgments.

The installed-payload upgrade path is supported by the harness but has not been
executed without an extracted release payload. Source upgrade proof does not
qualify an installed release.
