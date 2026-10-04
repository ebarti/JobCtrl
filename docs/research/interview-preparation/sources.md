# Research and source ledger

Initial research checked on 30 September 2026; decision-quality and negotiation
follow-up checked on 1 October 2026. Will Larson and Michael Lopp are the
central references. Additional contemporary engineering leaders supply concrete
practices and useful counterpoints. Older publications remain included where
they explain a current practice; dates are visible rather than treating all
advice as recent.

## Findings and tensions

The following is our synthesis. Each source below records the narrower author
claim that informed it. Question wording, profile mappings, scoring dimensions,
numeric anchors, and sample answers are ours unless explicitly stated otherwise.

| Perspective | Implication for our content | Limit or tension |
| --- | --- | --- |
| Larson: assess the skills the particular role needs | Ask for evidence of relevant judgment; use role-specific criteria | A polished story alone cannot establish actual performance |
| Lopp: concrete professional stories and reflection | Probe decisions, feedback, growth, and candidate curiosity | His reflection questionnaire explicitly has no right answer or grade |
| Fournier: management includes delivery and people work | Separate manager contribution from coding and architecture | First-time managers need transferable evidence, not an invented management history |
| Hogan: make feedback and delegation concrete | Ask what was communicated, agreed, supported, and revisited | Naming a framework is weaker than demonstrating its use |
| Reilly: staff work includes enabling others | Value coordination, adoption, and shared capability | Helping everyone can become an unrecognized burden rather than sustainable leadership |
| Majors: management is a distinct career track | Accept an intentional IC career or a return to it | Do not treat management as the default definition of advancement |
| Huston: team success must be sustainable | Look for team capability and health alongside delivery | Constant availability is not a useful leadership quality proxy |
| Buriticá and Turnbull: technical collaboration includes care and standards | Examine how candidates handle review conflict and power | Kindness does not require accepting defective code |
| Skelton/Pais: team interfaces and consumer burden matter | Examine decision rights and platform usefulness | Framework vocabulary is not evidence of judgment |
| Torres: discovery and evaluation need explicit assumptions | Ask what evidence would change a product or AI decision | A promising demonstration cannot establish general usefulness |
| Edmondson: candor and accountability can coexist | Examine routes for questions, concerns, and dissent | Silence alone does not reveal someone's psychological state |
| Osmani: AI assistance still needs human judgment | Examine learning, verification, and ownership | His broad productivity claims are not our assumed baseline |
| METR: productivity estimates depend on task selection and study design | Require bounded inference from local AI evidence | One study does not establish a universal speedup or slowdown |
| Google SRE and GitLab: operating practices need clear ownership and communication | Examine response roles, decision records, and work access | Specific company policies and thresholds are examples, not hiring rules |
| Structured-interview methodology | Anchor feedback to observable answer content | A structured format does not automatically validate our rubric |

Five tensions require explicit editorial decisions:

1. **Chemistry and polish.** Lopp's older screening essay uses conversational
   impressions. Larson warns about accidentally assessing polish. We evaluate
   understandable, relevant content; we do not score eye contact, accent,
   enthusiasm, pauses, social similarity, or whether someone asks a question
   before time runs out.
2. **Potential versus demonstrated experience.** Fournier discusses hiring
   first-time managers; Larson's loop design emphasizes demonstrated skills.
   We label transferable evidence separately and allow situational exercises.
   A hypothetical plan never becomes evidence that the candidate has done it.
3. **Hands-on leadership.** Majors and Larson discuss technical currency and
   changing expectations. We require alignment with the actual role, not a
   fixed coding percentage for every manager. Inspecting important work and
   prescribing every implementation detail are different behaviors.
4. **Deciding versus delegating.** Lopp's R07 criticizes a delegated decision
   described as escaping its consequences, whereas Hogan's H02 explains useful
   delegation. We distinguish clear authority and retained accountability from
   avoidance; we do not turn either essay into an absolute rule about who must
   make every decision.
5. **Decision quality versus hindsight.** L10 distinguishes decisions from
   outcomes; L21 explains why designs can reasonably fall behind a changing
   quality bar. We examine original reasoning and current fit separately, and
   still use subsequent evidence to test assumptions. A good-looking process
   is not immunity from learning or consequences.

## Source records

Coverage labels: **article** means the author article was read; **selected
chapter/talk** means identified passages were read, not the whole work; **overview** means
only the author's or publisher's description was reviewed. An overview does not
support detailed claims about unread chapters. Where a date is not listed, the
page was verified but its original publication date was not established here.

### Will Larson

- **L01 — [Getting to yes](https://lethain.com/getting-to-yes/)** (2021; article).
  Begin manager hiring with shared role expectations and essential skills.
  Used for role selection and M01.
- **L02 — [Designing interview loops](https://lethain.com/designing-interview-loops/)**
  (2018; article). Explicit skill rubrics and opportunities to demonstrate them;
  avoid accidentally assessing presentation polish. Used for evaluation design.
- **L03 — [Interviewing senior engineering leaders](https://lethain.com/interviewing-senior-eng-leaders/)**
  (2020; article). Exercises can reveal leadership judgment through editing,
  analysis, and feedback. Used for M06 and E04. We do not adopt backchannel checks.
- **L04 — [Interviewing engineering executives](https://lethain.com/interviewing-eng-executives/)**
  (2023; article). Examine executive skills, company challenges, functional
  expertise, and historical behavior. Used for executive question selection.
- **L05 — [Getting an engineering executive job](https://lethain.com/getting-engineering-executive-job/)**
  (2023; article). Clarify motivation, prepare relevant experiences, and learn
  the company's needs. Used for C02 and executive adaptations.
- **L06 — [Interviewing for staff-plus roles](https://staffeng.com/guides/interviewing-staff-plus-roles/)**
  (article/guide). Staff loops vary; understand format and prepare relevant work
  deep dives. Used for T01 and preparation selection.
- **L07 — [Diagnosis for strategy](https://lethain.com/diagnosis-for-strategy/)**
  (22 February 2025; article). Investigate facts, perspectives, and constraints
  before choosing a solution. Used for B05 and E01.
- **L08 — [Is this strategy any good?](https://lethain.com/is-this-strategy-any-good/)**
  (27 March 2025; article). Evaluate strategy through impact and refinement;
  learning costs matter. Used for B08 and E01.
- **L09 — [Good engineering management is a fad](https://lethain.com/good-eng-mgmt-is-a-fad/)**
  (26 October 2025; article). Management expectations change; execution, team,
  ownership, and alignment remain useful concerns. Used for M02 and M09.
- **L10 — [Inspected trust](https://lethain.com/inspection/)**
  (2021; article). Inspect important interpretations; distinguish decisions
  from outcomes. Used for B02, T02, and E04.
- **L11 — [Measuring engineering organizations](https://lethain.com/measuring-engineering-organizations/)**
  (2023; article/book chapter). Measures serve different decisions and
  stakeholders. Used for E05; no individual output leaderboard is prescribed.
- **L12 — [Your first 90 days as CTO or VP Engineering](https://lethain.com/first-ninety-days-cto-vpe/)**
  (article/book chapter). Learn business and organizational context; adapt
  onboarding to urgency and company size. Used for E02.
- **L13 — [Roadmap decisions rather than dates](https://lethain.com/decisions-not-dates/)**
  (11 August 2026; article). Unresolved decisions and dependencies can constrain
  execution; make them explicit and use exploration to resolve them. Used for
  DL08. We do not assume that every delay is a decision problem.
- **L14 — [Moving from an orchestration-heavy to leadership-heavy management role](https://lethain.com/orchestration-heavy-leadership-heavy/)**
  (19 July 2025; article). Selecting problems and solutions can be a distinct
  responsibility from orchestrating execution. Used for P01/LQ05; the actual
  role determines whether this responsibility belongs to the candidate.
- **L15 — [How to create software quality](https://lethain.com/quality/)**
  (16 June 2024; selected article sections on quality, context, and complexity).
  Quality expectations depend on the system and its consequences. Used for
  DL06/TS06; no universal test count or release procedure is prescribed.
- **L16 — [How should we control access to user data?](https://lethain.com/user-data-access-strategy/)**
  (7 February 2025; article/public strategy chapter). Access controls must fit
  legitimate workflows and support auditable decisions. Used for K07/AI06;
  the essay's hypothetical thresholds are not universal requirements.
- **L17 — [Performance & Compensation (for Eng Execs)](https://lethain.com/performance-compensation-process-exec/)**
  (3 September 2023; selected sections on competing goals, levels, and
  calibration). People processes involve fairness, feedback, cost, and time
  tradeoffs. Used for HR04/HR05/HR06; not a universal compensation formula.
- **L18 — [Running your engineering onboarding program](https://lethain.com/engineering-onboarding-programs/)**
  (6 March 2023; selected introduction and program-role sections). Onboarding
  needs ownership and an ongoing program adapted to new hires. Used for HR01;
  no fixed duration is required.
- **L19 — [Engineering's role in Mergers & Acquisitions](https://lethain.com/engineering-in-mergers-and-acquisition/)**
  (27 February 2023; selected evaluation and integration sections). Engineering
  should understand the acquisition thesis, technical risks, and integration
  consequences. Used for G05; not legal or investment guidance.
- **L20 — [Writing an engineering strategy](https://lethain.com/eng-strategies/)**
  (13 February 2023; selected diagnosis, guiding-policy, decision-rights, and
  transition sections; follow-up checked 1 October 2026). Technical choices
  should connect to the organization's circumstances and shared direction.
  Used for TS09; his example approval processes are not universal requirements.
- **L21 — [Managing technical quality in a codebase](https://lethain.com/managing-technical-quality/)**
  (17 October 2020; selected opening, problem, and lightweight-intervention
  sections; follow-up checked 1 October 2026). Requirements and appropriate
  quality investment change as a company changes. Used for TS09; a design's
  current limitations do not alone prove that its original choice was unsound.

### Michael Lopp

- **R01 — [The Sanity Check](https://randsinrepose.com/archives/the-sanity-check/)**
  (2007; article). A screen explores professional history, communication, and
  candidate questions. Used for C01/C10, with the chemistry limits above.
- **R02 — [Your Professional Growth Questionnaire](https://randsinrepose.com/archives/your-professional-growth-questionnaire/)**
  (2018; article). Reflect on strengths, growth, feedback, failures, and desired
  next work. Explicitly not a graded questionnaire. Used for C04/C05/C09/B04.
- **R03 — [Act Last, Read the Room, and Taste the Soup](https://randsinrepose.com/archives/act-last-read-the-room-and-taste-the-soup/)**
  (2018; article). Hear other perspectives before anchoring decisions; inspect
  without solving everything yourself. Used for B03/B07/M03.
- **R04 — [A Performance Question](https://randsinrepose.com/archives/a-performance-question/)**
  (2018; article). Performance concerns should receive clear feedback and a
  chance for dialogue before formal escalation. Used for M05, not legal advice.
- **R05 — [Barely Treading Water](https://randsinrepose.com/archives/barely-treading-water/)**
  (19 May 2026; article). Admit overload, seek candid help, reprioritize,
  delegate, and communicate refusals. Used for B06/B09.
- **R06 — [The Update, The Vent, and The Disaster](https://randsinrepose.com/archives/the-update-the-vent-and-the-disaster/)**
  (2010; article). One-to-ones offer listening and learning beyond status.
  Used for M07. We adapt rigid cadence recommendations and do not adopt mood
  classifications as an interview-scoring method.
- **R07 — [Seven Decisions](https://randsinrepose.com/archives/seven-decisions/)**
  (11 November 2025; article; follow-up checked 1 October 2026). Examines
  explainable rationale, decision context, and choices that avoid discomfort or
  responsibility. Used for B11. Its categories are reflective observations,
  not a validated hierarchy or a prohibition on accountable delegation.

### Other contemporary leaders

- **H01 — Lara Hogan, [The Feedback Equation](https://larahogan.me/blog/feedback-equation/)**
  (2018; article). Separate observations from judgments, explain impact, and
  invite response or action. Used for M06/B04.
- **H02 — Lara Hogan, [Delegation is an art](https://larahogan.me/blog/delegation-is-an-art/)**
  (2022; article). Agree outcomes, support, and escalation conditions while
  giving the delegate room to choose the approach. Used for M03.
- **H03 — Lara Hogan, [What are you optimizing for?](https://larahogan.me/blog/what-are-you-optimizing-for/)**
  (2019; article). Explore another person's priorities rather than assuming
  shared goals. Used for B03/B07/M10.
- **H04 — Lara Hogan, [When to delegate, when to say no](https://larahogan.me/blog/when-to-delegate-when-to-say-no/)**
  (2022; article). Consider the work and the person's circumstances when
  prioritizing or delegating. Used for B06/M04.
- **H05 — Lara Hogan, [Why can't they just...? Revisited](https://larahogan.me/blog/why-cant-they-just-revisited/)**
  (22 April 2026; article). Understand legitimate concerns, share constraints,
  and distinguish what people can control or influence. Used for G08/LQ01;
  raising a problem does not require already knowing the solution.
- **H06 — Lara Hogan, [AI 'aha' team meetings](https://larahogan.me/blog/ai-aha-team-meetings/)**
  (20 March 2026; article). Peer learning can make AI experimentation and
  mistakes discussable. Used for AI04. A meeting is one option, not a required
  learning style or a reason to pressure people to disclose mistakes publicly.
- **H07 — Lara Hogan, [Recognition and rewards at work](https://larahogan.me/blog/what-you-recognize-and-reward/)**
  (6 March 2023; selected introductory principle). What an organization
  recognizes and rewards communicates its priorities. Used for K05; detailed
  reward-system design on our card is editorial synthesis.
- **F01 — Camille Fournier, [Ask the CTO: How do I hire managers?](https://www.oreilly.com/content/ask-the-cto-how-do-i-hire-managers/)**
  (2016; article). Direct interview guidance: probe delivery, mentoring,
  process, hiring, goals, and conflict with examples or role-play. Used for
  M01/M04/M07/M08/M10. Our cards paraphrase themes, not her full question list.
- **TR01 — Tanya Reilly, [Being Glue](https://www.noidea.dog/glue)**
  (2018 talk; selected author-transcript sections on glue, promotion, and track
  choice). Coordination work enables teams but can
  become an unfair or career-limiting burden. Used for T05.
- **TR02 — Tanya Reilly, [The Staff Engineer's Path](https://www.noidea.dog/staff)**
  (author overview). Describes big-picture thinking, project execution, and
  enabling others. Used to organize the IC family; full book not read here.
- **TR03 — Tanya Reilly, [How to make a big technical change](https://www.noidea.dog/blog/getting-there-from-here)**
  (2018; article). A migration requires adoption work and a completion measure,
  not only a new implementation. Used for technical change; we do not prescribe
  the essay's suggestions to intentionally degrade an old service.
- **TR04 — Tanya Reilly, [Delegation means not answering all the questions](https://www.noidea.dog/blog/delegation-means-not-answering-all-the-questions)**
  (2018; article). Redirect decisions to their owner rather than intercepting
  communications and visibility. Used for enabling others.
- **J01 — Charity Majors, [The Engineer/Manager Pendulum](https://charity.wtf/p/the-engineer-manager-pendulum)**
  (2017; article). IC and management careers can alternate; management is a
  distinct profession. Used for C09/M01; technical-currency advice is contextual.
- **U01 — Cate Huston, [The Engineering Leader, chapter 14: What Good Looks Like](https://www.oreilly.com/library/view/the-engineering-leader/9781098154059/ch14.html)**
  (2024; selected chapter). Sustainable team functioning, feedback, growth, and
  healthy conflict matter more than a leader's constant availability. Used for
  B01/M09. Public publisher preview linked; selected chapter read separately.
- **U02 — Juan Pablo Buriticá and James Turnbull, [Engineering Leadership: The Hard Parts, chapter 9](https://www.oreilly.com/library/view/engineering-leadership-the/9781098175627/ch09.html)**
  (January 2026; selected passage, “Navigating code-review drama”). A harsh
  review scenario tests care, actual code assessment, and coaching; Turnbull
  explicitly describes using it in senior-engineer interviews. Used for T04.
- **D01 — Sarah Drasner, [Engineering Management for the Rest of Us](https://www.engmanagement.dev/)**
  (2022; author overview). Frames leadership around people and learned practice.
  Supplementary reading; no detailed card criteria attributed to the unread book.

### Additional topic research

- **DM01 — Dan McKinley, [Choose Boring Technology](https://mcfunley.com/choose-boring-technology)**
  (30 March 2015; article; follow-up checked 1 October 2026). Technology costs
  include operations and cognitive burden across the organization; novelty
  needs a reason that existing options cannot serve well. Used for TS09.
  Familiar tools are a contextual default, not an absolute ban on innovation;
  examples from 2015 are not current product recommendations.
- **TP01 — Matthew Skelton and Manuel Pais, [Team Topologies: Key Concepts](https://teamtopologies.com/key-concepts)**
  (official concept guide). Team interfaces, cognitive load, and platforms as
  products inform G03/TS03. We do not require candidates to memorize team types
  or treat the model as universally appropriate; full book not read here.
- **OS01 — Addy Osmani, [Leading Effective Engineering Teams in the Age of GenAI](https://addyo.substack.com/p/leading-effective-engineering-teams-c9b)**
  (19 March 2025; selected opening and leadership sections). Human judgment,
  learning, and verification remain important alongside AI assistance. Used
  for AI01/AI03; the essay's broad productivity claims are not adopted as facts.
- **ME01 — METR, [We are Changing our Developer Productivity Experiment Design](https://metr.org/blog/2026-02-24-uplift-update/)**
  (24 February 2026; research update). Selection effects, changing tasks, and
  concurrent work complicate productivity estimates; the authors caution
  against a reliable current uplift estimate from their new data. Used for
  AI02. Earlier results from a specific setting are not generalized to all teams.
- **GI01 — GitLab, [Communication handbook](https://handbook.gitlab.com/handbook/communication/)**
  (live organizational handbook checked 30 September 2026; selected async,
  written conclusions, availability, and clear-communication sections). Inform
  W01/W04/W05/W08. One company's policies are examples, not universal standards.
- **AE01 — Amy Edmondson, [Leading in Tough Times](https://www.hbs.edu/recruiting/guides-and-stories/leading-in-tough-times)**
  (22 November 2022; Harvard Business School author discussion). Psychological
  safety supports candor and participation alongside accountability. Used for
  K01/K08; no personality or psychological diagnosis is inferred from answers.
- **PT01 — Teresa Torres, [Assumption Testing](https://www.producttalk.org/assumption-testing/)**
  (18 October 2023; selected introduction, assumption types, and testing
  sections). Test the assumptions behind options rather than only asking
  whether people like a solution. Used for P02/P03/P08.
- **PT02 — Teresa Torres, [AI Evals: A Hands-On Guide for Product Teams](https://www.producttalk.org/ai-evals/)**
  (2 September 2026; selected opening and correctness sections). Define useful,
  context-specific output and inspect errors rather than delegating correctness
  to the model provider. Used for AI05/AI07. Her interview-coach example concerns
  customer-discovery interviews; application to job interviews is our extrapolation.
- **SR01 — Google, [SRE Workbook: Example Error Budget Policy](https://sre.google/workbook/error-budget-policy/)**
  (2018; public example). Balance reliability and feature work through explicit
  expectations and decisions. Used for O02; example thresholds are not mandates.
- **SR02 — Google, [SRE Workbook: Incident Response](https://sre.google/workbook/incident-response/)**
  (2018; selected response-role discussion and incident cases). Coordination,
  mitigation, and communication require deliberate ownership. Used for O01/O07;
  incident process should fit the organization's scale and risk.
- **PC01 — Marty Cagan, [Meaningful Transformation](https://www.svpg.com/meaningful-transformation/)**
  (14 May 2020; article). Product outcomes depend on collaboration, trust, and
  real decision authority. Used for P06/G08; we do not require every organization
  to adopt a single product operating model.

### Negotiation

- **N01 — Patrick McKenzie, [Salary Negotiation: Make More Money, Be More Valued](https://www.kalzumeus.com/2012/01/23/salary-negotiation/)**
  (23 January 2012; selected first-number and package sections; follow-up
  checked 1 October 2026). Argues for avoiding a premature candidate anchor
  and examining the package. Used narrowly for C07, with the user-requested
  employer-range-first default. This older tactical reference supplies no
  current salary data. We do not adopt its claims about universal leverage,
  risk-free negotiation, market conditions, or artificial form-entry numbers.

### Evaluation methodology

- **A01 — US Office of Personnel Management, [Developing a customized rating scale](https://www.opm.gov/frequently-asked-questions/assessment-policy-faq/structured-interviews/how-do-i-develop-a-customized-rating-scale-for-structured-interviews/)**
  (agency guidance). Behavioral anchors are question-specific and need subject
  matter expert involvement. Used for calibration methodology, not an assertion
  that this content has been validated or is an official hiring instrument.

## Books and further reading

These are reading paths, not claims to have read every book cover to cover for
this study. Articles or the explicitly identified passages above are the basis
for attributed claims. The two Larson books share material with linked essays;
that is one source of advice, not independent corroboration.

| Book/resource | Why include it | Coverage in this research |
| --- | --- | --- |
| Larson, *The Engineering Executive's Primer* | Business responsibility, operating systems, resources, executive transitions | Linked public chapters/essays, especially L11/L12 |
| Larson, *Staff Engineer* and StaffEng guides | Staff role variation and interview preparation | L06 and related author guide; not full book |
| Lopp, *The Art of Leadership* (2020) | Concrete manager behaviors and reflective practice | Related author essays R02–R04; not full book |
| Fournier, *The Manager's Path* (2017) | Changes in responsibility from mentoring to senior management | Supplementary bibliography; F01 is the direct interview source |
| Hogan, *Resilient Management* (2019) | Feedback, coaching, support, and delegation | Public practice essays H01–H04; not full book |
| Reilly, *The Staff Engineer's Path* (2022) | Technical leadership beyond individual implementation | Author overview TR02 and independent talk TR01 |
| Huston, *The Engineering Leader* (2024) | Developing people and sustainable leadership | Selected chapter U01 |
| Buriticá/Turnbull, *Engineering Leadership: The Hard Parts* (2026) | Contemporary technical collaboration and difficult leadership situations | Selected passage U02 |
| Drasner, *Engineering Management for the Rest of Us* (2022) | People-centered engineering management | Author overview D01; supplementary |
| Larson, *Crafting Engineering Strategy* | Diagnosis, coherent technical direction, and concrete strategies | Selected public chapter L16 and related essays; not full book |
| Skelton/Pais, *Team Topologies* | Team boundaries, interactions, and internal platforms | Official concepts TP01; not full book |
| Osmani, *Leading Effective Engineering Teams* | Engineering leadership and AI-related operating changes | Selected related author essay OS01; not full book |
| Torres, *Continuous Discovery Habits* | Customer discovery and assumption testing | Related author articles PT01/PT02; not full book |
| Edmondson, *The Fearless Organization* | Candor, participation, and accountability | Author discussion AE01; not full book |
| Google, *The Site Reliability Workbook* | Operational decisions and service reliability | Public selected chapters SR01/SR02 |

## Attribution on question cards

**Direct interview guidance** means a source discusses interviewing for that
question/theme. **Practice extrapolation** means a leadership practice has been
translated into a question and answer criteria. **Editorial synthesis** means
the wording and target are chiefly our proposal, with a source providing limited
context. Even direct guidance does not make our numeric anchors author-approved.

No source establishes a universal “correct” answer, a validated leadership
score, or a hiring probability. The library intentionally records alternatives
and limits so that an evaluator can distinguish unfamiliar choices from poor
reasoning.
