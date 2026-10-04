# Product and business judgment questions

Engineering can contribute to product judgment without owning every product
decision. State the candidate's authority, collaborators, and evidence; use
[evaluation](evaluation.md) rather than assuming product leadership from a title.

## P01 — What do you do when a feature request does not explain the problem?

**Variants:** A stakeholder has already chosen the solution.

**Intent:** Examine problem discovery before solution commitment.

**Strong answer target:** Understand who needs what outcome and why the request
exists. Investigate relevant evidence and constraints, then compare feasible
responses with the product owner. Explain how you avoid dismissing legitimate
urgency while making assumptions visible.

**Profile inputs/adaptation:** Request, user need, evidence, decision rights,
and contribution. IC: ask useful questions and offer options. Product-facing
leader: own discovery only if the role actually includes it.

**Acceptable alternatives:** Implementing the requested feature may be correct.
A contractual or urgent operational constraint can narrow exploration.

**Probes:** What would you ask first? Who chooses if options conflict?

**Failure modes:** Automatic obedience, automatic rejection, or claiming
stakeholders cannot understand engineering.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Problem understanding | Treats the proposed feature as the whole need | Identifies the intended user/business outcome |
| Exploration | Substitutes the candidate's preferred solution | Uses evidence and realistic alternatives |
| Collaboration | Bypasses the responsible decision-maker | Works within shared authority and material constraints |

**Provenance:** Practice extrapolation from [L14](sources.md#will-larson) and [PC01](sources.md#additional-topic-research).

## P02 — How have you learned about a customer's problem directly?

**Variants:** How do you prevent customer conversations from just validating your idea?

**Intent:** Examine evidence gathering rather than confident customer intuition.

**Strong answer target:** Explain whom you learned from, what recent behavior
or context you explored, and how questions avoided steering answers. Distinguish
observations from interpretations and describe a decision the evidence changed,
including the limits of the sample.

**Profile inputs/adaptation:** Participants, questions, observations, and resulting
choices. Support logs or shadowing can provide evidence. Direct research
ownership requires actual participation, not receiving a research summary.

**Acceptable alternatives:** Qualitative learning can be useful without statistical
representativeness. Partnering with research/product specialists is legitimate.

**Probes:** What surprised you? Which observation contradicted your assumption?

**Failure modes:** Leading questions, collecting compliments, or treating one
customer's request as evidence about all users.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Inquiry | Seeks approval of an existing solution | Explores concrete customer behavior and context |
| Evidence | Treats interpretations as direct observations | Separates what was observed from what it may mean |
| Decision effect | Cannot explain what learning changed | Connects findings to a choice with sampling limits |

**Provenance:** Editorial discovery question informed by [PT01](sources.md#additional-topic-research).

## P03 — How do you test a risky product assumption before building everything?

**Variants:** What would you validate first about this proposed product?

**Intent:** Examine whether an experiment resolves consequential uncertainty.

**Strong answer target:** Identify the assumption whose failure matters, the
evidence that would change the decision, and a proportionate test. Explain
participants, limitations, and how results affect the next investment rather
than treating all positive signals as validation.

**Profile inputs/adaptation:** Hypothesis, alternatives, user evidence, and
decision threshold. IC: feasibility tests. Cross-functional leader: customer,
usability, viability, or ethical assumptions with appropriate partners.

**Acceptable alternatives:** A prototype, observation, small trial, or technical
spike can fit. Some risks need stronger evidence than a quick test provides.

**Probes:** What result makes you stop? Does the test measure the actual assumption?

**Failure modes:** Building the whole solution first, vanity metrics, or moving
the success criterion after seeing results.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Assumption | Tests a convenient detail with little consequence | Targets a material uncertainty behind the choice |
| Test fit | Uses evidence unrelated to the hypothesis | Designs proportionate evidence and acknowledges limitations |
| Decision rule | Every result justifies continued investment | States how outcomes change the next decision |

**Provenance:** Practice extrapolation from [PT01](sources.md#additional-topic-research).

## P04 — How do you handle conflicting demands from important customers?

**Variants:** Sales promises a feature that disrupts the roadmap.

**Intent:** Examine prioritization beyond the loudest or largest request.

**Strong answer target:** Clarify actual commitments, customer impact, recurring
needs, business value, and implementation/support costs. Compare options with
commercial and product owners. Communicate a decision and its consequences
without inventing authority to cancel promises.

**Profile inputs/adaptation:** Commitments, customer segments, capacity, and
decision rights. IC: technical options. Leader: tradeoff discussion. Executive:
business accountability shared with peers.

**Acceptable alternatives:** A targeted solution, shared capability, workaround,
or refusal can be reasonable. One strategic customer can legitimately dominate.

**Probes:** What is already promised? Who bears the ongoing cost?

**Failure modes:** Blanket contempt for sales, prioritizing revenue without
costs, or promising everyone a bespoke solution.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Context | Assumes all requests are equally important | Examines commitments, affected users, and business stakes |
| Tradeoff | Chooses by volume of pressure | Compares value, capacity, and continuing obligations |
| Alignment | Makes promises outside authority | Reaches and communicates an accountable shared decision |

**Provenance:** Editorial synthesis; cross-functional outcome focus in [PC01](sources.md#additional-topic-research).

## P05 — A feature shipped but customers are not using it. What next?

**Variants:** How do you distinguish delivery success from product success?

**Intent:** Examine diagnosis after launch rather than celebrating output alone.

**Strong answer target:** Verify what “not using” means and whether measurement
is credible. Explore awareness, access, usability, need, and alternatives with
affected customers. Choose a bounded intervention or stopping decision and
check whether it changes the intended outcome.

**Profile inputs/adaptation:** Intended audience, adoption evidence, limitations,
and role. An engineer can investigate technical friction; ownership of product
strategy remains distinct from helping diagnose it.

**Acceptable alternatives:** Retire the feature, improve discovery, narrow the
audience, or accept low usage if it serves a valuable occasional need.

**Probes:** Who was expected to use it, and why? What evidence distinguishes causes?

**Failure modes:** Blaming users, adding features without learning, or equating
page visits with durable value.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Measurement | Assumes low usage from a vague impression | Defines intended use and checks evidence quality |
| Diagnosis | Prescribes marketing or more code immediately | Investigates plausible customer and system causes |
| Response | Declares launch complete success | Chooses a bounded change or stop and examines its effect |

**Provenance:** Editorial synthesis informed by [PT01](sources.md#additional-topic-research) and [L08](sources.md#will-larson).

## P06 — How do engineering, product, and design make decisions together?

**Variants:** Who decides when feasibility, usability, and business needs conflict?

**Intent:** Examine shared judgment with clear responsibility.

**Strong answer target:** Explain the common outcome, each discipline's
information and authority, and how disagreement becomes a decision. Use a real
example of testing assumptions or changing a plan, then show how implementation
and customer results fed back into the collaboration.

**Profile inputs/adaptation:** Decision, partners, mandate, and outcomes.
IC: contribution within a team. Leader: enabling the working relationship.
Do not claim sole product ownership from attending planning meetings.

**Acceptable alternatives:** Roles can overlap in small teams. Explicit escalation
can be useful when a decision exceeds team authority.

**Probes:** What did another discipline change your mind about? Who had final authority?

**Failure modes:** Sequential handoff as the only collaboration, consensus
without closure, or engineering veto power over every concern.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Shared outcome | Each function optimizes separate outputs | Establishes a meaningful common outcome |
| Decision mechanism | Disagreement has no resolution path | Clarifies input, authority, and timely closure |
| Learning | Collaboration ends at specification approval | Uses delivery and customer evidence to refine choices |

**Provenance:** Practice extrapolation from [PC01](sources.md#additional-topic-research).

## P07 — How do you connect an engineering choice to business viability?

**Variants:** How did operating costs or commercial constraints change your plan?

**Intent:** Examine business reasoning without invented financial causality.

**Strong answer target:** Identify the business mechanism: cost to serve,
revenue opportunity, retention, capacity, or risk. Explain assumptions and
options with responsible business partners. Distinguish expected effects from
measured outcomes and describe what would change the choice.

**Profile inputs/adaptation:** Available business evidence, contribution, and
authority. IC: a bounded cost or constraint. Executive: broader economics.
No financial metric is required if the candidate never had access to it.

**Acceptable alternatives:** A qualitative mechanism can be useful. Strategic
investment may be justified before immediate return is measurable.

**Probes:** Which cost is actually incremental? What part of the outcome can you claim?

**Failure modes:** Revenue attribution from proximity, free infrastructure
assumptions, or optimizing cost while destroying the user outcome.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Business mechanism | Says the work “drove revenue” without explanation | Connects the technical choice to a plausible business effect |
| Evidence limits | Treats forecasts as realized gains | Separates assumptions, observations, and ownership |
| Tradeoff | Optimizes one number without consequences | Compares value, cost, and relevant risk |

**Provenance:** Editorial business synthesis informed by [L04](sources.md#will-larson) and [PC01](sources.md#additional-topic-research).

## P08 — Tell me about an experiment that did not support your product idea

**Variants:** When did customer evidence make you abandon an appealing solution?

**Intent:** Examine interpretation and action when a hypothesis disappoints.

**Strong answer target:** State the hypothesis and decision criterion before
the test. Explain what happened, possible confounds, and what was actually learned.
Describe stopping, changing, or retesting with a specific reason rather than
calling every failure a success.

**Profile inputs/adaptation:** Original assumption, test design, results, and
personal decision. Technical experiment ownership does not imply responsibility
for every subsequent product decision.

**Acceptable alternatives:** An inconclusive result can merit another test.
Stopping can be the valuable outcome of a well-designed experiment.

**Probes:** What did the test fail to tell you? Did your success criterion change?

**Failure modes:** Hiding negative evidence, post-hoc success definitions,
or broad conclusions from a weak test.

| Dimension | Weak anchor (0) | Strong anchor (3) |
| --- | --- | --- |
| Prior hypothesis | Cannot state what the test was meant to decide | Gives an explicit assumption and intended decision |
| Interpretation | Treats any result as proof | Explains findings, confounds, and limits |
| Adaptation | Continues unchanged despite contrary evidence | Makes a justified stop, change, or targeted retest |

**Provenance:** Practice extrapolation from [PT01](sources.md#additional-topic-research).
