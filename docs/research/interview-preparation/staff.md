# Staff and principal individual-contributor questions

Staff roles vary. These cards assess technical leadership through decisions,
delivery, adoption, and enabling others; they do not require direct reports.
Use the target responsibilities and [evaluation method](evaluation.md).

## T01 — Walk me through a technically significant project you led

**Variants:** Deep-dive a project. What was your most important technical contribution?

**Intent:** Understand technical depth and leadership in real work.

**Strong answer target:** Explain the problem, constraints, architecture, and
the part you owned. Walk through a consequential decision and the alternatives,
then describe implementation, coordination, and adoption. Address failures or
remaining limitations. Be ready to go deeper than a rehearsed high-level story
without claiming sole authorship.

**Profile inputs/adaptation:** Project artifacts the user may describe,
technical decisions, personal actions, collaborators, and outcome. Senior IC:
substantial bounded contribution. Staff/principal: cross-team direction or
ambiguous work when the target role requires it. Organization-wide scope is not
mandatory just because the title says “staff.”

**Acceptable alternatives:** A project completed by several leads, a migration,
or an unsuccessful project with substantial learning can supply useful evidence.
Confidential details can be abstracted without replacing them with false specifics.

**Probes:** Why this design? What did you personally decide? Which operational
constraint changed the plan? How did other teams begin using it?

**Failure modes:** Architecture tour with no ownership, unverifiable scale,
or a launch claimed as success without examining use and maintenance.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Technical understanding | Cannot explain a key mechanism or constraint | Explains design choices with relevant technical depth |
| Leadership contribution | Personal role stays unclear | Shows consequential direction, execution, or coordination |
| Delivered effect | Equates implementation with useful adoption | Describes use, operational outcome, and meaningful limits |

**Provenance:** Direct work-deep-dive preparation in
[L06](sources.md#will-larson); our proposed assessment dimensions.

## T02 — Describe a difficult technical tradeoff

**Variants:** Why did you choose this architecture? When did you choose simplicity over flexibility?

**Intent:** Understand technical judgment under actual constraints.

**Strong answer target:** State the problem and constraints, compare plausible
options, and explain why the chosen compromise fit. Address operational burden,
cost, risk, reversibility, and ownership where relevant. Separate what you
believed at decision time from the later result. State what would change the choice.

**Profile inputs/adaptation:** Decision, alternatives, evidence, authority,
and consequences. Senior IC: component/service tradeoff. Staff/principal:
interoperability, adoption, organizational capability, and long-term effects as
relevant. Do not turn every answer into a survey of technologies.

**Acceptable alternatives:** A familiar technology, a purchased service,
deferred work, or a deliberately temporary solution may be sound. An uncommon
approach is not weak merely because the evaluator prefers another stack.

**Probes:** What did the rejected option do better? What was the riskiest
assumption? When would you reverse the decision?

**Failure modes:** Technology fashion as rationale, impossible certainty,
ignoring operating costs, or judging a choice solely by a lucky outcome.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Alternatives | No plausible alternative or constraint | Compares realistic options against the problem |
| Decision reasoning | Preference is the only reason | Explains a proportionate compromise and risk |
| Revision awareness | Treats the decision as permanently correct | States checks, limits, or conditions for revisiting it |

**Provenance:** Editorial technical synthesis; decision/outcome distinction
informed by [L10](sources.md#will-larson).

## T03 — How do you handle technical debt or a large migration?

**Variants:** When should we rewrite? How would you get teams to adopt a shared platform?

**Intent:** Examine problem selection, practical transition, and completion.

**Strong answer target:** Define the actual cost or risk of the current system
and the desired outcome. Compare repair, incremental change, replacement, and
deferral. Explain transition ownership, compatibility, support for adopters,
and a way to track completion. Address maintenance during the transition and
decommissioning when relevant; a new system's availability is not full adoption.

**Profile inputs/adaptation:** Current pain, evidence, constraints, proposed
change, dependencies, adoption observations, and maintenance responsibilities.
Senior IC: bounded cleanup or migration. Staff/principal: shared technical
direction and making other teams' change feasible. A manager can evaluate the
resourcing, but that is a different contribution.

**Acceptable alternatives:** Keeping the old system or stopping a rewrite may
be best. A mandate can be appropriate with legitimate authority and support.
No credit is given for creating disruption to force adoption.

**Probes:** Who bears transition costs? How will holdouts be supported? What
does “done” mean beyond shipping the new system?

**Failure modes:** Rewrite because the old code is disliked, free migration
assumptions, abandonment halfway, or optimizing an unused platform.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Problem value | Cannot connect change to a material cost or need | Defines an evidence-based reason and compares options |
| Feasible transition | Treats other teams' work as free | Accounts for ownership, support, and transition risks |
| Completion | Declares victory at availability | Defines adoption and retirement/maintenance outcomes |

**Provenance:** Practice extrapolation from
[TR03](sources.md#other-contemporary-leaders), with operational safeguards and
alternatives supplied by our rubric.

## T04 — A harsh review has shaken a junior engineer. What do you do?

**Variants:** A senior reviewer gives dismissive feedback. The code also has real defects.

**Intent:** Examine technical standards, care, and responsible handling of power.

**Strong answer target:** Support the junior without pretending the code must
be correct. Examine the work and distinguish required corrections from optional
preferences. Help them understand the technical issue and reach a workable path.
Address the reviewer's behavior appropriately and consider whether review
expectations need improvement. Do not turn the response into public punishment.

**Profile inputs/adaptation:** Scenario facts, review content, technical stakes,
authority, and team expectations. Senior/staff IC: assess code, help explain,
and work with the reviewer or responsible manager. Principal: support shared
standards without making every conflict require their personal intervention.
Formal employee discipline is not automatically an IC's responsibility.

**Acceptable alternatives:** Pairing, a synchronous discussion, or manager
involvement may be sensible. Serious behavior concerns can need escalation.
The original patch may require major revision; care does not depend on approval.

**Probes:** What would you say first? How would you identify mandatory fixes?
What if the reviewer is technically right? What changes afterward?

**Failure modes:** Dismissing distress, rubber-stamping code, public shaming,
or excusing harmful behavior because the reviewer is strong technically.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Support | Blames or ignores the junior's concern | Offers respectful support without false reassurance |
| Technical discernment | Accepts/rejects code based on the conflict alone | Separates actual defects, standards, and preferences |
| Repair | Leaves harmful review behavior unaddressed | Uses proportionate action and improves future collaboration |

**Provenance:** Direct interview scenario theme in
[U02](sources.md#other-contemporary-leaders), published in 2026. Scenario wording
and anchors are ours. Worked response: [examples](examples.md#t04-care-and-technical-standards).

## T05 — How do you make other engineers more effective?

**Variants:** How do you scale your impact? How do you handle glue work?

**Intent:** Examine useful enablement that does not make the candidate indispensable.

**Strong answer target:** Identify a recurring constraint on others' work and
an intervention such as better interfaces, documentation, coaching, or clear
ownership. Describe what changed for others and how they gained capability.
Explain what you chose not to absorb, how the work was recognized, and how it
avoided making you the permanent coordination bottleneck.

**Profile inputs/adaptation:** Constraint, actions, users/collaborators, effects,
and workload boundaries. Senior IC: team enablement. Staff/principal: reusable
practices or cross-team capability where relevant. Coordination is technical
leadership when it meaningfully enables work, not because every helpful act is senior.

**Acceptable alternatives:** A small high-value intervention can be stronger
than a large mentoring program. Redirecting decisions to their owner can be
better than answering everything. Declining invisible work can preserve capacity.

**Probes:** Who can do the work without you now? How do you know it helped?
What did you stop doing? Who gets recognition for the enabling work?

**Failure modes:** Always being the rescuer, “helped everyone” without effect,
invisible overload, or appropriating others' achievements.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Enabling mechanism | Lists helpful activity without a constraint | Connects intervention to a recurring need |
| Other people's capability | Remains the required answer source | Shows others becoming more effective or autonomous |
| Sustainability | Absorbs unlimited unrecognized work | Sets ownership, capacity, and recognition boundaries |

**Provenance:** Practice extrapolation from
[TR01](sources.md#other-contemporary-leaders) and [TR04](sources.md#other-contemporary-leaders).
