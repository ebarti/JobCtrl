# Personalization and answer evaluation

This is a proposed content evaluation method for interview rehearsal. It grades
what an answer demonstrates, keeps factual support separate, and identifies the
next useful improvement. It does not grade the person or establish that they
can perform the job.

## Inputs before drafting or evaluating

1. **Question and format:** card ID, exact wording, historical/situational
   variant, principle/concept, negotiation, or role-play; recruiter screen or
   deeper interview; and any known time allowance.
2. **Target context:** responsibilities, company stage, industry constraints,
   required capabilities, and the actual interview criteria if supplied.
3. **Profile facts:** accepted roles, dates, scope, contribution, collaborators,
   decisions, outcomes, metrics with definitions/timeframes, and evidence IDs.
4. **Experience inventory:** user-described episodes, including failures,
   feedback, uncertainties, and examples of work through others.
5. **User choices:** career goals, boundaries, compensation preferences,
   logistics, accessibility preferences, and what they consent to discuss.
6. **Answer transcript:** the user's words, with sentence/segment references.
   Text-only practice can use typed answers; this content does not require
   recording, microphone access, or live interview assistance.

Missing profile facts should produce a focused request or a marked draft slot.
They must not be filled by inventing achievements, tools, teams, metrics, or
authority. A role-specific example can be narrower than the target role when the
candidate clearly states that boundary.

## Keep four kinds of statement separate

| Kind | Treatment |
| --- | --- |
| Accepted profile fact | Reference the source ID and preserve its scope and qualification |
| New user recollection | Attribute to the user; request confirmation before any canonical reuse |
| Hypothetical intention | Evaluate the reasoning; never present it as past experience |
| Evaluator inference | Label as interpretation and show the answer passage that supports it |

New statements are **unverified**, not automatically false. Missing corroboration
is not proof of fabrication. A contradiction with an accepted fact triggers
clarification: the accepted fact may also need correction. Company assumptions
must be similarly labeled; a public job ad does not establish internal causes.

Generated stories and feedback do not update Candidate Profile facts, fit
scores, or readiness assessments. Any later profile promotion requires its own
explicit review flow. This document proposes content behavior; it does not add
that flow to the product.

## Evaluate in two separate passes

**Pass 1: factual and privacy support.** Identify each material factual claim and
mark it `supported`, `new_user_statement`, `needs_clarification`, or
`hypothetical`. Show the source or exact conflict. Flag confidential details for
redaction without penalizing the candidate for preserving confidentiality.
Unavailable exact numbers can become an honest qualitative outcome; avoid
plausible-looking estimates supplied by the evaluator.

**Pass 2: answer content.** Use only the dimensions on the selected question
card. An outcome does not erase the quality of the decision made with the
information available. A confident tone does not add evidence. For situational
questions, substitute assumptions, action sequence, contingencies, and checks
for historical outcomes.

For principle questions such as B11 and TS09, assess the stated criteria, the
reasoning and limits that make them useful, and an example or counterexample
that demonstrates application. Do not demand a historical outcome when the
question asks for a definition. If the candidate only tells a story, probe for
the criterion; if they only recite a framework, probe where it would fail.
For negotiation, assess informed preparation and response choices separately
from leadership competence or the ultimate salary obtained.

## Scoring anchors

Each question has three dimensions with a weak and a strong anchor. The proposed
0–3 scale adds intermediate levels consistently:

| Result | Meaning |
| --- | --- |
| `not_observed` | No fair opportunity or usable transcript: interruption, format exclusion, unresolved question ambiguity, or a protected disclosure boundary; no numeric value |
| 0 | After a fair opportunity and needed clarification, an attempted answer supplies no relevant content or explicitly demonstrates the weak behavior |
| 1 | Relevant assertion or partial detail, but the listener cannot yet follow the reasoning or action |
| 2 | Concrete, role-appropriate evidence meeting the core intent; a material limitation or follow-up remains |
| 3 | Meets the card's strong anchor, with sufficient relevant detail and appropriate limits; not maximum length or drama |

Anchors are content expectations, not mandatory phrases. Every numeric value
needs an answer passage and a reason. A missing transcript cannot receive zero.
Do not total these dimensions into a leadership score, percentile, role level,
or hiring probability. For C07, assess information seeking, package clarity,
and response to pressure under the range-first coaching default. Never score
the amount demanded, private minimum, personal constraints, or willingness to
walk away as better or worse. A deliberate user-chosen exception is not a
competency failure. C08 is retired: routine logistics are user-declared checklist
facts, not scored interview preparation content.

For LQ08, assess whether the professional decision and tradeoffs are understandable;
do not rank the person's career priorities. Apply the same boundary whenever
an expanded card involves work hours, personal support, private information, or
access needs. Serious conduct scenarios assess responsible role-appropriate
handling, not whether the candidate recites a predetermined disciplinary sequence.

For AI answers, distinguish current local observations from forecasts and
published results in other settings. Tool enthusiasm, adoption rate, and generated
volume are not quality dimensions unless the question explicitly asks about a
defined outcome they help explain.

Do not add a dimension merely because another question uses it. STAR
(situation, task, action, result) can help organize experiential answers, but it
is unnecessary for an introduction, salary discussion, or hypothetical plan.
Learning and changed behavior are useful where relevant; an unrelated moral at
the end is not required.

## Role adaptation

Use the card's profile inputs and target context to choose evidence. Expectations
change with responsibilities, rather than rewarding larger numbers by default.

- An IC can demonstrate influence within one team; staff expectations may
  require adoption across teams when that is part of the role.
- A first-time manager can demonstrate mentorship, coordination, feedback, or
  a situational exercise. Label this transferable evidence and leave formal
  people-management experience unestablished.
- An EM should explain team outcomes and their own management actions. A
  director should additionally explain how managers and teams gained autonomy.
- An executive should connect decisions to the business and constraints,
  explain shared ownership with peers, and examine system effects. A CTO role
  defined as a senior IC needs the corresponding IC criteria instead.
- A return from management to IC work is a legitimate choice. Gaps, nonlinear
  careers, disability accommodations, or lack of impressive employers are not
  negative quality signals.

## Useful evaluator output

Return a short, evidence-linked assessment:

```text
Question: B02, historical failure example; target: staff IC
Answer type: historical / situational / principle / negotiation / preference / mixed
Content dimensions:
  responsibility: 2 — segment 3 names the missed dependency
  decision analysis: 1 — segment 4 says "we underestimated it"; no explanation yet
  changed practice: not_observed — not asked before the interruption
Factual support:
  outcome claim in segment 6: new_user_statement, no accepted source yet
What works: one concrete episode and a clear personal decision
Next improvement: explain what you knew when you committed to the date
Follow-up: which signal would make you decide differently now?
Readiness of this answer: needs_detail
```

Readiness labels apply only to this answer: `ready_to_rehearse`, `needs_detail`,
`needs_clarification`, or `not_assessable`. An answer can be ready to rehearse
while new factual claims remain clearly marked for confirmation. Do not present
the readiness label as a statement that the candidate is ready for the role.

Give at most two high-value improvements at once. Prefer a probe that helps the
user recover their real experience over replacing their answer with a fabricated
ideal. If asked to draft a revision, retain their meaning and voice, mark missing
facts, and let the user decide whether the wording is accurate.

## What not to reward or punish

Do not reward invented precision, exaggerated individual ownership, performative
humility, named frameworks, incessant availability, or a rehearsed answer that
does not address the prompt. Do not punish brevity, speech differences, an
accent, imperfect grammar, disclosure boundaries, small-company scope, or an
honest lack of direct experience. Understandability matters only to whether the
listener can follow the content; ask a clarification before inferring absence.

One respectful disagreement can be well reasoned or poorly reasoned. One
termination, rewrite, reorganization, or decision to stop a project can be sound
or unsound. Evaluate evidence and context instead of matching a preferred act.

## Calibration before product use

The [OPM anchor guidance](https://www.opm.gov/frequently-asked-questions/assessment-policy-faq/structured-interviews/how-do-i-develop-a-customized-rating-scale-for-structured-interviews/)
supports using question-specific examples and subject matter experts. Our scale
still needs independent calibration:

1. Have experienced IC, management, and executive interviewers review cards
   against actual job responsibilities and acceptable alternatives.
2. Build an independently authored response set: strong, partial, vague,
   defensible unconventional, unsuccessful-but-sound, successful-but-unsound,
   first-time manager, confidential, and ambiguous examples.
3. Have at least two humans assess it independently before seeing model output.
   Examine dimension-level disagreement and revise unclear anchors. Use held-out
   answers after revisions; do not claim validation from training examples.
4. Test factual checks with unsupported metrics, ambiguous ownership,
   conflicting dates, and new truthful user recollections. Test invariance by
   varying verbosity, grammar, accent markers, names, and employer prestige
   while preserving substantive content. Verify interruptions stay unassessed.
5. Compare model feedback with independent human feedback, including whether
   it helps improve truthful answers. Record errors, role coverage, and limits.
   Set acceptance thresholds before product grading is enabled.

The [worked examples](examples.md) are author-created illustrations and review
fixtures. They demonstrate intended semantics; they do not establish model
accuracy, fairness, coaching efficacy, or interview success.
