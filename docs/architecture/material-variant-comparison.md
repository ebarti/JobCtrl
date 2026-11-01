# Material Variant Comparison

JobCtrl already compares stored coverage and review metadata for materials.
This proposal scopes the remaining comparison of actual rendered text and
optional AI interpretation for [issue #908](https://github.com/ebarti/JobCtrl/issues/908).
Those additions are unavailable today.

**Read this if** you need the boundary between shipped comparison and future
variant analysis.

## Current implementation

Source baseline: `67b4175aa2d9e8f96e62da545886b1e8712bf691`.
[ArtifactDetailPanel][detail] offers registered artifacts for the same job and
exact artifact type. It excludes the selected artifact, different jobs/types,
and candidates marked `missing`. Selection uses only the newest 200
type-filtered list items, then filters by job; older eligible variants may be
absent. It defaults to the first eligible candidate when the selection is no
longer eligible. A text artifact and its PDF are different types.

[ArtifactComparison][comparison] reads both artifact details;
[compareCoverage][selector] derives deltas from stored audits: newly covered,
coverage lost, newly declared, declared lost, still declared, and still missing.
It shows template identity, status, validation pass/errors/warnings and judge
verdict/score/threshold/issue counts. Risk labels come from callers, not an
inferred comparison judgment. Absent coverage remains **coverage not recorded**,
never zero coverage or newly inferred misses.

[ApplyReviewView][review] binds the accepted artifact to a successfully rendered
draft and supplies comment-thread risk labels. These are existing metadata
comparisons, not missing features. The inspected [selector tests][selector-tests],
[component tests][comparison-tests], [Artifact Detail tests][detail-tests] and
[Apply Review tests][review-tests] cover stored deltas, absent coverage, template
identity, risk labels, eligible selection and rendered-draft lifecycle boundaries.
Inspection is not test execution or proof of full-text comparison.

[Materials audit ownership](materials.md) and
[Materials & Tailoring](../user/materials-and-tailoring.md) define canonical
evidence, generation provenance and accepted-history preservation. Comparing
metadata does not compare every rendered sentence or establish visual equivalence.

## Future architecture (not implemented)

### Explicit pairwise comparison

The smallest reversible scope is local deterministic comparison of two eligible
registered artifacts. The user confirms the same-job/same-type pair and explicitly
starts comparison; the current automatic candidate default is not consent to
analysis. Show the bounded list limitation and reject ineligible or unavailable
inputs before processing.

Pin both artifact IDs, job/type, generation/version provenance and content
identity (byte hashes) for each run. Bind extracted text to those bytes; label
unavailable provenance and incomplete extraction instead of inventing bindings.
Do not claim a complete comparison when extraction fails or is partial.

Show additions, deletions, changed wording and ordering as exact before/after
excerpts with section or rendered-location references and available canonical
evidence links. Keep template/layout differences separate: identical extracted
text does not prove identical appearance. Disclose extraction normalization and
ambiguous ordering; do not silently normalize away meaningful numeric changes.

Label this output **Canonical artifact differences**: it reports what the pinned
artifacts say, not whether their claims are true. Missing evidence links remain
explicitly unavailable. Comparing wording neither upgrades stored coverage nor
reruns material acceptance gates.

### Separately consented provider interpretation

Only after deterministic results may the user explicitly request optional
interpretation. Before sending anything, show provider/model, the bounded payload
for review, estimated spend, per-request input/output limits and applicable
budget checks. Require explicit consent to that payload and provider; fail closed
if readiness, estimation or required spend controls cannot be satisfied. Existing
[budget admission](../user/configuration.md#llm-spend-budgets) uses estimated
spend and observed usage, not a strict in-flight billing cap. Explain that
limitation; do not promise a hard monetary ceiling.

Send only user-reviewed necessary excerpts and context. Exclude unrelated profile
history, credentials and local paths. Treat artifact text as data, never provider
instructions. Default to transient local comparison output and metadata-only
diagnostics, without private text in logs. Disclose provider retention policy and
uncertainty before consent; local transience cannot guarantee provider deletion.

Show generated output separately as **Tentative interpretation or advice**.
Each claim must cite pinned excerpts, state uncertainty and abstain when evidence
is insufficient. Artifact wording alone cannot establish a candidate fact.
Generated claims cannot automatically become accepted material or profile facts.
Comparison cannot silently edit, accept, replace or approve artifacts, update
Profile, or authorize submission; those decisions retain their owning workflows.

### Failure, cancellation and changed inputs

Extraction/provider failures show a clear unavailable or partial result. Preserve
all artifacts, especially accepted material, and any prior successful comparison
with its original pair binding. Provider failure leaves deterministic results
usable. Retry requires an explicit action and renewed payload/spend review;
there are no silent provider retries. Cancellation stops further processing and
discards late output, but may not undo incurred spend. Changed selections,
versions or bytes invalidate pending work: reject late responses, label previous
results as belonging to the old pair, and require explicit comparison again.

### Required future implementation evidence

These synthetic cases define future proof requirements, not executed tests or
demonstrated effectiveness.

| Synthetic case | Expected observable outcome |
| --- | --- |
| Identical text, different templates | No text delta; template difference remains; no visual-equivalence claim. |
| Reordered sections and changed wording | Ordering and exact additions/deletions retain both location bindings. |
| “Reduced latency 10%” becomes “30%”, without supporting evidence | Exact numeric delta; interpretation abstains from factual endorsement; no promotion. |
| Absent audit/provenance or incomplete extraction | Explicit unavailable/partial labels; no invented coverage, evidence or complete-result claim. |
| Different job/type pair | Rejection before comparison or provider spend. |
| Cancellation or changed inputs during delayed analysis | Late output rejected; prior result keeps original bindings; artifacts unchanged. |

[detail]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/views/artifacts/ArtifactDetailPanel.tsx
[comparison]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/contexts/materials/components/ArtifactComparison.tsx
[selector]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/contexts/materials/selectors/compareCoverage.ts
[review]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/views/apply-review/ApplyReviewView.tsx
[selector-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/contexts/materials/selectors/compareCoverage.test.ts
[comparison-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/contexts/materials/components/ArtifactComparison.test.tsx
[detail-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/views/artifacts/ArtifactDetailPanel.test.tsx
[review-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/apps/web/src/views/apply-review/ApplyReviewView.test.tsx
