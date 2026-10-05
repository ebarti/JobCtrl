# Leadership Practice

Leadership Practice is a proposal for reflecting on management episodes and
trying one bounded change. It is unavailable in JobCtrl today; this page defines
the design boundaries, not instructions for an existing feature.

**Read this if** you are assessing how future leadership reflection could use
evidence without becoming a personality judgment or rewriting candidate facts.

## Future architecture (not implemented)

[#952](https://github.com/ebarti/JobCtrl/issues/952) owns this proposal. Its scope
is management practice grounded in episodes, not general-purpose
thinking-partner research. No implementation is authorized by this page.

The current [Candidate Profile](../user/candidate-profile.md) owns canonical
facts and its read-only Evidence Map. Current [Interview Prep](materials.md#stored-interview-preparation)
owns job-specific preparation and revisioned personal notes. Required-bullet
coaching is an opt-in deterministic aid for saved profile wording and missing
evidence; none of these establishes a leadership assessment.

### Practice loop

1. **Evidence map:** inspect existing canonical achievements, skills and gaps.
   Select a capability and an episode to explore; a gap invites inquiry rather
   than a conclusion about ability. A new recollection remains private,
   unverified reflection.
2. **Structured episode debrief:** record context, responsibilities, constraints
   and information available at the time; realistic alternatives and tradeoffs;
   personal versus team ownership; actions and outcomes, including unintended
   effects. Identify missing evidence and what observation would change each
   interpretation. Separate decision quality from eventual success.
3. **One user-selected experiment:** offer bounded options with their rationale;
   the user chooses one, edits it, or declines. Define the action, intended
   observation, review point and stopping boundary, including authority and
   risk limits. Never assign changes to other people or act on the user's behalf.
4. **Outcome review:** compare the intended observation with what happened,
   record constraints and alternative explanations, and revise only supported
   interpretations. An unfinished, declined or inconclusive experiment remains
   uncertain. The user decides whether another loop is useful.

### Capability states and claim separation

States would apply to individual capabilities within stated responsibility and
context, never to the person as a whole:

| State | Meaning |
| --- | --- |
| **Demonstrated** | Episode evidence supports the capability at the recorded responsibility and context; it does not prove universal competence. |
| **Transferable** | Relevant evidence exists in another context, with explicit similarities, differences and limits; transfer is tentative. |
| **Unproven** | The capability has been considered, but available evidence cannot yet support it in the target context. |
| **Not assessed** | The capability has not been examined; no conclusion follows. |

These are distinct from Profile evidence-strength labels such as `supported`
and `verified`. Missing evidence, confidentiality, or lack of assessment must
never imply poor ability. There would be no composite leadership score,
personality score, readiness grade or ranking of people.

Every debrief and review would visibly separate:

- **Confirmed observations:** bounded accounts of actions and outcomes, labeled
  as user-confirmed or independently corroborated. User confirmation alone is
  not independent verification.
- **Tentative interpretations and counter-readings:** explanations tied to
  observations, with competing readings and disconfirming conditions visible.
- **Proposed experiments:** future actions, not facts or evidence of capability.

Each claim would carry provenance and uncertainty: source/excerpt or explicit
absence, relevant profile version or reflection revision, confirmation basis,
context limits and unresolved questions. Experiment rationales would reference
the interpretations they test. Generated wording and repeated claims add no
corroboration.

### Authority and management scope

Practice reflections would remain separate from canonical Candidate Profile
and job-specific Interview Prep, without silently becoming accepted preparation
evidence. Supported-fact promotion depends on the unshipped
[Profile Evidence proposal](../plans/2026-09-21-profile-evidence-selective-tailoring.md)
and [#883](https://github.com/ebarti/JobCtrl/issues/883): explicit item-level
review against the current profile version, with renewed review for stale or
conflicting items before saving. Interpretations and experiments are not
promotable facts. Reflection must never automatically change fit scores or
Discovery intent.

Scope would follow actual responsibilities, not titles or headcount:

- **Team:** evidence of delegation, feedback, development and accountability
  for team decisions and outcomes, distinguishing personal actions from shared work.
- **Multi-team:** evidence of cross-team coordination, dependency tradeoffs,
  manager development and responsibility across teams, rather than attendance
  at wider meetings.
- **Executive:** evidence of organizational strategy, resource allocation,
  operating decisions and business accountability, with authority and limits explicit.

Individual-contributor influence may be transferable; it must not manufacture
management authority.

### Privacy and acceptance boundaries

Following [Data & Safety](../user/data-and-safety.md), reflection would minimize
private content and redact third-party identities and confidential details.
Users must be able to correct or delete reflections and affected derived
interpretations; separately promoted Profile facts require deliberate Profile
review. Disclose retention and backup limits without promising remote erasure.
Keep episode text out of telemetry and shared logs.

Provider use would require an explicit request, previewed selected excerpts,
bounded context and spend controls; no background whole-profile or episode
uploads. Failed refreshes must preserve the last accepted content while exposing
failure and staleness.

Before implementation, independent synthetic evaluation must check first-time
management without invented authority; ambiguous team ownership without personal
credit inflation; sound decisions with unsuccessful outcomes without hindsight
grading; stale promotion blocked for renewed review; and correction/deletion
invalidating affected interpretations. Acceptance requires inspectable provenance,
uncertainty and user choice throughout the loop. Private episodes and book
excerpts are excluded. This design adds no APIs, storage specification, schemas,
UI or validated coaching claims.
