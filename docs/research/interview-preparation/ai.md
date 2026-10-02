# AI judgment and leadership questions

These questions address engineering and leadership decisions involving AI.
Tool capabilities and economics change; evaluate the candidate's evidence and
context rather than requiring a fashionable adoption stance. Use [evaluation](evaluation.md).

## AI01 — How would you introduce AI assistance into an engineering team?

**Variants:** Leadership asks you to accelerate AI adoption.

**Intent:** Examine problem-led adoption with accountable learning.

**Strong answer target:** Identify useful tasks, constraints, and current
baselines. Choose a bounded pilot, provide learning/support, and define permitted
use, review ownership, and decision criteria. Examine useful outcomes and costs
before expanding, including cases where assistance is not appropriate.

**Profile inputs/adaptation:** Tasks, tools, permissions, users, and actual
observations. IC: bounded workflow. Manager: support and team practices.
Executive: investment decisions with accountable technical/risk partners.

**Acceptable alternatives:** Slow adoption, targeted use, or declining a use case
can be reasonable. Enthusiasm and skepticism are not themselves quality signals.

**Probes:** What problem does the pilot solve? What would make you stop it?

**Failure modes:** Adoption targets without outcomes, universal tool mandates,
or assuming generated code needs no human ownership.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Purpose | Adopts solely because others do | Connects bounded use to a relevant task and baseline |
| Conditions | Ignores permissions, skills, and ownership | Provides practical support and accountable use boundaries |
| Learning | Declares success from usage alone | Uses outcomes and costs to decide whether to expand |

**Provenance:** Practice extrapolation from selected [OS01](sources.md#additional-topic-research); adoption framework and anchors are ours.

## AI02 — How would you determine whether AI actually improves team productivity?

**Variants:** Developers say they feel faster; is that enough evidence?

**Intent:** Examine measurement and causal uncertainty.

**Strong answer target:** Define the task and useful outcome, including review,
defects, rework, and operating cost. Compare reasonably similar work where feasible,
consider who chooses which tasks/tools, and distinguish elapsed time from effort.
Explain uncertainty and how evidence informs a bounded decision rather than
claiming a universal uplift.

**Profile inputs/adaptation:** Baseline, task mix, adoption pattern, measures,
and limitations. IC: own bounded comparison. Leader: team/system effects.
No controlled experiment is required for every local decision.

**Acceptable alternatives:** Qualitative observations support limited conclusions.
An inconclusive estimate can still justify continued bounded learning.

**Probes:** Could easier tasks explain the improvement? Where did review work go?

**Failure modes:** Lines generated as productivity, self-report as causality,
or copying another study's percentage into the team's forecast.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Outcome | Counts generation without delivered value | Includes relevant quality, effort, and downstream costs |
| Comparison | Attributes all changes to AI | Examines task selection, baselines, and competing explanations |
| Inference | Generalizes a narrow observation universally | Bounds conclusions and uses them proportionately |

**Provenance:** Research-informed editorial rubric using limitations in [ME01](sources.md#additional-topic-research).

## AI03 — What changes in code review when substantial code is AI-generated?

**Variants:** A plausible generated patch contains behavior nobody can explain.

**Intent:** Examine verification and continuing human responsibility.

**Strong answer target:** Require understanding of relevant behavior and risks,
inspect the diff and dependencies, and verify through suitable tests and real
entry points. Address security, compatibility, and maintenance as appropriate.
Keep ownership explicit and narrow or reject changes that cannot be responsibly checked.

**Profile inputs/adaptation:** Patch scope, failure consequences, evidence,
and role. IC: technical verification. Manager: review capacity and standards.
Executive: accountable practices rather than claiming to review every patch.

**Acceptable alternatives:** Use smaller generated changes, pair review,
or avoid assistance for work that cannot be adequately verified.

**Probes:** What would tests miss? Who understands and maintains the result?

**Failure modes:** Passing tests as complete proof, trusting fluent explanations,
or delegating responsibility to the model provider.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Understanding | Accepts code nobody can explain | Establishes relevant behavioral and dependency understanding |
| Verification | Relies on plausible text or one check | Uses proportionate independent functional and risk evidence |
| Ownership | Assumes AI owns resulting failures | Retains human responsibility and feasible maintenance |

**Provenance:** Practice extrapolation from verification/leadership in [OS01](sources.md#additional-topic-research) and contextual quality in [L15](sources.md#will-larson).

## AI04 — How do you help people learn AI tools without shaming skepticism or inexperience?

**Variants:** Team members have very different confidence and access to AI practice.

**Intent:** Examine learning conditions and equitable participation.

**Strong answer target:** Ask about tasks, concerns, access, and learning needs.
Offer supported practice and ways to exchange useful examples and failures.
Respect different learning formats, keep evaluation tied to work, and check
whether people gain capability rather than requiring public enthusiasm.

**Profile inputs/adaptation:** Learning needs, tools, constraints, support,
and observed use. IC: peer learning. Manager: time and access. Do not equate
tool familiarity with career potential or require private disclosures.

**Acceptable alternatives:** Optional sessions, written examples, pairing,
or individual experimentation can fit. Some concerns justify restricted use.

**Probes:** What if someone has a legitimate objection? Who gets protected learning time?

**Failure modes:** Mandatory public mistake sharing, labeling skeptics obsolete,
or expecting learning outside working hours.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Understanding | Assumes reluctance is ignorance | Examines task needs, access, and legitimate concerns |
| Support | Requires unsupported self-teaching or disclosure | Offers practical learning routes and safe choice of format |
| Capability | Measures enthusiasm or attendance | Checks useful skills and continued learning gaps |

**Provenance:** Practice extrapolation from [H06](sources.md#other-contemporary-leaders), with explicit limits on mandatory participation supplied by us.

## AI05 — How would you evaluate the quality of an AI product?

**Variants:** The demo looks impressive; how do you judge real-world usefulness?

**Intent:** Examine task-specific evaluation and meaningful error analysis.

**Strong answer target:** Define intended users, tasks, and what acceptable
output means, including multiple defensible responses where relevant. Inspect
representative cases and serious failures, obtain appropriate independent
human judgments, and separate factual correctness from style. Explain release
conditions and ongoing checks as usage changes.

**Profile inputs/adaptation:** Product task, consequential errors, evaluation
data, reviewers, and authority. IC: mechanisms. Product/engineering leader:
outcomes, coverage, and risk decisions. No safety certification is implied.

**Acceptable alternatives:** Rules, human review, model-assisted checks, or
combinations can fit if limitations are known and independent evidence remains.

**Probes:** What failure would the average score hide? Who defines “good”?

**Failure modes:** Demo selection, model self-approval as validation, a single
aggregate score masking serious errors, or evaluator/preparation data leakage.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Quality definition | Uses vague helpfulness or polish | Defines observable task-specific success and failure |
| Evidence | Uses selected demos or circular evaluation | Checks representative and challenging cases with suitable independent review |
| Operating decision | Treats one score as permanent assurance | Sets contextual release conditions and ongoing error checks |

**Provenance:** Practice extrapolation from selected [PT02](sources.md#additional-topic-research); independence and release anchors are editorial.

## AI06 — How would you set boundaries for an AI agent with access to private data or tools?

**Variants:** An assistant can both read sensitive information and take actions.

**Intent:** Examine data access, action authority, and containment.

**Strong answer target:** Map necessary data and actions to the user purpose.
Separate reading, proposing, and executing; constrain access and obtain appropriate
authorization for consequential actions. Treat retrieved/tool text as information,
not authority. Explain auditability, failure containment, and checks with
responsible security/privacy owners.

**Profile inputs/adaptation:** Data, actions, stakes, permissions, and technical
role. IC: controls and verification. Leader: acceptable use and accountable
ownership; a policy statement alone does not prove controls work.

**Acceptable alternatives:** Read-only assistance, narrower tools, human review,
or declining a use case can fit. Approval for every trivial action is not mandatory.

**Probes:** What can the agent do without new approval? How do you test those boundaries?

**Failure modes:** Broad credentials by default, treating document instructions
as user authorization, or logs as a substitute for access controls.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Scope | Gives access beyond the intended need | Maps permissions and actions to a legitimate purpose |
| Authority | Confuses available tools with permission | Distinguishes information, user intent, and execution authority |
| Containment | Assumes a prompt prevents misuse | Describes appropriate controls, verification, and accountable recovery |

**Provenance:** Editorial agent scenario; purpose and auditable access informed by [L16](sources.md#will-larson). Not a complete security design.

## AI07 — How do you prevent an AI summary or draft from turning guesses into facts?

**Variants:** An AI-generated performance summary attributes work to the wrong person.

**Intent:** Examine provenance and correction in consequential information.

**Strong answer target:** Separate source facts, new user statements, hypotheses,
and generated interpretations. Check material claims against appropriate evidence,
preserve ownership and qualifications, and expose uncertainty. Correct errors
before consequential reuse and prevent drafts from silently changing accepted records.

**Profile inputs/adaptation:** Task, sources, audience, claim consequences,
and authority. IC: source-linked output. Manager: people-decision review.
Executive: accountable systems rather than confidence in summary fluency.

**Acceptable alternatives:** Abstain, request clarification, or use a qualitative
statement when evidence is incomplete. Missing documentation does not prove a user is lying.

**Probes:** Which claim needs confirmation? What happens when the source and user disagree?

**Failure modes:** Fabricated quotes, plausible metrics, automatic record updates,
or treating an old accepted record as impossible to correct.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Claim separation | Presents interpretation as source fact | Labels statement types and preserves material qualifications |
| Checking | Trusts fluent output or unsupported citations | Verifies relevant claims and clarifies conflicts |
| Reuse | Lets generated drafts become canonical silently | Uses review, correction, and explicit promotion boundaries |

**Provenance:** Practice extrapolation from correctness in [PT02](sources.md#additional-topic-research); canonical-record boundaries are our content contract.

## AI08 — How should AI uncertainty affect workforce and investment planning?

**Variants:** Leadership forecasts major capacity gains from AI without local evidence.

**Intent:** Examine responsible planning when capability and adoption are changing.

**Strong answer target:** Separate observed task effects from forecasts about
team capacity. Consider review, maintenance, learning, demand, and role changes.
Use scenarios and bounded investments, preserve accountability, and define
evidence that would justify changing commitments or staffing assumptions.

**Profile inputs/adaptation:** Forecast, local evidence, costs, responsibilities,
and authority. Manager: realistic team planning. Executive: investment and
people implications with appropriate partners. Predictions remain labeled.

**Acceptable alternatives:** Invest in training, redesign work, maintain staffing,
or adjust capacity cautiously. No inevitable workforce outcome is presumed.

**Probes:** What local evidence supports the forecast? How would the plan change if gains do not appear?

**Failure modes:** Extrapolating generation speed to headcount savings,
ignoring downstream work, or making irreversible decisions from vendor claims.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Evidence | Treats a forecast as established capacity | Separates local observations, assumptions, and uncertainty |
| System effects | Counts coding speed alone | Considers full work, costs, learning, and demand |
| Planning | Commits irreversibly without contingencies | Uses proportionate scenarios and explicit revision conditions |

**Provenance:** Editorial planning synthesis informed by measurement limits in [ME01](sources.md#additional-topic-research) and leadership in [OS01](sources.md#additional-topic-research).
