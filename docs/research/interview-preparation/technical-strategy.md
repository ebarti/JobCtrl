# Technical strategy questions

These cards complement project deep dives and tradeoffs in [staff questions](staff.md).
They examine shared direction and investment. Match technical depth and authority
to the actual role; use [evaluation](evaluation.md).

## TS01 — When should teams follow a shared standard rather than choose independently?

**Variants:** How do you balance technical consistency with autonomy?

**Intent:** Examine justified boundaries for local technical choice.

**Strong answer target:** Identify consequences of variation: interoperability,
security, support, learning, and innovation. Compare shared defaults, mandatory
constraints, and exceptions. Explain decision ownership, adoption support, and
how standards change when evidence shows they no longer help.

**Profile inputs/adaptation:** Actual variation, costs, authority, and adoption.
Staff IC: technical proposal and enablement. Director: capacity and ownership.
Participation is not proof of organization-wide governance authority.

**Acceptable alternatives:** Diverse tools can be appropriate where coupling
is low. A strong default can be enough without a universal mandate.

**Probes:** Who pays for an exception? What justifies changing the standard?

**Failure modes:** Uniformity as an end, autonomy without shared costs,
or mandates that provide no migration/support path.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Need | Standardizes to match personal preference | Identifies material costs or risks of variation |
| Boundary | Requires either complete uniformity or no constraints | Sets proportionate defaults, requirements, and exceptions |
| Adaptation | Treats a standard as permanently correct | Supports adoption and evidence-based revision |

**Provenance:** Editorial strategy synthesis informed by [L07](sources.md#will-larson) and [L08](sources.md#will-larson).

## TS02 — How do you decide whether to build, buy, or reuse a capability?

**Variants:** Should we develop this internally or use a vendor?

**Intent:** Examine the full responsibility attached to a technical option.

**Strong answer target:** Clarify the differentiating need and compare fit,
time, total operating effort, integration, data/control concerns, and exit costs.
Test consequential assumptions and explain ownership after adoption. Distinguish
short-term acquisition cost from long-term obligations.

**Profile inputs/adaptation:** Requirements, alternatives, costs, and decision
role. IC: feasibility assessment. Leader: staffing and commercial constraints
with responsible partners. Do not invent procurement authority.

**Acceptable alternatives:** A hybrid or temporary purchase can fit. Building
can be rational without assuming all internal technology is differentiating.

**Probes:** What would switching cost? Who maintains it two years later?

**Failure modes:** Comparing license cost only with initial coding time,
vendor enthusiasm without diligence, or “we can build it” as sufficient rationale.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Fit | Chooses by brand or preference | Relates alternatives to actual requirements |
| Full cost | Omits support, integration, and exit | Examines continuing obligations and material risks |
| Evidence | Assumes the preferred option works | Tests key assumptions and defines ownership |

**Provenance:** Editorial decision scenario; contextual tradeoffs informed by [L07](sources.md#will-larson).

## TS03 — How do you make an internal platform genuinely useful?

**Variants:** Teams avoid the platform your group has built.

**Intent:** Examine an internal product rather than availability alone.

**Strong answer target:** Understand consumer teams' tasks, constraints, and
current alternatives. Define a useful service boundary and experience, account
for migration/support costs, and prioritize consumer outcomes. Explain evidence
of adoption, reduced burden, and continuing ownership.

**Profile inputs/adaptation:** Consumers, tasks, service boundaries, adoption,
and costs. Platform IC: concrete improvements. Leader: mandate and product
priorities. Mandatory usage is not proof that the platform is useful.

**Acceptable alternatives:** A smaller service, documentation, purchased tools,
or discontinuation may beat a broad platform.

**Probes:** What work becomes easier? Why would a team choose this over its current approach?

**Failure modes:** Centralizing for prestige, treating consumers as difficult,
or transferring work to teams while claiming reduced burden.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Consumer need | Starts with the platform team's preferred technology | Identifies useful tasks and consumer constraints |
| Service design | Treats launch as sufficient support | Creates a usable boundary, experience, and ownership |
| Value | Equates mandate or availability with success | Examines adoption, benefit, and total consumer burden |

**Provenance:** Practice extrapolation from platform-as-product in [TP01](sources.md#additional-topic-research).

## TS04 — How do you make architecture decisions when senior engineers disagree?

**Variants:** An RFC attracts endless debate without a decision.

**Intent:** Examine a decision process that uses expertise and reaches closure.

**Strong answer target:** State the decision, constraints, and responsible
owner. Surface substantive alternatives and evidence, use a focused experiment
if necessary, and set a proportionate route to closure. Record rationale and
revisit conditions without requiring everyone to share the same preference.

**Profile inputs/adaptation:** Decision, participants, authority, and resolution.
Staff IC: facilitate and contribute technical judgment. Leader: clarify authority
and organizational tradeoffs without pretending to settle every detail.

**Acceptable alternatives:** Consensus, a designated owner, or escalation can
fit. The right mechanism depends on consequences and reversibility.

**Probes:** What evidence would resolve disagreement? When does discussion stop?

**Failure modes:** Rank wins every time, endless voting, or writing an RFC
after the decision solely to manufacture agreement.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Decision framing | Debates technology without shared constraints | Defines the choice, consequences, and useful alternatives |
| Expertise | Treats disagreement as disloyalty | Incorporates relevant evidence and dissent |
| Closure | Leaves ownership and revisiting unclear | Establishes accountable closure and review conditions |

**Provenance:** Practice extrapolation from [R03](sources.md#michael-lopp) and [L13](sources.md#will-larson).

## TS05 — How do you identify and address a scaling bottleneck?

**Variants:** How would you prepare a system for substantially higher demand?

**Intent:** Examine measured constraints rather than speculative redesign.

**Strong answer target:** Define workload, desired service behavior, and plausible
growth. Use observations and suitable tests to locate limiting resources or
coordination costs. Compare interventions, explain operating costs, and verify
the change under relevant conditions.

**Profile inputs/adaptation:** Workload definitions, measurements, system limits,
and contribution. IC/staff: mechanism and evidence. Executive: capacity/investment
decision without invented technical authorship.

**Acceptable alternatives:** Demand shaping, simpler architecture, capacity,
or product limits may fit. Future scale does not always require immediate redesign.

**Probes:** Which measurement identified the limit? What might become the next bottleneck?

**Failure modes:** Unqualified scale numbers, fashionable distributed systems,
or a benchmark unrelated to real workload.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Workload | Says “millions of users” without relevant demand | Defines meaningful load and service expectations |
| Diagnosis | Chooses a rewrite before measuring | Uses relevant evidence to locate constraints |
| Intervention | Claims improvement from architecture alone | Compares cost and verifies behavior under suitable conditions |

**Provenance:** Editorial technical scenario; contextual system quality in [L15](sources.md#will-larson).

## TS06 — Tell me about reducing unnecessary technical complexity

**Variants:** When did a simpler solution improve the system?

**Intent:** Examine simplification that preserves necessary behavior.

**Strong answer target:** Identify which complexity comes from the problem,
scale, or avoidable design choices. Explain the concrete maintenance or user
cost, compare changes, and preserve required behavior through a feasible transition.
Describe what became easier and what tradeoff remained.

**Profile inputs/adaptation:** Existing complexity, actual pain, changes, and
effects. IC: component simplification. Staff: interfaces or shared capability.
Do not assume fewer lines mean lower complexity.

**Acceptable alternatives:** Retaining complexity can be correct when it serves
a necessary requirement. Removing an abstraction is not always simplification.

**Probes:** Which requirement made complexity unavoidable? Who benefited from the change?

**Failure modes:** Aesthetic cleanup without value, deleting safeguards,
or shifting complexity onto consumers and calling it removed.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Diagnosis | Labels unfamiliar code unnecessarily complex | Separates necessary constraints from avoidable burden |
| Change | Simplifies by dropping required behavior silently | Preserves needs through proportionate transition |
| Effect | Counts removed code only | Shows reduced cognitive or operating burden with limits |

**Provenance:** Practice extrapolation from complexity distinctions in [L15](sources.md#will-larson).

## TS07 — How do you evaluate an emerging technology without chasing hype?

**Variants:** A senior stakeholder wants the organization to adopt a new tool.

**Intent:** Examine exploration with a decision purpose and bounded cost.

**Strong answer target:** State the relevant problem and compare current
alternatives. Identify consequential unknowns, design a bounded trial, and
define evaluation and exit conditions. Account for operating skills, support,
security, and switching burden before broader adoption.

**Profile inputs/adaptation:** Problem, trial, costs, evidence, and authority.
IC: evaluate a bounded use. Leader: investment and adoption conditions.
A hypothetical plan must not imply a completed successful rollout.

**Acceptable alternatives:** Decline, wait, or experiment narrowly. An imperfect
new technology can be worthwhile when it solves a material problem.

**Probes:** Why now? What trial result would make you decline adoption?

**Failure modes:** Novelty as justification, pilots without decisions, or
using a toy demonstration as proof of production readiness.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Purpose | Adopts because peers are adopting | Connects exploration to a relevant need |
| Trial | Has no meaningful comparison or exit | Tests material unknowns with explicit decision criteria |
| Adoption | Ignores long-term obligations | Accounts for operations, skills, risk, and transition |

**Provenance:** Editorial exploration framework informed by [L08](sources.md#will-larson).

## TS08 — How do you choose between a temporary solution and a long-term investment?

**Variants:** When is a deliberate shortcut responsible?

**Intent:** Examine reversibility and continuing obligations.

**Strong answer target:** Explain urgency, expected lifetime, consequences,
and what makes the choice reversible or costly to change. Compare a bounded
temporary approach with durable investment. Make limits and future ownership
explicit, then check whether the expected revisit actually occurred.

**Profile inputs/adaptation:** Time pressure, design choice, assumptions, and
follow-up. IC: technical mechanism. Leader: capacity and future commitment.
Avoid claiming a shortcut was temporary when no exit path existed.

**Acceptable alternatives:** A long-lived simple solution can be excellent.
Some high-consequence decisions justify investing early despite uncertain demand.

**Probes:** What would trigger replacement? Who pays the later transition cost?

**Failure modes:** Permanent “temporary” work without an owner, speculative
future-proofing, or treating reversible choices as risk-free.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Time horizon | Ignores urgency or expected lifetime | Connects investment to realistic horizon and stakes |
| Reversibility | Calls a choice reversible without a mechanism | Explains exit cost, constraints, and consequences |
| Obligation | Leaves future cleanup to unspecified others | Makes limits, ownership, and revisit conditions explicit |

**Provenance:** Editorial synthesis informed by decision inspection in [L10](sources.md#will-larson).

## TS09 — What makes a technical decision a good technical decision?

**Variants:** What is a good architecture decision? How do you distinguish a
technically elegant solution from the right solution? When is a technical
compromise sensible? How do you judge a past design that no longer fits?

**Intent:** Establish the candidate's technical decision criteria, distinct
from narrating one tradeoff in T02 or closing a disagreement in TS04.

**Strong answer target:** Begin with the problem and the behavior the system
must provide for its users and business. Explain which constraints are decisive
and compare credible options, including the current approach where viable.
Connect the choice to actual technical mechanisms and relevant failure paths.
Consider the effort to build, adopt, operate, change, and retire it, including
costs shifted to other teams. Identify consequential unknowns, why any added
complexity earns its cost, and how verification or a bounded experiment informs
the choice. Make implementation and operating ownership usable. Explain what
would justify revisiting the design and the real cost of doing so. Technical
elegance, consensus, and a successful launch alone do not establish quality;
a context-appropriate compromise may be better. Judge the original choice using
its original context, while evaluating whether it remains appropriate today.

**Profile inputs/adaptation:** Actual requirements, workload, service/data
constraints, team capabilities, delivery horizon, technical options, and
evidence. An IC should explain mechanisms within owned work. Staff/principal
answers should include affected teams and adoption when relevant. Managers and
executives should explain investment and technical accountability without
claiming authorship or authority they lacked. Choose material criteria for the
case; do not require every possible system concern in every answer.

**Acceptable alternatives:** Familiar technology, a novel tool, buying, reusing,
repairing, or deliberately deferring work can all be justified. Simplicity is a
useful default, not permission to omit needed behavior. Some choices are hard
to reverse and can still be appropriate; describe their consequences rather
than pretending every decision can be rolled back cheaply.

**Probes:** Why not keep the existing approach? Which requirement makes your
preferred option better? Where does complexity or operating burden move? Which
failure could make the design unacceptable? If it worked at launch but became
expensive two years later, does that make the original decision bad? What
would change your recommendation?

**Failure modes:** Fashion or elegance as the whole rationale; listing quality
attributes without choosing among them; speculative scale; comparing initial
coding cost with only a vendor's license fee; “reversible” without an exit
mechanism; no technical depth; or treating changed requirements as proof that
the original engineers lacked judgment.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Problem and technical fit | Chooses a technology without decisive requirements or mechanisms | Connects the choice to relevant system behavior, constraints, and technical evidence |
| Whole-system tradeoffs | Optimizes one property while hiding alternatives or transferred burden | Compares viable approaches and material delivery, adoption, operating, and change costs |
| Risk and evolution | Treats launch or claimed reversibility as permanent proof | Explains consequential unknowns, proportionate checks, ownership, and credible conditions for revision |

**Provenance:** Practice extrapolation from [L20](sources.md#will-larson) on
context and shared direction, [L21](sources.md#will-larson) on evolving quality
requirements, and [DM01](sources.md#additional-topic-research) on whole-system
technology costs. This definition and rubric are editorial; these sources
do not endorse a particular architecture, technology, or universal right answer.
