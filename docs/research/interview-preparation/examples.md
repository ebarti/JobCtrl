# Worked answers and evaluator examples

Every person, project, event, and result below is synthetic. These are original
illustrations of answer shapes, not user profile facts or authors' quotations.
Do not copy their achievements into a candidate's answer. A real draft must use
the candidate's own evidence and preserve uncertainty.

## C01: Three profile-specific introductions

### Staff IC

> I'm a backend engineer, and much of my recent work has been making changes
> across service boundaries easier to deliver. In my current role I led the
> design and rollout of a shared event interface. I owned the compatibility
> plan and worked with the service owners on adoption; they did most of the
> changes in their own services. That experience made me interested in work
> where the technical decision and how teams adopt it matter equally. This
> role appears to have that scope, and I'd like to understand how technical
> direction is shared between staff engineers and the team leads.

**Why it works:** Identifies a capability, a bounded contribution, and a reason
for the next role. It does not imply direct reports or claim every team's result.
**Useful follow-up:** What tradeoff shaped the compatibility plan?

### Engineering manager

> I manage a product engineering team. The part of the role I enjoy most is
> helping people take ownership of delivery while making difficult priorities
> explicit. During a recent launch, I worked with product to reduce the initial
> scope and helped two engineers lead the rollout. They owned the technical
> decisions; I handled expectations, staffing, and coaching. We delivered the
> agreed release, although we still had support work afterward. I'm looking
> for a role where I can keep developing engineers and improve how a team
> turns uncertain requirements into reliable commitments.

**Why it works:** Shows management actions and credits technical ownership.
The unfinished support work provides an honest limit.
**Useful follow-up:** How did reducing scope affect customers and the team?

### Engineering executive

> I lead engineering in a software business where customers need dependable
> integrations. My recent focus has been aligning engineering investment with
> the commitments sales and product make. I partnered with those leaders to
> separate urgent customer work from reusable integration capabilities, and
> changed ownership so teams could make more of those tradeoffs themselves.
> Engineering owned delivery; the commercial results also depended on product
> and sales. I'm interested in this opportunity because it seems to need that
> combination of technical direction and business coordination. I'd want to
> learn whether that is the mandate you actually have in mind.

**Why it works:** Connects organizational work to a business problem while
avoiding a claim of sole commercial causality.
**Useful follow-up:** Which investment did you decline, and why?

## M01: A first-time manager with transferable evidence

> I haven't formally managed people yet. As a tech lead, I found that helping
> engineers make their own decisions and improving our planning was work I
> wanted to do more of. I mentored a new colleague through their first rollout
> and coordinated our team's dependencies, but I haven't owned compensation
> or a formal performance process. I'm exploring management because I want
> responsibility for team effectiveness and development, and I'd want clear
> expectations and support as I learn the parts I haven't done.

**Evaluation:** Good role understanding and bounded evidence. Formal management
experience remains unestablished. Do not rewrite “tech lead” as “manager.”

## C05: A useful growth answer

> I used to hold onto uncertain work too long before asking for help. In one
> project, that meant our dependency risk reached my manager only when the
> delivery date was already threatened. I now flag uncertainty in the weekly
> planning discussion and name the decision I need help with. On the next
> project, we changed scope before committing to a date. I'm still working
> on doing this when I think I should be able to solve the problem myself.

**Evaluation:** Names a real pattern, effect, action, and continuing limitation.
An EM could discuss holding onto delegated decisions instead, but only if that
is their real experience. Do not infer that either is this user's weakness.

## B02: A failure with accountable reasoning

Sentence labels are for the evaluator illustration, not a recommended speaking style.

> [1] I committed our migration to a date before checking a dependency owned
> by another team. [2] I knew our code path was ready and assumed their
> interface would remain stable; I did not verify that assumption with its
> owner. [3] Their planned change meant our rollout could not use the original
> sequence, and we missed the date. [4] I explained my mistake to the team and
> stakeholders, then worked with the owner on a smaller compatible step.
> [5] For the next rollout, I added an explicit owner confirmation before we
> committed, and we found a conflict early enough to change the sequence.
> [6] That check helps with known dependencies; it does not eliminate every
> integration risk.

| B02 dimension | Proposed result | Answer evidence |
| --- | --- | --- |
| Responsibility | 3 | Sentences 1–4 identify the assumption and its consequence without blaming the other team |
| Decision analysis | 3 | Sentence 2 distinguishes what was known from what was assumed |
| Changed practice | 3 | Sentences 5–6 show a specific later action, observation, and boundary |

**Separate fact check:** In a real session, every episode fact and claimed
outcome would need its own support status. The answer's structure does not prove
the event happened. Missing corroboration alone does not make it fabricated.

## B03: Disagreement without a winner narrative

> Product wanted to launch the new workflow at once; I wanted a staged rollout
> because we had limited recovery options. Their concern was a customer
> commitment, not indifference to reliability. I laid out the recovery risk
> and asked which customers needed the new path immediately. We agreed to
> start with those customers and keep the old path available while we learned.
> I gave up a slower internal-only rollout, and product accepted a narrower
> first release. The launch worked for that group, though supporting both
> paths cost more than we initially expected.

**Evaluation:** Represents the other goal fairly, names a compromise, and
acknowledges a cost. Follow up on decision authority and how recovery was tested.
Do not assume “we agreed” means there was no pressure or unresolved concern.

## M03: Delegation with real autonomy

> I asked an engineer to lead a rollout they wanted to stretch into. We agreed
> that the outcome was a safe release with a recoverable fallback, not that
> they had to follow my implementation plan. They could choose the sequence
> and coordinate the service owners. I helped secure time from the partner
> team, and we agreed that a compatibility problem or a slip affecting the
> customer commitment should come to me. We reviewed the risks weekly.
> When their pilot exposed a missing assumption, they proposed changing the
> sequence. I asked about the consequences, supported their choice, and
> handled the changed stakeholder expectations. They remained the lead and
> presented the result. My responsibility was making the assignment feasible
> and staying accountable for the commitment.

**Evaluation:** Strong agreement, support, and retained accountability. Probe
whether the engineer's existing workload was reduced and how the rollout ended.
This is still incomplete evidence about the final outcome, even though it
demonstrates the delegation mechanism.

**Director adaptation:** Use a manager-owned team problem and describe manager
decision rights; do not merely substitute “manager” into this story. **Executive
adaptation:** Describe a functional mandate and business constraints using actual
authority. If those examples do not exist, use a labeled situational plan.

## M06: Difficult-feedback role-play

Scenario facts: a colleague interrupted two people before they could finish
explaining their concerns in yesterday's planning meeting.

> In yesterday's planning meeting, you started responding while two colleagues
> were still explaining their concerns. We made the decision without hearing
> the rest of their points. I'd like to understand what was happening from
> your perspective. For the next discussion, I want us to let each person
> finish and check that we've understood before responding. What would help
> you do that? Let's revisit it after the next planning meeting.

**Evaluation:** Uses scenario facts, explains impact, invites perspective, and
makes a request. If new information contradicts the scenario, investigate it;
do not give a high dialogue score just for asking a question and then ignoring
the answer. No diagnosis such as “you are arrogant” is supported.

## T04: Care and technical standards

> I'd first tell the junior that a difficult review doesn't determine whether
> they belong here, and ask what would help them work through it. I would
> then read the patch and review comments. We'd separate issues that must be
> fixed from optional preferences and agree the next technical step. I would
> speak with the reviewer privately about the dismissive comments and their
> effect, while recognizing any valid technical concerns. If the behavior
> were repeated or serious, I'd involve the responsible manager. I'd also
> look at whether our review expectations are clear enough to prevent this
> pattern. Supporting the engineer doesn't mean accepting unsafe code.

**Evaluation:** Covers all three dimensions for a situational answer. It is a
plan, not evidence of an incident handled. Probe the concrete first words and
how the candidate would act if they lacked authority over the reviewer.

## E02: A context-sensitive entry plan

> I'd first agree with the CEO and my peers on what success in this role means.
> My initial questions would be how the business earns and spends money,
> which commitments are at risk, and how engineering decisions get made. I'd
> meet the leaders and teams involved, review actual customer and delivery
> evidence, and share observations so people can correct my understanding.
> I would not wait three months to address an urgent known risk, but I'd
> avoid choosing a reorganization before diagnosing the problem. Once we
> agreed on the main constraint, I'd propose a small initial change with
> an owner and a check of whether it helped. The pace would depend on the
> size of the organization and the urgency; this is a starting hypothesis,
> not a promise that I know the company's problems already.

**Evaluation:** Useful learning agenda and uncertainty handling. Still needs
role-specific assumptions and a concrete action once more company facts are
available. Do not add a promised revenue increase to make the plan sound stronger.

## B01: Repairing a vague answer without adding facts

Given synthetic facts: the candidate wrote a rollout checklist after two
missed handoffs; a colleague later used it and noticed a missing approval before
release; no measured reduction in incidents exists.

**Weak answer:** “I'm a great collaborator. I improved our release process and
made everything much more efficient.”

**Truthful revision:** “After two missed handoffs, I wrote a checklist showing
the release steps and their owners. A colleague used it on the next release and
spotted an approval we hadn't completed. I don't have an incident-reduction
measurement, but it made that handoff clearer and caught a missing step.”

**Why this revision helps:** It uses only the supplied facts, establishes
contribution, and bounds the result. It does not convert a qualitative example
into an invented percentage improvement.

## DL08: Resolving a decision bottleneck

Synthetic facts: a staff engineer observed repeated waits for two teams to agree
on an event format. They proposed sample payloads, helped the owners choose an
interface, and observed one integration proceed. No overall delivery-speed
measurement exists.

> The teams were active, but the integration kept waiting on the event format.
> I listed the unresolved compatibility questions and prepared sample payloads
> so both owners could examine the same cases. They agreed the interface and
> recorded which team would handle later changes. The next integration proceeded.
> I can't claim an overall speed improvement from that one observation, but it
> showed this particular wait was a decision dependency rather than a lack of
> implementation effort. I would still examine capacity before applying that
> diagnosis to another delay.

**Evaluation:** Strong on bottleneck evidence and unblocking. Verification has
an honest bounded observation; probe subsequent integrations before claiming a
durable improvement. **EM adaptation:** Explain priority and owner agreements.
**Director adaptation:** Explain recurring authority gaps across teams using a
real example, not by enlarging this story.

## P03: Testing an assumption rather than collecting approval

Situational scenario: a team proposes an automated report because it believes
customers spend substantial time preparing updates manually.

> I'd first check the behavior behind the idea: which customers prepare these
> updates, what information they need, and where the work takes time. I'd ask
> them to walk through a recent update rather than asking if they'd like an
> automated report. If the problem is real, a small manually prepared example
> could help us learn whether the output fits their decision. That would not
> establish demand across the whole customer base or the feasibility of safe
> automation. We'd identify those remaining assumptions before committing to
> the full build, and agree what evidence would change our investment decision.

**Evaluation:** Good problem/assumption distinction and explicit test limits.
Still probe sample selection and a concrete decision criterion. **IC adaptation:**
Own a feasibility test and partner on customer evidence. **Engineering leader
adaptation:** Describe how discovery fits shared priorities and authority.

## G01: Developing a manager without taking over

Situational scenario: a new manager approves every small technical decision and
their team waits whenever they are unavailable.

> I'd ask the manager to walk me through decisions that waited and why they
> felt approval was necessary. We'd distinguish real risks from choices the
> team could own. Together we'd agree a small set of decision boundaries and
> how the manager would coach rather than prescribe. I'd support them in
> practicing those conversations and review actual examples afterward. I'd
> check whether the team could decide within those boundaries and whether
> risks remained visible. I wouldn't become the replacement approver; if a
> serious issue required intervention, I'd make its scope and duration explicit.

**Evaluation:** Demonstrates diagnosis, supported ownership, and a useful effect
check. This is a plan, not past management-of-managers experience. **Peer/IC
adaptation:** Offer observations and support to the responsible manager; do not
claim the authority to set their team's management expectations.

## AI02: Bounding a productivity claim

Synthetic facts: a manager's team piloted AI on routine test scaffolding. People
reported faster drafting; review effort and defects were not yet compared.

**Weak answer:** “AI increased our engineering productivity by 40%, so we can
deliver the same roadmap with fewer engineers.” The supplied facts support neither claim.

**Truthful revision:** “The team reported faster drafting for routine test
scaffolding. We haven't compared total effort, review work, or defects, so I
wouldn't translate that into a team-capacity gain. I'd examine similar tasks,
including which ones people chose to use AI on, and track the work through review.
We can continue the bounded pilot while gathering that evidence. Broader roadmap
or staffing assumptions need stronger support than the drafting observation.”

| Dimension | Proposed assessment | Reason |
| --- | --- | --- |
| Outcome | 2 | Names downstream quality and effort, but measurements remain future work |
| Comparison | 2 | Recognizes similar-task comparison and selection; details still need a probe |
| Inference | 3 | Explicitly bounds the claim and rejects unsupported capacity extrapolation |

**Factual support:** The pilot and reports are synthetic facts; the measurement
plan is hypothetical. These are example human judgments, not a model evaluation
result. **IC adaptation:** Discuss one's own bounded task comparison. **Executive
adaptation:** Explain what evidence supports investment choices without turning
this manager's pilot into a company-wide transformation.

## C07: Seek the range before naming a number

This is a synthetic dialogue illustrating the coaching default, not a candidate's
compensation history or a guarantee that an employer will disclose its range.

Recruiter: “What salary are you looking for?”

Candidate: “Before I give a number, what is the budgeted base range for this
role and level, and how does the rest of the package work?”

Recruiter: “It depends on the person. What would you need?”

Candidate: “I understand there may be flexibility. I'd still like to understand
the range you've budgeted for this hire before setting an expectation. Can you
share that band, or check with the hiring team?”

Recruiter: “We have a broad band spanning several levels.”

Candidate: “Which level are you considering for this role, and what range applies
to that level and location? Is the band base salary or total compensation?”

If they still refuse, the candidate chooses a truthful next step. “I'm not ready
to set a number before understanding the scope and package. Let's clarify those
first and return to compensation” is one option. A deliberate target or a
decision not to continue can also be appropriate; do not invent the user's
leverage, minimum, or willingness to stop.

The useful behaviors are seeking information before anchoring, persisting
professionally, clarifying the actual package, and retaining a plan under
pressure. Length, charm, aggressiveness, and the salary obtained are not rubric
dimensions. If a usable band is already disclosed, do not repeat the opening
mechanically.

## B11: Good reasoning and outcomes are separate questions

Synthetic principle answer:

“A good decision is a defensible choice for the objective and constraints, using
the information we could reasonably obtain at the time. I want to understand
the alternatives, the important downside, and why the timing makes sense. I also
want someone able to carry it out and a way to notice when an assumption fails.
The amount of analysis should fit the stakes. Waiting can be right, but it has
a cost too.

“Suppose we deliberately limit a pilot to a reversible experiment because we
have weak evidence about adoption. Low adoption would be a disappointing result,
but it would not by itself mean the decision to run the pilot was bad. In the
opposite direction, a rollout that ignores a known serious failure path does not
become well judged just because no failure happens that week. I would examine
the original rationale separately from the result, then use the result to
improve the next choice.”

| Dimension | What the answer demonstrates | Useful follow-up |
| --- | --- | --- |
| Decision criterion | Objective, constraints, feasible information, and proportionate timing | Which tradeoff was decisive in an actual decision? |
| Reasoning under uncertainty | A bounded experiment and an explicitly unaddressed risk are different | When would more investigation have been worth its cost? |
| Evaluation and learning | A good outcome is not proof, and contrary evidence still matters | What later evidence changed the policy rather than only one choice? |

These hypothetical cases establish reasoning only. Ask for an actual episode
if the interview also needs evidence of demonstrated behavior.

## TS09: A technically appropriate choice can later need replacement

Synthetic principle answer:

“A good technical decision fits the problem and the team that must deliver and
operate it. I'd first identify the required behavior and the decisive
constraints, then compare plausible approaches on the costs and failure paths
that matter. The technically most elegant option can be worse if its migration
and operating burden outweigh the benefit. I'd make the important uncertainty
visible and explain how we would verify or revisit the choice.

“For a small team with one product, staying with an existing monolith could be
sound when it meets the workload, consistency, and release needs and lets the
team focus on the product. If later teams need independent changes or a measured
bottleneck emerges, that original choice is not automatically a mistake. We
would assess the new constraints and compare an incremental repair with stronger
separation. Conversely, a cheap initial build is not good if it leaves essential
recovery or data integrity requirements unsupported.”

| Dimension | What the answer demonstrates | Useful follow-up |
| --- | --- | --- |
| Problem and technical fit | Required behavior and relevant workload matter more than a fashionable architecture | Explain the mechanism behind a decisive requirement in your example. |
| Whole-system tradeoffs | Initial delivery and ongoing adoption/operation can point to different choices | Who bears the cost, and why is it acceptable? |
| Risk and evolution | Changed context differs from ignored original constraints | What concrete signal would trigger reconsideration, and how costly is the transition? |

Neither a monolith nor services receive automatic credit. In a real answer,
technical depth and evidence must support the claimed fit; this illustration
does not establish that any particular candidate has made that decision.

## Evaluation edge cases

These expected treatments are editorial fixtures for review, not measured
results from a model or an independent human panel.

| Case | Expected treatment |
| --- | --- |
| Strong answer with a previously unrecorded truthful outcome | Mark `new_user_statement`; assess content separately and request confirmation for canonical reuse |
| Accepted profile says contributor; answer says sole program owner | Mark `needs_clarification`; identify the exact ownership conflict rather than silently rewriting the profile |
| Candidate gives no exact metric for a concrete useful change | Assess the observation; do not invent a metric or automatically lower the result |
| Same reasoning expressed briefly or with imperfect grammar | Preserve substantive assessment; ask clarification if needed |
| Respectful, evidence-based decision differs from evaluator preference | Judge reasoning and constraints; do not deduct for choosing a different tool or organization shape |
| Good decision followed by an external setback | Examine information available at the time and response; do not equate bad outcome with bad judgment |
| Successful outcome after a reckless decision | Do not use the result to excuse the unaddressed risk |
| First-time manager describes a plausible performance plan | Label situational; management reasoning can be assessed while prior experience stays unestablished |
| Recruiter ends before candidate questions | C10 dimensions are `not_observed`, not zero or “not interested” |
| Candidate declines private career-gap details | Respect the boundary; grade only the relevant professional explanation supplied |
| Candidate asks for employer compensation range before naming theirs | C07 default: examine information seeking, package clarity, and professional persistence; never grade salary level or private needs |
| Candidate gives a deliberate target after the employer refuses disclosure | Examine the reasoning and truthful response; do not treat a chosen exception as a competency defect |
| Candidate answers a good-decision question with criteria and a hypothetical counterexample | Assess principle reasoning; do not demand or infer historical experience from the example |
| Confidential example uses anonymized roles and qualitative outcomes | Preserve abstraction; probe reasoning without demanding protected details |
| Model-generated story sounds compelling but adds unsupported authority | Require revision; presentation quality cannot establish factual support |
| Role-play starts with good feedback wording but ignores the response | Dialogue dimension remains weak; a framework recitation is insufficient |
| Candidate chooses a live conversation rather than async communication | Assess channel fit and access; do not penalize disagreement with a company's handbook default |
| Candidate cites a published AI productivity result from another setting | Assess whether its population, tasks, and limitations fit; do not transfer the percentage automatically |
| Candidate describes a humane reduction plan without naming employment-law steps | Assess leadership judgment and appropriate specialist involvement; do not invent jurisdictional requirements |
| Candidate changes career direction for priorities they decline to explain privately | Assess the disclosed professional reasoning; boundaries and priorities are ungraded |
| Manager-of-managers plan is strong but the candidate has only managed ICs | Assess situational reasoning and mark the experience boundary; do not promote it to demonstrated director experience |
| Internal platform usage is mandatory but consumer work becomes harder | Do not treat adoption count alone as value; examine consumer benefit and transferred burden |

See [calibration](evaluation.md#calibration-before-product-use) before treating
these intended behaviors as a reliable automated evaluator.
