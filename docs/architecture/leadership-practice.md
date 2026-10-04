# Leadership Practice

This page defines a bounded proposal for learning from management episodes
without turning reflection into candidate facts or a leadership score.
Leadership Practice is not an available feature.

**Read this if** you are reviewing the proposed learning cycle and its evidence,
ownership, and privacy boundaries before implementation.

## Future architecture (not implemented)

[#952](https://github.com/ebarti/JobCtrl/issues/952) owns this design. The proposed
cycle is **Evidence map → structured episode debrief → one user-selected
experiment → outcome review**. It would support deliberate management practice,
not a universal leadership persona, personality assessment, or general-purpose
thinking partner. General-purpose thinking-partner research is outside scope.

### A bounded learning cycle

1. **Evidence map.** Start from the existing read-only
   [Evidence map](../user/candidate-profile.md#source-of-truth-and-ownership)
   over canonical profile evidence and its downstream use. Select a capability
   and relevant management scope; a coverage gap invites inquiry, not a negative
   judgment. Reflections would not become new Evidence map facts.
2. **Structured episode debrief.** Capture context, constraints, authority,
   goals, realistic alternatives, the reasoning available at the time, personal
   versus team ownership, actions, and observed outcomes. Ask what evidence is
   missing, who could corroborate it without unnecessary disclosure, and what
   would change each interpretation. Distinguish decision quality from eventual
   results: good reasoning can precede disappointment, and success can conceal
   weak reasoning or another person's contribution.
3. **One user-selected experiment.** Offer bounded alternatives, then let the
   user choose one feasible action within their authority, or decline. Record
   the hypothesis, expected observable change, constraints, review point, and
   stop conditions. An experiment is a proposal, never proof of past behavior
   or permission to act on the user's behalf.
4. **Outcome review.** Compare observations with the original expectation;
   revisit attribution, alternatives, contradictory evidence, and uncertainty.
   Record learning or an inconclusive result. Continuing would require another
   deliberate selection, not an automatically expanding coaching program.

### Evidence coverage, not personal ratings

Each capability would carry a state for the assessed scope and context, with
supporting evidence, uncertainty, and limits on generalization:

| State | Meaning |
| --- | --- |
| Demonstrated | Supported, attributable observations show the capability in the stated context and scope; they do not establish universal competence. |
| Transferable | Evidence from an adjacent context supports a plausible application, with the scope difference and untested assumptions explicit. |
| Unproven | Reviewed evidence is insufficient or conflicting for the specific capability claim; it does not establish poor ability. |
| Not-assessed | The capability or relevant scope has not been reviewed; no conclusion follows. |

Absent evidence must never mean poor ability. No composite leadership or
personality score, ranking, or readiness grade would be produced.

Three visibly distinct categories would prevent prose from becoming proof:

- **Confirmed observations:** supported factual statements with source
  attribution, relevant source/profile versions, scope, and corroboration limits.
  A user recollection remains an unverified statement, not a certified event.
- **Tentative interpretations and counter-readings:** competing explanations,
  supporting and contradicting observations, uncertainty, and evidence that
  would change the reading. Model interpretation cannot certify an event.
- **Proposed experiments:** prospective actions linked to a tentative hypothesis
  and observable review criteria, never presented as confirmed outcomes.

### Ownership and promotion

Reflections would remain separate from the canonical
[Candidate Profile](../user/candidate-profile.md) and job-specific
[Interview Prep](../user/materials-and-tailoring.md#interview-preparation).
Current Required-bullet coaching provides deterministic framing and missing-
evidence questions; it does not implement this cycle. Interview guidance and
research are not personal evidence.

Supported-fact promotion would depend on
[#883](https://github.com/ebarti/JobCtrl/issues/883), owned by the proposed
[Profile Evidence program](../plans/2026-09-21-profile-evidence-selective-tailoring.md).
The user must explicitly review selected supported facts, their provenance, and
exact proposed values against the current Candidate Profile version before
promotion. A stale review requires reconciliation and renewed review; failure
preserves existing canonical facts and the last accepted artifact. Reflections,
interpretations, and experiments must never automatically change fit scores or
Discovery intent.

### Management scope and privacy

Team management would require evidence of delegation, development, and delivery
through others. Multi-team management would require manager development,
dependency management, and durable operating practices. Executive leadership
would require strategy, resource allocation, organizational systems, and
business accountability. Titles, headcount, and participation alone establish
none of these scopes; technical influence does not imply people-management
authority.

Disclosure would be voluntary, with minimal third-party detail. Users must be
able to correct or delete reflections and affected derivatives; already
promoted canonical facts require a separate explicit Profile correction or
deletion review. Private text must stay out of telemetry and public fixtures.
Provider use would be user-initiated, limited to reviewed excerpts with explicit
context and spend limits. Refusal, unavailable bounds, or failed generation
must preserve prior accepted material and allow manual reflection without
silent fallback or expanded disclosure.

### Evaluation and acceptance boundaries

Before implementation, independently review synthetic cases:

- First-time manager: adjacent mentoring evidence is transferable, not demonstrated management.
- Positive team outcome, unclear ownership: retain uncertainty; do not assign personal credit.
- Defensible decision, disappointing outcome: assess reasoning and results separately.
- Conflicting observations: preserve counter-readings and identify discriminating evidence.
- Stale promotion review: require reconciliation; preserve canonical facts.
- Provider refusal, correction, or deletion: preserve accepted material on refusal; propagate corrections/deletions to affected reflection derivatives without silently rewriting promoted facts.

Acceptance requires these evidence and control boundaries before any practice
capability ships. Synthetic cases do not validate coaching quality. This design
does not specify APIs, storage, schemas, migrations, or UI, and authorizes no
implementation or automatic profile, scoring, or search changes.
