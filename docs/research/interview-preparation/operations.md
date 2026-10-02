# Reliability and operations questions

Operational authority, service stakes, and team size change the right response.
These cards assess judgment, not memorization of a large-company incident process.
Use [evaluation](evaluation.md) to separate plans from observed experience.

## O01 — A service is failing. How do you organize the response?

**Variants:** Describe an incident you helped coordinate.

**Intent:** Examine mitigation, coordination, and clear operational ownership.

**Strong answer target:** Establish impact and urgency, engage appropriate
responders, and clarify coordination, technical work, and communication. Prioritize
safe mitigation while retaining investigation evidence. Explain escalation,
handover, and how recovery is verified.

**Profile inputs/adaptation:** Symptoms, authority, responders, and actions.
IC: assigned technical contribution. Incident lead: coordination. Executive:
business decisions and support without taking over the debugging channel.

**Acceptable alternatives:** One person can cover several roles in a small
incident. A safe rollback may precede discovering the exact cause.

**Probes:** Who can decide mitigation? How do you avoid conflicting changes?

**Failure modes:** Uncoordinated heroics, investigation before containment,
or announcing recovery without checking user impact.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Impact | Starts debugging without assessing stakes | Identifies affected users, urgency, and uncertainty |
| Coordination | Responders act without ownership | Establishes roles, escalation, and shared state |
| Recovery | Treats one healthy signal as resolution | Verifies mitigation and hands over remaining work |

**Provenance:** Practice extrapolation from [SR02](sources.md#additional-topic-research).

## O02 — How do you balance reliability investment with feature delivery?

**Variants:** When should reliability concerns change the roadmap?

**Intent:** Examine a deliberate service-risk and product-value tradeoff.

**Strong answer target:** Establish user expectations, service performance,
failure costs, and planned change risk. Compare interventions with feature value.
Agree decision rules with relevant owners and revisit them when evidence or
business needs change.

**Profile inputs/adaptation:** Service objectives, impact, costs, and authority.
IC: evidence and options. Manager: capacity choice. Executive: business tolerance
and peer alignment. Do not invent a service-level agreement.

**Acceptable alternatives:** Context-specific objectives or a simpler policy
can work. Some periods justify urgent reliability work; others allow bounded risk.

**Probes:** Who sets acceptable risk? What happens when expectations are missed?

**Failure modes:** Reliability as zero failures at any cost, feature urgency
as a permanent exemption, or punitive error budgets.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Expectations | Uses an arbitrary availability target | Connects objectives to user and business consequences |
| Tradeoff | Treats either concern as always dominant | Compares value, risk, and feasible interventions |
| Operating rule | Decisions change with whoever argues loudest | Establishes usable rules and review conditions |

**Provenance:** Practice extrapolation from [SR01](sources.md#additional-topic-research); example thresholds are not requirements.

## O03 — What makes an incident review useful?

**Variants:** Describe a postmortem that changed how your team operated.

**Intent:** Examine learning that leads to feasible risk reduction.

**Strong answer target:** Reconstruct events and information available to
responders. Explore contributing system conditions and decisions without hiding
accountability. Select meaningful changes with owners, priority, and checks;
show what actually changed rather than counting action items.

**Profile inputs/adaptation:** Incident evidence, candidate role, follow-up,
and recurrence observations. An IC can contribute a correction; broader process
ownership requires its own evidence.

**Acceptable alternatives:** A lightweight review fits a small event. Some
residual risk may be explicitly accepted instead of generating endless work.

**Probes:** Which action reduced risk? What did you learn about the response?

**Failure modes:** “Human error” as the complete cause, blame rituals, or a
large follow-up list nobody can deliver.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Reconstruction | Uses hindsight or accusation | Explains events and responder knowledge at the time |
| System learning | Stops at the person who acted last | Identifies relevant conditions and decision weaknesses |
| Follow-through | Treats the document as completion | Prioritizes owned changes and examines their effect |

**Provenance:** Editorial operational synthesis informed by [SR02](sources.md#additional-topic-research) and [L10](sources.md#will-larson).

## O04 — How do you address on-call overload and recurring toil?

**Variants:** Your strongest responders are exhausted.

**Intent:** Examine sustainable operational responsibility.

**Strong answer target:** Understand interruptions, workload, recurrence, and
coverage. Provide immediate relief where needed, then reduce underlying failure
or repetitive work. Build shared capability, realistic staffing, and escalation
without making one person permanently indispensable.

**Profile inputs/adaptation:** Paging patterns, manual work, support, authority,
and observed improvement. IC: propose/implement bounded fixes. Leader: staffing,
priorities, and protected recovery time within scope.

**Acceptable alternatives:** Reduce service scope, buy support, improve alerts,
or change rotation design. Automation is not always the best first intervention.

**Probes:** What caused the load? Could the system operate without the expert?

**Failure modes:** Rewarding exhaustion, redistributing impossible load without
reducing it, or blaming responders for asking for help.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Load diagnosis | Calls people insufficiently resilient | Examines interruption and recurring work evidence |
| Relief | Requires indefinite personal sacrifice | Offers feasible immediate support and fair coverage |
| Durable change | Depends on one heroic expert | Reduces causes and develops shared operational capability |

**Provenance:** Practice extrapolation from [R05](sources.md#michael-lopp) and [U01](sources.md#other-contemporary-leaders).

## O05 — How would you roll out and, if necessary, roll back a risky change?

**Variants:** A migration cannot be reversed by redeploying old code alone.

**Intent:** Examine concrete containment and recovery design.

**Strong answer target:** Identify affected state, compatibility, and failure
signals. Choose rollout stages and decision owners proportionate to risk. Explain
what rollback restores, what it cannot restore, and how to verify recovery or
use an alternative forward repair.

**Profile inputs/adaptation:** Change mechanism, data effects, blast radius,
and operational constraints. Technical depth depends on role; leaders still
need to understand the meaningful limits of reversibility.

**Acceptable alternatives:** A carefully prepared one-step change may fit.
Some changes require recovery rather than a literal rollback.

**Probes:** What happens to data already changed? What triggers a stop?

**Failure modes:** “We can roll back” without mechanism, untested recovery,
or multiplying changes while impact is unclear.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Change understanding | Ignores state and compatibility | Explains material failure paths and affected state |
| Containment | Exposes everyone without a rationale | Uses proportionate stages, signals, and ownership |
| Recovery | Assumes redeployment restores everything | Describes feasible recovery and verification limits |

**Provenance:** Editorial synthesis using contextual quality in [L15](sources.md#will-larson).

## O06 — How do you know a service is operationally ready?

**Variants:** What would you check before taking ownership of a critical service?

**Intent:** Examine sustained operability and recovery preparedness.

**Strong answer target:** Establish service expectations and owners. Examine
visibility, support knowledge, dependencies, access, capacity, and recovery
procedures relevant to the service. Verify critical assumptions through suitable
exercises and identify accepted gaps with accountable follow-up.

**Profile inputs/adaptation:** Criticality, ownership, known failure modes,
and exercise results. IC: service mechanisms. Leader: coverage, investment,
and accountability across teams.

**Acceptable alternatives:** A modest checklist may fit a low-risk service.
Not every organization needs a complex disaster-recovery program.

**Probes:** When was restoration last exercised? Who can act if the owner is absent?

**Failure modes:** Backup existence as proof of restoration, undocumented
single-person access, or dashboards without response ownership.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Ownership | Assumes someone will respond | Identifies usable responsibility and coverage |
| Preparedness | Treats documents as proven capabilities | Checks relevant detection, operation, and recovery mechanisms |
| Gap handling | Hides known readiness limits | Names risk, decision owners, and feasible follow-up |

**Provenance:** Editorial synthesis informed by [SR02](sources.md#additional-topic-research); preparedness checks are ours.

## O07 — How do you communicate during a customer-impacting incident?

**Variants:** What do you say when the cause or recovery time is unknown?

**Intent:** Examine useful, truthful communication under uncertainty.

**Strong answer target:** Coordinate technical and customer-facing owners.
Describe known impact, actions, uncertainty, and the next update. Keep public
claims consistent with verified evidence, correct mistakes promptly, and
distinguish service restoration from complete cause analysis.

**Profile inputs/adaptation:** Audience, confirmed facts, communication authority,
and update history. IC: supply accurate technical information. Designated owner:
communicate through agreed channels; not everyone speaks externally.

**Acceptable alternatives:** A brief acknowledgment is useful before a full
explanation. Update timing depends on urgency and audience needs.

**Probes:** What if someone promises a recovery time without evidence?

**Failure modes:** Speculative causes, false certainty, no next update, or
publishing confidential technical/customer information.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Accuracy | Presents guesses as established facts | Separates verified information, uncertainty, and correction |
| Usefulness | Gives technical detail without user impact | Addresses audience needs and next steps |
| Coordination | Conflicting owners issue incompatible updates | Establishes authority and consistent ongoing communication |

**Provenance:** Practice extrapolation from communication roles in [SR02](sources.md#additional-topic-research).

## O08 — How would you prioritize a newly reported security vulnerability?

**Variants:** A potential exploit appears shortly before a major launch.

**Intent:** Examine evidence, containment, and appropriate specialist involvement.

**Strong answer target:** Clarify affected assets, exposure, exploit plausibility,
and uncertainty with responsible security specialists. Restrict or contain
material risk, compare remediation options, and establish decision authority.
Explain verification and coordinated follow-up without disclosing exploitable details.

**Profile inputs/adaptation:** Scenario facts, access, role, and available expertise.
IC: investigate within authority. Leader: capacity and risk decisions with
security owners; do not imply specialist expertise from confidence alone.

**Acceptable alternatives:** Disable a feature, patch, apply a temporary control,
or accept a well-supported bounded risk through the proper owner.

**Probes:** What facts change urgency? How will you verify the remedy?

**Failure modes:** Dismissing risk to meet a date, panic without assessment,
or unilateral external disclosure.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Risk assessment | Decides from the vulnerability label alone | Examines exposure, consequences, and uncertainty with expertise |
| Action | Offers no feasible containment or remedy | Chooses proportionate measures with accountable ownership |
| Verification | Calls a code change complete remediation | Checks the affected condition and tracks residual risk |

**Provenance:** Editorial security scenario; auditable controls informed by [L16](sources.md#will-larson). This is leadership judgment, not legal procedure.
