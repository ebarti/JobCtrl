"""Hand-authored embedded requests and selected-source boundary controls."""

from copy import deepcopy
from pathlib import Path

import pytest

from jobctrl.database import close_connection
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.interview.evidence import InterviewEvidenceSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from tests.test_interview_prep_generation import JOB_ID, _FakeLlm, _init_conn, _judge_pass
from tests.test_interview_real_provider_framing import _candidate, _request
from tests.test_interview_prose_classifier import (
    test_actual_heading_claim_requires_its_own_selected_source as assert_actual_heading,
    test_same_proposition_meaning_in_every_nonfactual_location as assert_proposition,
)


EMBEDDED_CASES = [
    ("planned_slot", "I would explain what I deliberately stopped investigating and why.", True),
    ("planned_slots", "I would walk through one decision: the objective, what I knew at the time, and what I later learned.", True),
    ("planned_future_slot", "I would explain how I would use Kubernetes with a hypothetical $2 million budget.", True),
    ("planned_scenario_slot", "I would describe what I would do if I managed 50 engineers.", True),
    ("planned_reflection", "I would test assumptions, while being honest about whether I am rationalizing after the fact.", True),
    ("future_reflection", "How would you recognize that you were rationalizing after seeing the result?", True),
    ("embedded_subject_condition", "I would name responsibilities that would suffer if I became a critical-path implementer.", True),
    ("embedded_owner_condition", "I would monitor involvement: if my review becomes the critical path, I would redistribute it.", True),
    ("open_input", "Is there a technical decision you want to ground this answer in?", True),
    ("future_input", "The evidence list must stay empty until you confirm what to attach.", True),
    ("question_insertion", "What later evidence, if any, changed your view of that decision?", True),
    ("target_role_expectation", "What technical involvement does the Director of Platform Engineering role at Acme expect?", True),
    ("slot_metric", "I would explain how I saved $2 million.", False),
    ("slot_tool", "I would describe how I used Kubernetes.", False),
    ("slot_employer", "I would describe what I achieved at Acme.", False),
    ("slot_authority", "I would describe how I served as a Director at Acme.", False),
    ("slot_prior_premise", "I would explain what my prior role as Director at Acme taught me.", False),
    ("slot_independent_assertion", "I would explain what I learned, but I improved incident coordination.", False),
    ("slot_independent_colon", "I would explain a decision: I improved incident coordination.", False),
    ("condition_independent_assertion", "If my review becomes the critical path: I improved incident coordination.", False),
    ("open_independent_assertion", "Is there a technical decision you want to discuss? I improved incident coordination.", False),
    ("input_prior_premise", "The list stays empty until you confirm your prior role as Director at Acme.", False),
    ("target_role_biography", "What does the Director role require? I worked as Director at Acme.", False),
    ("reduced_if_metric", "I would review options if needed but I saved $2 million using Kubernetes.", False),
    ("reduced_if_role", "I would review options if needed but I actually served as Director at Acme.", False),
    ("reduced_if_history", "I would review options if needed but I rescued every critical launch.", False),
    ("reduced_if_and_history", "I would review options if appropriate and I rescued every critical launch.", False),
    ("modified_reduced_if", "I would review options if absolutely necessary but I rescued every critical launch.", False),
    ("generic_reduced_if", "I would review options if practical but I saved $2 million using Kubernetes.", False),
    ("generic_modified_reduced_if", "I would review options if politically prudent but I actually served as Director at Acme.", False),
    ("adjunct_reduced_if", "I would review options if needed for the design but I rescued every critical launch.", False),
    ("reduced_if_implicit_history", "I would review options if needed but rescued every critical launch.", False),
    ("reduced_if_implicit_metric", "I would review options if needed and saved $2 million using Kubernetes.", False),
    ("independent_future", "I would review options if needed but I would compare criteria before committing.", True),
    ("modified_independent_future", "I would review options if needed but I actually would compare criteria before committing.", True),
    ("implicit_future", "I would review options if needed and compare criteria before committing.", True),
    ("full_conditional_contrast", "If you managed a team but you had limited authority, how would you compare criteria?", True),
    ("full_conditional_coordination", "If you and your hypothetical team managed 50 engineers, how would you compare criteria?", True),
    ("nominal_conditional_coordination", "If workload increased and you managed 50 engineers, how would you compare criteria?", True),
    ("personal_conditional_assumption", "If I saved $2 million using Kubernetes, I would compare criteria.", True),
    ("nested_conditional_assumption", "I would monitor whether a review is needed and step back if my review becomes the critical path.", True),
    ("full_embedded_conditional_assumptions", "I would review options if I managed 50 engineers and I had limited authority.", True),
    ("full_embedded_actual_metric", "I would review options if I managed a team but I actually saved $2 million using Kubernetes.", False),
    ("full_embedded_actual_role", "I would review options if I managed a team but I previously served as Director at Acme.", False),
    ("full_embedded_actual_history", "I would review options if I managed a team but I actually rescued every critical launch.", False),
    ("fronted_actual_hypothesis", "If I actually saved $2 million using Kubernetes, I would compare criteria.", True),
    ("embedded_actual_assumption", "I would review options if I actually managed 50 engineers and I had limited authority.", True),
]


ACTUALITY_BINDING_CASES = [
    (f"I would review options if I managed a team but {clause}.", False)
    for past, base, participle in [
        ("saved $2 million using Kubernetes", "save $2 million using Kubernetes", "saved $2 million using Kubernetes"),
        ("served as Director at Acme", "serve as Director at Acme", "served as Director at Acme"),
        ("rescued every critical launch", "rescue every critical launch", "rescued every critical launch"),
    ]
    for clause in [f"in reality I {past}", f"I did in fact {base}", f"I have in fact {participle}", f"in fact I {past}"]
] + [
    ("I would review options if I managed a team but in reality I would compare criteria.", True),
    ("I would review options if I managed a team but I in reality would compare criteria.", True),
    ("I would review options if I managed a team but I in fact would compare criteria.", True),
    ("I would review options if I managed a team but I actually would compare criteria.", True),
    ("I would review options if I managed a team but in reality I would compare criteria and I rescued every critical launch.", False),
    ("I would review options if I managed a team but I in fact would compare criteria and rescued every critical launch.", False),
    ("If in reality I saved $2 million using Kubernetes, I would compare criteria.", True),
    ("If I did in fact save $2 million using Kubernetes, I would compare criteria.", True),
    ("If I have in fact served as Director at Acme, I would compare criteria.", True),
    ("I would review options if in reality I managed 50 engineers and I had limited authority.", True),
    ("I would review options if I did in fact manage 50 engineers and I had limited authority.", True),
    ("If I managed 50 engineers but in reality I had limited authority, I would compare criteria.", True),
    ("I would compare criteria: If I managed 50 engineers but in reality I had limited authority, I would delegate coaching.", True),
    ("I would compare criteria. If I managed 50 engineers but in reality I had limited authority, I would delegate coaching.", True),
    ("If I would compare criteria if I managed 50 engineers but I did in fact have limited authority, I would delegate coaching.", True),
    ("I would review options if I managed a team but did in fact rescue every critical launch.", False),
    ("I would review options if I managed a team but in fact would compare criteria and I rescued every critical launch.", False),
    ("I would review options if I managed a team but in fact would compare criteria.", True),
    ("If I managed a team but did in fact rescue every critical launch, I would compare criteria.", True),
    ("I would review options if I managed 50 engineers and I had limited authority.", True),
    ("I would review options if I managed 50 engineers but I had limited authority.", True),
]


WHOLE_PREDICATE_CASES = [
    (f"I would review options if I managed a team but {predicate}.", False)
    for verb, rest in [("saved", "$2 million using Kubernetes"), ("served", "as Director at Acme"),
                       ("rescued", "every critical launch")]
    for predicate in [f"I {verb} in reality {rest}", f"I {verb} {rest} in reality", f"I {verb} {rest}, in fact",
                      f"{verb} {rest} in reality"]
] + [
    ("If I saved in reality $2 million using Kubernetes, I would compare criteria.", True),
    ("If I served as Director at Acme in reality, I would compare criteria.", True),
    ("If I rescued every critical launch, in fact, I would compare criteria.", True),
    ("I would compare criteria if I saved $2 million using Kubernetes in reality and I had limited authority.", True),
    ("I would review options if I managed a team but I would save in reality $2 million using Kubernetes.", True),
    ("I would review options if I managed a team but I would serve as Director at Acme in reality.", True),
    ("I would review options if I managed a team but I would rescue every critical launch, in fact.", True),
    ("If I managed a team but served as Director at Acme in reality, I would compare criteria.", True),
    ("I would review options if I managed a team but I referred to \"in reality\" as a phrase.", True),
    ("I rescued every critical launch if in reality I had limited authority.", False),
    ("If I, in reality, managed 50 engineers and I had limited authority, I would compare criteria.", True),
    ("I would compare criteria if I, in reality, managed 50 engineers and I had limited authority.", True),
    ("If I managed 50 engineers, in reality, and I had limited authority, I would compare criteria.", True),
    ("I would review options if needed, in reality, but I rescued every critical launch.", False),
    ("I would review options if needed, in reality, but rescued every critical launch.", False),
    ("If I, in fact, managed 50 engineers and I had limited authority, I rescued every critical launch.", False),
]

SCENARIO_OWNERSHIP_CASES = [
    ('I would explain the word if means a manager worked at Acme but I served as Director at Acme.', False),
    ('I would explain the word if a conditional cue means a manager worked at Acme but I served as Director at Acme.', False),
    *[(f'I would explain the word if {suffix} a conditional cue but I served as Director at Acme.', False)
      for suffix in ['means', 'indicates', 'introduces', 'denotes', 'with']],
    *[(f'I would explain the phrase "{term}" as a vocabulary example.', True)
      for term in ['prior role', 'my prior role', 'former Director', 'my team']],
    *[(f'If I managed a team called "{term}" and I had limited authority, I would compare criteria.', True)
      for term in ['Prior Role', 'My Team']],
    ('I would compare criteria if I managed a team called "Prior Role" and I had limited authority.', True),
    ('If I managed "my hypothetical team" of 50 engineers, I would compare criteria.', True),
    ('I would explain the word "if" but I served as Director at Acme.', False),
    ('I would explain the word "imagine" and I rescued every critical launch.', False),
    ('I would explain the word if but I served as Director at Acme.', False),
    ('I would explain the word imagine and I saved $2 million using Kubernetes.', False),
    ('I would explain the word imagine as a hypothetical cue and I rescued every critical launch.', False),
    ('I would explain the word imagine as a hypothetical cue.', True),
    ('I would explain the word "if" as a conditional cue.', True),
    ('I would explain: "If I served as Director at Acme, I would compare criteria."', True),
    ('I would explain: "If I, in reality, managed 50 engineers and I had limited authority, I would compare criteria."', True),
    ('I would explain: "Imagine I managed 50 engineers and I had limited authority."', True),
    ('I would explain: "If I managed 50 engineers" but I rescued every critical launch.', False),
    ('I would explain: "If I managed 50 engineers" but rescued every critical launch.', False),
    ('I would explain: "If I managed 50 engineers" but I would compare criteria.', True),
    ('I would explain: "If I managed 50 engineers" and compare criteria.', True),
    ('I would say "I served as Director at Acme."', False),
    ('I would explain the word if as a conditional cue but I served as Director at Acme.', False),
    ('I would explain the word if is a conditional cue but I served as Director at Acme.', False),
    ('If I managed a team called "Platform" and I had limited authority, I would compare criteria.', True),
    ('If I managed 50 engineers using "Python" and I had limited authority, I would compare criteria.', True),
    ('I would compare criteria if I managed a team called "Platform" and I had limited authority.', True),
    ('I would describe how I reduced API latency by 30% using "Kubernetes".', False),
    ('How did you reduce API latency by 30% using "Kubernetes"?', False),
    ('If you and your hypothetical team managed 50 engineers, how would you compare criteria?', True),
    ('If I managed a team called "Previous role" and I had limited authority, I would compare criteria.', True),
    ('If I managed a team called "Built" and I had limited authority, I would compare criteria.', True),
    ('I would say "Built the platform using Kubernetes."', False),
    ('I would say "Served as Director at Acme."', False),
    ('I would say "I spearheaded incident coordination."', False),
    ('I would say "Spearheaded incident coordination."', False),
    ('I would explain the phrase "I spearheaded incident coordination."', False),
    ('How did you reduce API latency by 30% using "Python and Kubernetes"?', False),
    ('If I managed a team, I would say "Served as Director at Acme."', False),
]


COMPLETED_PARENT_CASES = [
    ("I would monitor involvement: if my review or coding becomes the critical path, I would redistribute it.", True),
    ("If my review and coding becomes the critical path, I would redistribute it.", True),
    ("If my review or testing becomes the critical path, I would redistribute it.", True),
    ("If my review and your review becomes the critical path, I would redistribute it.", True),
    ("If workload and capacity increased, I would compare criteria.", True),
    ("I would compare criteria if my review or testing becomes the critical path.", True),
    ("If my review or coding becomes the critical path: I served as Director at Acme.", False),
    ("If my review or coding becomes the critical path, I would redistribute it. I rescued every critical launch.", False),
    ("I would review options, in fact, if I managed a team but I saved $2 million using Kubernetes in reality.", False),
    ("I would review options, in fact, if I managed a team but I served as Director at Acme in reality.", False),
    ("I would compare criteria, in fact, if I managed 50 engineers and I had limited authority.", True),
    ("If I, in fact, managed 50 engineers and I had limited authority, I would compare criteria.", True),
    ('I would ask "Tell me about a time you handled conflict."', True),
    ('"Tell me about a time you handled conflict."', True),
    ('I would ask "Tell me about a time you handled conflict. I rescued every critical launch."', False),
    ('I would ask "Tell me about a time you managed 50 engineers at Acme."', False),
    ('If I managed a team called "Built Platform" and I had limited authority, I would compare criteria.', True),
    ('I would compare criteria if I managed a team called "Built Platform" and I had limited authority.', True),
    ('If I managed a team called "Shared Services" and I had limited authority, I would compare criteria.', True),
    ('I would say "Built Platform."', False),
    ('I would explain "my team encompassed 50 engineers."', False),
    ('I would explain the phrase "my team encompassed 50 engineers."', False),
    ('My team encompassed 50 engineers.', False),
    ('I would explain the phrase "my team" as a label.', True),
    ('I would explain the phrase "my prior role" as a label.', True),
    ('I would explain the phrase "Built Platform" as a vocabulary example.', True),
    ('I would explain the phrase "Shared Services" as a vocabulary example.', True),
    ('I would explain "Built Platform" as a phrase.', True),
    ('I would explain "Shared Services" as a phrase.', True),
    ('I would explain the phrase "I served as Director at Acme."', False),
    ('I would explain "Shared Services" as a phrase. I served as Director at Acme.', False),
]


PERSONAL_OBJECT_CASES = [
    ('Acme would ask me about my team of 50 engineers.', False),
    ('Acme would ask me about my $2 million budget.', False),
    ('Acme would ask me about my Kubernetes deployment.', False),
    ('Acme would ask me about my role as Director at Globex.', False),
    ('Acme would ask me about my work at Globex.', False),
    ('I would say "Acme would ask me about my team of 50 engineers."', False),
    ('I would say "Acme would ask me about my $2 million budget."', False),
    ('I would say "Acme would ask me about my Kubernetes deployment."', False),
    ('I would say "Acme would ask me about my role as Director at Globex."', False),
    ('I would say "Acme would ask me about my work at Globex."', False),
    ('If my team had 50 engineers, Acme would ask me about my approach.', True),
    ('Would Acme ask me about my team of 50 engineers?', False),
    ('Would eBay hire me as Director?', True),
    ('If eBay hired me as Director, I would compare criteria.', True),
    ('I would ask "Would eBay hire me as Director?"', True),
    ('I would say "If eBay hired me as Director, I would compare criteria."', True),
    ('Would the employer hire me as Director?', True),
    ('What would the employer ask me?', True),
    ('Has the employer hired me as Director?', True),
    ('The example must come from you rather than be invented.', True),
    ('The conditions and exit cost, which must come from the candidate rather than be assumed.', True),
    ('I would ask "The example must come from you rather than be invented."', True),
    ('The company must have hired me as Director.', False),
    ('The example came from you at Globex.', False),
    ('The example must come from my prior role as Director at Globex.', False),
    ('Acme would ask me about my background as Director at Globex.', False),
    ('I would say "Acme would ask me about my background as Director at Globex."', False),
    ('Acme would ask me about my expertise acquired as Director at Globex.', False),
    ('I would say "Acme would ask me about my expertise acquired as Director at Globex."', False),
    ('Would Acme ask me about my background as Director at Globex?', False),
    ('Acme would ask me about my prior role as Director at Globex.', False),
    ('Acme would hire me as Director.', True),
    ('Would Acme hire me as Director?', True),
    ('If my background were as Director at Globex, Acme would ask me about my approach.', True),
    ('eBay hired me.', False),
    ('other-company employed us as Directors.', False),
    ('eBay collaborated with you.', False),
    ('unparsed-employer appointed the candidate as Director.', False),
    ('I would say "eBay hired me."', False),
    ('I would explain the phrase "eBay hired me."', False),
    ('I would explain the phrase "other-company paid us $2 million."', False),
    ('Tell me about a time you handled conflict.', True),
    ('Tell me about a time.', True),
    ('I would ask "Tell me about a time."', True),
    ('I would ask "Tell me about a time. eBay hired me."', False),
    ('I would explain the word "you" as a label.', True),
    ('I would explain the phrase "the candidate" as a label.', True),
    ('I would say "Acme hired me as Director."', False),
    ('I would explain the phrase "Acme hired me as Director."', False),
    ('I would say "Acme employed me as Director."', False),
    ('I would say "Acme paid me $2 million for using Kubernetes."', False),
    ('Acme hired me as Director.', False),
    ('Acme employed us as Directors.', False),
    ('I would say "Acme hired you as Director."', False),
    ('I would say "Acme hired the candidate as Director."', False),
    ('I would say "Globex appointed me to lead incident coordination."', False),
    ('I would explain the phrase "Acme Platform" as a vocabulary example.', True),
    ('I would explain the word "me" as a label.', True),
    ('I would say "If Acme hired me as Director, I would compare criteria."', True),
    ('I would say "Acme would hire me as Director."', True),
    ('I would ask "Would Acme hire me as Director?"', True),
    ('I would ask "Did Acme hire me as Director?"', True),
    ('I would ask "Has Acme hired me as Director?"', True),
    ('I would ask "How did Acme hire me as Director?"', False),
    ('I would say "If Acme hired me as Director" but Acme paid me $2 million.', False),
    ('I would ask "Tell me about a time you handled conflict."', True),
]


PERSONAL_PROPERTY_CASES = [
    ("I would review alternatives and the report documented the work while being honest about how I improved incident coordination.", False),
    ("I would review alternatives and I improved incident coordination while being honest about how I handled conflict.", False),
    ("I would review alternatives and I would explain how I improved incident coordination.", True),
    ("The report confirms how I improved incident coordination.", False),
    ("I would explain the word how I improved incident coordination.", False),
    ("I would explain how I improved incident coordination.", True),
    ('I would explain "how I handled conflict."', True),
    ("I would walk through how I handled conflict.", True),
    ("I would draw on examples and walk through one specific decision: the word how I improved incident coordination.", False),
    ("I would draw on examples and walk through one specific decision: the alternatives available, how I improved incident coordination.", True),
    ("I would explain how I handled conflict.", True),
    ("I would explain how I managed tradeoffs.", True),
    ("What specific example do you want to use as your worked example — ideally how I achieved reliable operations?", True),
    ("What specific example do you want to use as your worked example — ideally how I improved incident coordination?", True),
    ('I would ask "What specific example do you want to use as your worked example, ideally how I handled conflict?"', True),
    ("The report confirms your worked example, ideally how I improved incident coordination.", False),
    ("I would explain the word example, ideally how I improved incident coordination.", False),
    ("The report documented the work, ideally how I improved incident coordination.", False),
    ("What specific example do you want to use as your worked example, ideally already demonstrated how I improved incident coordination?", False),
    ("What specific example do you want to use as your worked example — ideally how I single-handedly resolved every critical production outage?", False),
    ("I would explain how I handled conflict at Acme.", False),
    ("I would explain how I managed tradeoffs using Kubernetes.", False),
    ("I would explain how I handled conflict. I improved incident coordination.", False),
    ("I improved incident coordination.", False),
    ("I achieved reliable operations.", False),
    ("The candidate’s prior work supervised 50 direct reports at Acme.", False),
    ("How would you use the candidate’s prior savings of $2 million?", False),
    ("How would you manage the candidate’s hypothetical team of 50 direct reports?", True),
    ("I would use the outcome to test my assumptions.", True),
    ("I would monitor my own involvement as something to evaluate.", True),
    ("Acme would ask me about my approach as something to evaluate.", True),
    ("What would change your recommendation?", True),
    ("What information would have changed your choice at the time?", True),
    ("What later evidence, if any, changed your view of that decision or the policy around it?", True),
    ("Which requirement makes your preferred option better than the alternatives?", True),
    ("Why not keep the existing approach in your example?", True),
    ("When did your involvement become a bottleneck, and how did you notice?", True),
    ("Is there a real instance where your involvement either helped or became a bottleneck that you would want to reference?", True),
    ("I would test my directorship.", False),
    ("I would test my assumptions about my background as Director at Globex.", False),
    ("I would test my assumptions about my team of 50 engineers.", False),
    ("Acme would ask me about my Kubernetes.", False),
    ("Acme would ask me about my Kubernetes as something to evaluate.", False),
    ("I would explain a signal that my Kubernetes has become a bottleneck.", False),
    ("If the role is hypothetical, how would you use your current management experience?", False),
    ("When did your current involvement become a bottleneck?", False),
    ("What would change your recommendation at Globex?", False),
    ("What information would have changed your choice about my directorship?", False),
    ("I used the outcome to test my assumptions.", False),
    ("I monitored my own involvement.", False),
    ("I selected my preferred option.", False),
    ("What would change your recommendation? I rescued every critical launch.", False),
    ("What later evidence, if any, changed your current management experience?", False),
    ("Is there a real instance where your involvement managed 50 engineers?", False),
    ("When did your involvement become a Director at Globex?", False),
    ("Acme would ask me about my prior approach.", False),
    ("How do you prefer to spend your time?", True),
    ("How do you prefer to spend your time at Globex?", False),
    ("I spent my time at Globex.", False),
    ("What decision do you want to use as your worked example — ideally a well-reasoned choice that ended badly?", True),
    ("What decision do you want to use as your worked example about my directorship?", False),
    ("What later evidence (if any) changed your approach?", True),
    ("Which requirement makes your preferred option better?", True),
    ("Which concrete episode would you use to illustrate your technical-involvement approach?", True),
    ("Can you describe a time your technical involvement became a bottleneck?", True),
    ("Can you describe a time your technical involvement used Kubernetes?", False),
    ("Which of your responsibilities would suffer if you became a critical-path implementer?", True),
    ("Which of your current responsibilities would suffer if you became a critical-path implementer?", False),
    ("Where does the target role's expectation differ from your preference?", True),
    ("Where does the target role's expectation differ from your preference at Globex?", False),
    ("Describe a time when you and your team handled conflict.", True),
    ("Describe a time when you and your team of 50 engineers handled conflict.", False),
    ("Describe a time when you and your current team handled conflict.", False),
    ('I would ask "How do you prefer to spend your time?"', True),
    ('I would ask "How do you prefer to spend your time at Globex?"', False),
    ("How do you prefer to spend your time? I rescued every critical launch.", False),
    ("Acme would ask me about my team as something to evaluate.", False),
    ("Acme would ask me about my time as something to evaluate.", False),
    ("Acme would ask me about my current responsibilities.", False),
    ("What specific example do you want to use as your worked example — ideally how I managed 50 engineers at Acme?", False),
    ("What specific example do you want to use as your worked example — ideally how I used Kubernetes?", False),
    ("What specific example do you want to use as your worked example — ideally how I saved $2 million?", False),
    ("What specific example do you want to use as your worked example — ideally how I would manage 50 engineers at Acme?", True),
    ("If my responsibilities changed, I would review options.", True),
    ("I would review options if my responsibilities changed.", True),
    ("My responsibilities changed.", False),
    ("If my responsibilities changed, I would review options. My team had 50 engineers.", False),
    *[(f'I would ask "{phrase}"', accepted) for phrase, accepted in [
        ("What would change your recommendation?", True),
        ("How would you use your current management experience?", False),
        ("Would Acme ask me about my directorship?", False),
    ]],
]


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("name,phrase,accepted", EMBEDDED_CASES)
def test_embedded_operator_has_local_scope(tmp_path: Path, name, phrase, accepted, location, support):
    assert_proposition(tmp_path, name, phrase, accepted, location, support)


@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("name,phrase,accepted", [
    ("coordinated_variables", "I would explain how I managed tradeoffs and how I improved incident coordination.", True),
    ("reordered_variables", "I would explain how I improved incident coordination and how I managed tradeoffs.", True),
    ("implicit_variable", "I would explain how I handled conflict and managed tradeoffs.", True),
    ("quoted_variables", 'I would explain "how I managed tradeoffs and how I improved incident coordination."', True),
    ("ascii_criterion", "What specific example do you want to use as your worked example - ideally how I improved incident coordination?", True),
    ("implicit_sweeping", "I would explain how I improved incident coordination and single-handedly resolved every critical production outage.", False),
    ("quoted_implicit_sweeping", 'I would explain "how I improved incident coordination and single-handedly resolved every critical production outage."', False),
    ("implicit_ownership", "I would explain how I improved incident coordination and owned the entire engineering platform.", False),
    ("implicit_tool", "I would explain how I handled conflict and used Kubernetes.", False),
    ("implicit_unknown", "I would explain how I handled conflict and orchestrated every critical launch.", False),
    ("own_future", "I would explain how I improved incident coordination and would review the entire engineering platform.", True),
    ("nearer_actor", "I would explain how I handled conflict but I owned the entire engineering platform.", False),
    ("missing_reason", "I would explain what I deliberately stopped investigating and why.", True),
    ("supplied_reason_actor", "I would explain what I deliberately stopped investigating and why I owned the entire engineering platform.", False),
    ("anonymous_criterion", "What decision do you want to use as your worked example - ideally a well-reasoned choice that ended badly?", True),
    ("qualified_criterion", "What decision do you want to use as your worked example - ideally how I managed 50 engineers at Acme?", False),
    ("actual_criterion", "I made a well-reasoned choice that ended badly.", False),
    ("nested_criterion", "What decision do you want to use as your worked example - ideally a well-reasoned choice that I made at Acme?", False),
    ("prospective_first_member", "I would explain how I would manage tradeoffs and how I improved incident coordination.", True),
    ("prospective_then_supplied", "I would explain how I would manage tradeoffs and how I managed 50 engineers at Acme.", False),
    ("quoted_prospective_first", 'I would explain "how I would manage tradeoffs and how I improved incident coordination."', True),
    ("short_resource_generic", "What example do you want to use - ideally how I improved incident coordination?", True),
    ("short_resource_supplied", "What example do you want to use - ideally how I managed 50 engineers at Acme?", False),
    ("nominal_resource_parent", "I would explain the example - ideally how I improved incident coordination.", False),
])
def test_dependent_account_has_own_content(tmp_path: Path, question_id, location, support, name, phrase, accepted):
    test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path, question_id, location, support, phrase, accepted)


@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("phrase,accepted", [
    ("I would use the outcome to test my assumptions.", True),
    ("I would explain how I handled conflict and would use the outcome to test my assumptions.", True),
    ("I would explain how I handled conflict and I would use the outcome to test my assumptions.", True),
    ('I would explain "how I handled conflict and would use the outcome to test my assumptions."', True),
    ("I would use the outcome to test my assumptions and would explain how I handled conflict.", True),
    ("I would monitor my own involvement as something to evaluate.", True),
    ("I would explain how I handled conflict and would monitor my own involvement as something to evaluate.", True),
    ("I would explain how I handled conflict and I would monitor my own involvement as something to evaluate.", True),
    ('I would explain "how I handled conflict and would monitor my own involvement as something to evaluate."', True),
    ("I would explain how I handled conflict and tested my assumptions.", False),
    ("I would explain how I handled conflict and would evaluate my Kubernetes.", False),
    ("I would explain how I handled conflict and would test my current directorship at Acme.", False),
    ("I would explain how I handled conflict and would test my assumptions about my prior role as Director at Acme.", False),
    ("I would explain how I handled conflict and orchestrated my team of 50 engineers.", False),
    ("I would explain how I handled conflict and my team had 50 engineers.", False),
    ("If my involvement became a bottleneck, I would review options.", True),
])
def test_dependent_prospective_property_uses_own_action(tmp_path: Path, question_id, location, support, phrase, accepted):
    test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path, question_id, location, support, phrase, accepted)


CONTROLLING_ACTIONS = [
    ("test", "tested", "my assumptions"),
    ("review", "reviewed", "my assumptions"),
    ("evaluate", "evaluated", "my assumptions"),
    ("monitor", "monitored", "my own involvement as something to evaluate"),
    ("treat", "treated", "my own involvement as something to evaluate"),
]


@pytest.mark.parametrize("lemma,past,operand", CONTROLLING_ACTIONS)
@pytest.mark.parametrize("shape", ["future", "if_present", "if_past", "actual_past"])
@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_controlling_action_keeps_own_finite_hypothesis(tmp_path: Path, lemma, past, operand, shape, question_id, location, support):
    phrase = (f"I would {lemma} {operand}." if shape == "future" else
              f"I {past} {operand}." if shape == "actual_past" else
              f"If I {past if shape == 'if_past' else lemma} {operand}, I would review options.")
    test_full_antecedent_pairs_keep_selected_and_empty_scope(
        tmp_path, question_id, location, support, phrase, shape != "actual_past")


@pytest.mark.parametrize("lemma,past,operand", CONTROLLING_ACTIONS)
@pytest.mark.parametrize("shape", ["future", "if_present", "if_past", "actual_past"])
def test_controlling_action_trace_asserts_predicate_origin_and_source(lemma, past, operand, shape):
    from jobctrl.domain.interview.question_generation import (
        _PROPERTY_OPERATION_ROLES, _assess_prose, _hypothesis_candidates, _predicate_binding, _predicate_syntax,
    )

    assert {operation for operation, role in _PROPERTY_OPERATION_ROLES.items()
            if role in {"reasoning_operation", "process_operation", "process_framing"}} == {
                row[0] for row in CONTROLLING_ACTIONS}
    phrase = (f"I would {lemma} {operand}." if shape == "future" else
              f"I {past} {operand}." if shape == "actual_past" else
              f"If I {past if shape == 'if_past' else lemma} {operand}, I would review options.")
    conditional = shape.startswith("if_")
    boundary = phrase.index(",") if conditional else len(phrase.rstrip("."))
    predicate = past if shape in {"if_past", "actual_past"} else lemma
    predicate_start = phrase.index(predicate)
    binding = _predicate_binding(phrase, 2 if conditional else 0, boundary)
    assert binding is not None
    assert [phrase[left:right] for left, right in binding.subjects] == ["I"]
    assert binding.predicate == (predicate_start, predicate_start + len(predicate))
    assert binding.operands == ((predicate_start + len(predicate), boundary),)
    syntax = _predicate_syntax(phrase)
    candidates = _hypothesis_candidates(phrase, syntax)
    assert len(candidates) == int(conditional)
    if conditional:
        assert candidates[0].start == 0 and candidates[0].end == boundary
        assert candidates[0].attachment_role == "direct"
        assert candidates[0].operand_subjects == binding.subjects
        assert candidates[0].operand_predicate == binding.predicate
    assessment = _assess_prose(phrase)
    first = next(record for record in assessment.propositions if record.start == 0)
    assert first.hypothesis_start == (0 if conditional else None)
    assert first.personal_assertion == (shape == "actual_past")
    assert all(record.canonical_property is False for record in assessment.propositions) if shape != "actual_past" else any(
        record.canonical_property and record.source_check_text for record in assessment.propositions)
    if conditional:
        main = next(record for record in assessment.propositions if record.start > boundary and record.governing_actor == "I")
        assert main.hypothesis_start is None and main.governing_operator == "conditional"


@pytest.mark.parametrize("lemma,past,operand", CONTROLLING_ACTIONS)
@pytest.mark.parametrize("qualified", ["my current directorship at Acme", "my assumptions about my prior role as Director at Acme"])
@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_controlling_action_keeps_qualified_property_source(tmp_path: Path, lemma, past, operand, qualified, question_id, location, support):
    test_full_antecedent_pairs_keep_selected_and_empty_scope(
        tmp_path, question_id, location, support, f"I would {lemma} {qualified}.", False)


@pytest.mark.parametrize("lemma,past,operand", CONTROLLING_ACTIONS)
@pytest.mark.parametrize("scope", ["matching", "unrelated", "empty"])
def test_actual_controlling_action_requires_same_selected_factual_source(tmp_path: Path, lemma, past, operand, scope):
    conn = _init_conn(tmp_path)
    try:
        question_id = "M02" if scope == "empty" else "B11"
        request = _request(question_id)
        phrase = f"I {past} {operand}."
        source = "I reduced API latency by 30% using Python." if scope == "unrelated" else phrase
        request["canonical_evidence"] = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=request["tenant_id"], profile_id=request["profile_snapshot"].profile_id, profile_version=1,
            rows=[{"evidence_id": "ev-platform-latency", "source_text": source,
                   "user_confirmed": 1, "evidence_strength": "supported"}])
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        candidate["items"][0]["outline"] = [{"heading": phrase, "text": phrase,
                                              "evidence_ids": [] if scope == "empty" else ["ev-platform-latency"],
                                              "factual_support": "accepted_profile_fact"}]
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="actual-action", **request)
        assert outcome.status == ("accepted" if scope == "matching" else "failed"), outcome.errors
        assert len(llm.calls) == (2 if scope == "matching" else 1)
        if scope != "matching":
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("phrase,accepted", [
    ("I would review options if I managed 50 engineers and I had limited authority.", True),
    ("I would review options if I actually managed 50 engineers and I actually had limited authority.", True),
    ("If I actually saved $2 million using Kubernetes, I would compare criteria.", True),
    ("I would review options if I managed a team but I actually saved $2 million using Kubernetes.", False),
    ("I would review options if I managed a team but I previously served as Director at Acme.", False),
    ("I would review options if I managed a team but I actually rescued every critical launch.", False),
] + ACTUALITY_BINDING_CASES + WHOLE_PREDICATE_CASES + SCENARIO_OWNERSHIP_CASES + COMPLETED_PARENT_CASES + PERSONAL_OBJECT_CASES + PERSONAL_PROPERTY_CASES)
def test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path: Path, question_id, location, support, phrase, accepted):
    conn = _init_conn(tmp_path)
    try:
        request = _request(question_id)
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="full-range", **request)
        assert outcome.status == ("accepted" if accepted else "failed"), outcome.errors
        assert len(llm.calls) == (2 if accepted else 1)
        if accepted:
            links = outcome.prep.items[0].question_metadata["evidenceLinks"]
            assert [link["evidenceId"] for link in links] == (["ev-platform-latency"] if question_id == "B11" else [])
        else:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification", "accepted_profile_fact"])
@pytest.mark.parametrize("heading", [
    "I would review options if I managed a team but I saved $2 million using Kubernetes in reality.",
    "I would review options if I managed a team but I served as Director at Acme in reality.",
    "I would review options if I managed a team but I rescued every critical launch, in fact.",
    "I would review options if I managed a team but I saved in reality $2 million using Kubernetes.",
    "I would review options if I managed a team but I served in fact as Director at Acme.",
    "I would review options if I managed a team but I rescued in reality every critical launch.",
    'I would explain the word "if" but I served as Director at Acme.',
    'I would explain the word imagine and I rescued every critical launch.',
    'I would explain the word if means a conditional cue but I served as Director at Acme.',
    'I would explain the word if indicates a conditional cue but I served as Director at Acme.',
    'I would explain the word if introduces a conditional cue but I served as Director at Acme.',
    'I would explain the word if means a manager worked at Acme but I served as Director at Acme.',
    'I would review options, in fact, if I managed a team but I saved $2 million using Kubernetes in reality.',
    'I would explain "my team encompassed 50 engineers."',
    'I would say "Acme hired me as Director."',
    'I would explain the phrase "Acme hired me as Director."',
    'I would say "Acme paid me $2 million for using Kubernetes."',
    'Acme would ask me about my team of 50 engineers.',
    'Acme would ask me about my $2 million budget.',
    'Acme would ask me about my Kubernetes deployment.',
    'Acme would ask me about my role as Director at Globex.',
    'Acme would ask me about my work at Globex.',
    'eBay hired me.',
    'I would explain the phrase "eBay hired me."',
    'Acme would ask me about my background as Director at Globex.',
    'I would say "Acme would ask me about my expertise acquired as Director at Globex."',
    'Acme would ask me about my directorship.',
    'I would test my directorship.',
    'Acme would ask me about my Kubernetes as something to evaluate.',
    'If the role is hypothetical, how would you use your current management experience?',
    'What specific example do you want to use as your worked example — ideally how I managed 50 engineers at Acme?',
    'What specific example do you want to use as your worked example — ideally how I used Kubernetes?',
    'What specific example do you want to use as your worked example — ideally how I saved $2 million?',
    'What specific example do you want to use as your worked example — ideally how I single-handedly resolved every critical production outage?',
    'The report confirms how I improved incident coordination.',
    'I would explain the word how I improved incident coordination.',
])
def test_whole_predicate_actual_heading_has_its_own_source(tmp_path: Path, support, heading):
    assert_actual_heading(tmp_path, support, heading)


@pytest.mark.parametrize("heading", [
    'I would explain the phrase "Built Platform" as a vocabulary example.',
    'I would explain the phrase "Shared Services" as a vocabulary example.',
    'I would explain "Built Platform" as a phrase.',
    'I would explain "Shared Services" as a phrase.',
])
def test_proved_nominal_heading_with_selected_factual_body(tmp_path: Path, heading):
    conn = _init_conn(tmp_path)
    try:
        candidate = _candidate("B11")
        candidate["items"][0]["outline"] = [{"heading": heading, "text": "Reduced API latency by 30% using Python.",
                                             "evidence_ids": ["ev-platform-latency"], "factual_support": "accepted_profile_fact"}]
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=llm).execute(**_request("B11"))
        assert outcome.status == "accepted", outcome.errors
        assert len(llm.calls) == 2
        assert outcome.prep.items[0].evidence_ids == ("ev-platform-latency",)
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("complete_source", [True, False])
def test_actual_parent_owns_its_account_child_source(tmp_path: Path, location, complete_source):
    phrase = ("I would review alternatives and I reduced API latency by 30% using Python "
              "while being honest about how I improved incident coordination.")
    source = ("I reviewed alternatives and I reduced API latency by 30% using Python while being honest about "
              + ("how I improved incident coordination." if complete_source else "the work."))
    conn = _init_conn(tmp_path)
    try:
        request = _request("B11")
        request["canonical_evidence"] = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=request["tenant_id"], profile_id=request["profile_snapshot"].profile_id, profile_version=1,
            rows=[{"evidence_id": "ev-platform-latency", "source_text": source,
                   "user_confirmed": 1, "evidence_strength": "supported"}])
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate("B11"), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        assert prior.status == "accepted"
        candidate = _candidate("B11")
        item = candidate["items"][0]
        item["outline"][0].update(text="Reduced API latency by 30% using Python.",
                                   evidence_ids=["ev-platform-latency"], factual_support="accepted_profile_fact")
        if location in {"heading", "text"}:
            item["outline"][0][location] = (phrase.removeprefix("I would review alternatives and ")
                                             if complete_source and location == "text" else phrase)
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="own-parent", **request)
        accepted = complete_source and location in {"heading", "text"}
        assert result.status == ("accepted" if accepted else "failed"), result.errors
        assert len(llm.calls) == (2 if accepted else 1)
        if not accepted:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("selected", [True, False])
@pytest.mark.parametrize("phrase", ["I would describe how I reduced API latency by 30% using Python.",
                                    "I would review options if needed, but how did you reduce API latency by 30% using Python?",
                                    "I would review options if I managed a team but how did you reduce API latency by 30% using Python?",
                                    'I would ask "How did you reduce API latency by 30% using Python?"',
                                    'I would describe how I reduced API latency by 30% using "Python".',
                                    'How did you reduce API latency by 30% using "Python"?',
                                    'I would ask "Tell me about a time you used Python."'])
def test_planned_concrete_account_requires_its_question_source(tmp_path: Path, location, selected, phrase):
    conn = _init_conn(tmp_path)
    try:
        request = _request("B11" if selected else "M02")
        repository = SqliteInterviewPrepRepository(conn)
        question_id = request["selection_input"]["selectedQuestionIds"][0]
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="account", **request)
        assert result.status == ("accepted" if selected else "failed"), result.errors
        assert len(llm.calls) == (2 if selected else 1)
        if not selected:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("selected", [True, False])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("phrase,source,selected_acceptance", [
    ("I would explain how I improved incident coordination and single-handedly resolved every critical production outage.", "I single-handedly resolved every critical production outage.", True),
    ('I would explain "how I improved incident coordination and single-handedly resolved every critical production outage."', "I single-handedly resolved every critical production outage.", True),
    ("I would explain how I improved incident coordination and owned the entire engineering platform.", "I owned the entire engineering platform.", True),
    ('I would ask "How did Acme hire me as Director?"', "Acme hired me as Director.", True),
    ("The report confirms how I improved incident coordination.", "I improved incident coordination.", True),
    ("I would review alternatives and the report documented the work while being honest about how I improved incident coordination.", "I improved incident coordination.", True),
    ("I would explain the word how I improved incident coordination.", "I improved incident coordination.", True),
    ("Would Acme ask me about my team of 50 engineers?", "My team had 50 engineers.", True),
    ("Would Acme ask me about my directorship?", "My directorship.", True),
    ("If the role is hypothetical, how would you use your current management experience?", "My current management experience.", True),
    ('I would ask "Would Acme ask me about my directorship?"', "My directorship.", True),
    ("What specific example do you want to use as your worked example — ideally how I managed 50 engineers at Acme?", "I managed 50 engineers at Acme.", True),
    ("What specific example do you want to use as your worked example — ideally how I used Kubernetes?", "I used Kubernetes.", True),
    ("What specific example do you want to use as your worked example — ideally how I saved $2 million?", "I saved $2 million.", True),
    ("Which of your current responsibilities would suffer if you became a critical-path implementer?", "My current responsibilities include platform operations.", True),
    ("Describe a time when you and your team of 50 engineers handled conflict.", "My team had 50 engineers.", True),
    ('I would ask "Describe a time when you and your team of 50 engineers handled conflict."', "My team had 50 engineers.", True),
    ("What specific example do you want to use as your worked example — ideally how I single-handedly resolved every critical production outage?", "I single-handedly resolved every critical production outage.", True),
    ("I would monitor my current involvement.", "My current involvement.", False),
    ('I would say "I would monitor my current involvement."', "My current involvement.", False),
    ("I would explain how I handled conflict and would evaluate my Kubernetes.", "My Kubernetes.", True),
    ('I would explain "how I handled conflict and would evaluate my directorship."', "My directorship.", True),
] + [(f"I would {lemma} my Kubernetes.", "My Kubernetes.", True) for lemma, _, _ in CONTROLLING_ACTIONS])
def test_candidate_object_query_uses_only_its_selected_source(tmp_path: Path, location, selected, support, phrase, source, selected_acceptance):
    conn = _init_conn(tmp_path)
    try:
        request = _request("B11" if selected else "M02")
        request["canonical_evidence"] = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=request["tenant_id"], profile_id=request["profile_snapshot"].profile_id, profile_version=1,
            rows=[{"evidence_id": "ev-platform-latency", "source_text": source,
                   "user_confirmed": 1, "evidence_strength": "supported"}])
        question_id = "B11" if selected else "M02"
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        assert prior.status == "accepted"
        note = repository.save_note(LOCAL_TENANT, JOB_ID, question_id, expected_revision=0,
                                    note_text="Independent synthetic practice note.", source_generation=1,
                                    bindings={"contextDigest": prior.generation_context["contextDigest"],
                                              "catalogBinding": prior.generation_context["catalogBinding"]})
        note_rows = [tuple(row) for row in conn.execute("SELECT * FROM job_interview_notes")]
        revision_rows = [tuple(row) for row in conn.execute("SELECT * FROM job_interview_note_revisions")]
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="object-query", **request)
        accepted = selected and selected_acceptance
        assert result.status == ("accepted" if accepted else "failed"), result.errors
        assert len(llm.calls) == (2 if accepted else 1)
        assert repository.load_note(LOCAL_TENANT, JOB_ID, question_id) == note
        assert [tuple(row) for row in conn.execute("SELECT * FROM job_interview_notes")] == note_rows
        assert [tuple(row) for row in conn.execute("SELECT * FROM job_interview_note_revisions")] == revision_rows
        if not accepted:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


def test_factual_candidate_object_heading_and_body_keep_canonical_support(tmp_path: Path):
    conn = _init_conn(tmp_path)
    try:
        request = _request("B11")
        excerpt = "Acme hired me as Director."
        request["canonical_evidence"] = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=request["tenant_id"], profile_id=request["profile_snapshot"].profile_id, profile_version=1,
            rows=[{"evidence_id": "ev-platform-latency", "source_text": excerpt,
                   "user_confirmed": 1, "evidence_strength": "supported"}])
        candidate = _candidate("B11")
        candidate["items"][0]["outline"] = [{"heading": excerpt, "text": excerpt,
                                             "evidence_ids": ["ev-platform-latency"], "factual_support": "accepted_profile_fact"}]
        llm = _FakeLlm([candidate, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=llm).execute(**request)
        assert result.status == "accepted", result.errors
        assert len(llm.calls) == 2
        assert result.prep.items[0].evidence_ids == ("ev-platform-latency",)
    finally:
        close_connection(tmp_path / "jobs.db")


def test_model_receives_section_proof_relationship_before_generation(tmp_path: Path):
    conn = _init_conn(tmp_path)
    try:
        llm = _FakeLlm([_candidate("M02"), _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=llm).execute(**_request("M02"))
        assert outcome.status == "accepted"
        first = llm.calls[0]
        prompt = first["messages"][1].content
        assert "hypothetical or needs_clarification => evidence_ids=[] without exception" in prompt
        assert "evidence_ids means accepted personal proof, never a contextual citation" in prompt
        assert "separate factual anchor" in prompt
        section = first["response_schema"]["properties"]["items"]["items"]["properties"]["outline"]["items"]["properties"]
        assert "hypothetical and needs_clarification MUST use []" in section["evidence_ids"]["description"]
        assert "requires evidence_ids=[]" in section["factual_support"]["description"]
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_nonfactual_source_reference_is_rejected_without_relabeling(tmp_path: Path, support):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("B11")
        candidate = _candidate("B11")
        candidate["items"][0]["outline"].insert(0, {"heading": "Canonical anchor", "text": "Reduced API latency by 30% using Python.",
                                                   "evidence_ids": ["ev-platform-latency"], "factual_support": "accepted_profile_fact"})
        candidate["items"][0]["outline"][1]["text"] = "I would describe how I reduced API latency by 30% using Python."
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([candidate, _judge_pass()])).execute(
            origin_run_id="compliant-anchor", **request).prep
        assert accepted.status == "accepted"
        assert accepted.generation_context["model"]["promptVersion"] == "interview-questions-v5"
        assert accepted.generation_context["model"]["gateVersion"] == "interview-question-grounding-v30"
        invalid = deepcopy(candidate)
        invalid["items"][0]["outline"][1].update(evidence_ids=["ev-platform-latency"], factual_support=support)
        original = deepcopy(invalid)
        llm = _FakeLlm([invalid, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="invalid-ref", **request)
        assert result.status == "failed"
        assert "nonfactual outline cannot claim accepted evidence support" in result.errors[0]
        assert len(llm.calls) == 1
        assert invalid == original
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("lemma,past,operand", CONTROLLING_ACTIONS)
@pytest.mark.parametrize("shape", ["if_present", "if_past"])
@pytest.mark.parametrize("qualified", ["my current directorship at Acme", "my assumptions about my prior role as Director at Acme"])
def test_assumed_action_retains_separate_supplied_property(lemma, past, operand, shape, qualified):
    from jobctrl.domain.interview.question_generation import _assess_prose, _predicate_syntax

    phrase = f"If I {past if shape == 'if_past' else lemma} {qualified}, I would review options."
    syntax = _predicate_syntax(phrase)
    reference = (phrase.index("my"), phrase.index("my") + 2)
    property_span = (reference[0], phrase.index(","))
    witnesses = [witness for owner in syntax for witness in owner.personal_content_witnesses
                 if witness.reference == reference and witness.property_span == property_span]
    assert len(witnesses) == 1
    property_witness = witnesses[0]
    operation = past if shape == "if_past" else lemma
    operation_start = phrase.index(operation)
    assert property_witness.predicate == (operation_start, operation_start + len(operation))
    assert property_witness.operand == (operation_start + len(operation), phrase.index(","))
    assert property_witness.attachment_role == "operand"
    assert property_witness.canonical_obligation and property_witness.content_role == "supplied"
    assert property_witness.assumed_role_witness is None
    assert phrase[slice(*property_witness.property_span)] == qualified
    assessment = _assess_prose(phrase)
    action = next(record for record in assessment.propositions if record.governing_actor == "I"
                  and record.hypothesis_start == 0)
    property_record = next(record for record in assessment.propositions if record.start == phrase.index("my"))
    assert action.hypothesis_start == 0 and not action.personal_assertion
    assert property_record.canonical_property and property_record.source_check_text == qualified
    assert not property_record.personal_assertion
    main = next(record for record in assessment.propositions if record.start > phrase.index(","))
    assert main.hypothesis_start is None


@pytest.mark.parametrize("lemma,past,operand", CONTROLLING_ACTIONS)
@pytest.mark.parametrize("shape", ["if_present", "if_past"])
@pytest.mark.parametrize("qualified", ["my current directorship at Acme", "my assumptions about my prior role as Director at Acme"])
@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_assumed_action_requires_its_qualified_property_source(tmp_path: Path, lemma, past, operand, shape, qualified, question_id, location, support):
    phrase = f"If I {past if shape == 'if_past' else lemma} {qualified}, I would review options."
    test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path, question_id, location, support, phrase, False)


@pytest.mark.parametrize("scope", ["matching", "unrelated", "empty"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_assumed_action_property_uses_same_question_excerpt(tmp_path: Path, scope, location, support):
    conn = _init_conn(tmp_path)
    try:
        question_id = "M02" if scope == "empty" else "B11"
        request = _request(question_id)
        source = "My current directorship at Acme." if scope == "matching" else "I reduced API latency by 30% using Python."
        request["canonical_evidence"] = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=request["tenant_id"], profile_id=request["profile_snapshot"].profile_id, profile_version=1,
            rows=[{"evidence_id": "ev-platform-latency", "source_text": source, "user_confirmed": 1, "evidence_strength": "supported"}])
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        phrase = "If I test my current directorship at Acme, I would review options."
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="conditional-property", **request)
        assert outcome.status == ("accepted" if scope == "matching" else "failed"), outcome.errors
        assert len(llm.calls) == (2 if scope == "matching" else 1)
        if scope != "matching":
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("name", ["Test Review", "Review Test", "test review", "Shared Services"])
@pytest.mark.parametrize("postposed", [False, True])
def test_scalar_operation_name_retains_outer_hypothesis(name, postposed):
    from jobctrl.domain.interview.question_generation import _assess_prose, _predicate_syntax

    assumed = f'I managed a team called "{name}" and I had limited authority'
    phrase = f"I would compare criteria if {assumed}." if postposed else f"If {assumed}, I would compare criteria."
    syntax = _predicate_syntax(phrase)
    quotation = (phrase.index('"'), phrase.rindex('"') + 1)
    assert not any(span.quote_scope == quotation for span in syntax)
    assert any(span.nominal_operand_witnesses for span in syntax)
    assessment = _assess_prose(phrase)
    assumptions = [record for record in assessment.propositions if record.governing_actor == "I"
                   and ("managed" in record.text or "had limited" in record.text)]
    assert len(assumptions) == 2
    assert all(record.hypothesis_start == phrase.lower().index("if ") and not record.personal_assertion for record in assumptions)


@pytest.mark.parametrize("name", ["Test Review", "Review Test", "test review", "Shared Services"])
@pytest.mark.parametrize("postposed", [False, True])
@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_scalar_operation_name_is_not_an_actual_child(tmp_path: Path, name, postposed, question_id, location, support):
    assumed = f'I managed a team called "{name}" and I had limited authority'
    phrase = f"I would compare criteria if {assumed}." if postposed else f"If {assumed}, I would compare criteria."
    test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path, question_id, location, support, phrase, True)


@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("phrase,accepted", [
    ("If I managed my hypothetical team of 50 engineers, I would compare criteria.", True),
    ('If I managed "my hypothetical team" of 50 engineers, I would compare criteria.', True),
    ('I would explain "If I managed my hypothetical team of 50 engineers, I would compare criteria."', True),
    ("If I managed my current team of 50 engineers, I would compare criteria.", False),
    ("If I managed my hypothetical team of 50 engineers at Acme, I would compare criteria.", False),
    ("I managed my hypothetical team of 50 engineers.", False),
])
def test_assumed_nominal_operand_requires_full_owned_role(tmp_path: Path, question_id, location, support, phrase, accepted):
    test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path, question_id, location, support, phrase, accepted)


@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("phrase,accepted", [
    ("If I have in fact served as Director at Acme, I would compare criteria.", True),
    ("If you had learned as a Director at Acme, how would you approach technical involvement?", True),
    ('I would explain "If I have in fact served as Director at Acme, I would compare criteria."', True),
    ("If I had learned from my current directorship at Acme, I would compare criteria.", False),
    ("I have in fact served as Director at Acme.", False),
    ('I would explain "If I have in fact served as Director at Acme, I would compare criteria." I rescued every critical launch.', False),
])
def test_own_auxiliary_action_preserves_separate_property_scope(tmp_path: Path, question_id, location, support, phrase, accepted):
    test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path, question_id, location, support, phrase, accepted)


@pytest.mark.parametrize("auxiliary,lexical,rest", [("have in fact", "served", "as Director at Acme"),
                                                   ("had", "learned", "as a Director at Acme")])
@pytest.mark.parametrize("conditional", [True, False])
def test_auxiliary_content_trace_uses_own_lexical_relationship(auxiliary, lexical, rest, conditional):
    from jobctrl.domain.interview.question_generation import _assess_prose, _predicate_syntax

    phrase = f"If I {auxiliary} {lexical} {rest}, I would compare criteria." if conditional else f"I {auxiliary} {lexical} {rest}."
    lexical_start = phrase.index(lexical)
    end = phrase.index(",") if conditional else len(phrase.rstrip("."))
    witnesses = [witness for owner in _predicate_syntax(phrase) for witness in owner.personal_content_witnesses
                 if witness.property_span == (lexical_start, end)]
    assert len(witnesses) == 1
    witness = witnesses[0]
    auxiliary_start = phrase.index(auxiliary)
    actor_start = phrase.index(" I ") + 1 if conditional else 0
    assert witness.predicate == (auxiliary_start, auxiliary_start + len(auxiliary.split()[0]))
    assert witness.attachment_role == "operand" and witness.canonical_obligation
    assert witness.assumed_role_witness == ("auxiliary_predicate", ((actor_start, actor_start + 1),),
                                            witness.predicate, (lexical_start, lexical_start + len(lexical)),
                                            (auxiliary_start, lexical_start), witness.operand)
    records = [record for record in _assess_prose(phrase).propositions if record.start == lexical_start]
    assert len(records) == 1
    record = records[0]
    assert record.hypothesis_start == (0 if conditional else None)
    assert record.canonical_property == (not conditional)
    assert record.source_check_text == ("" if conditional else f"{lexical} {rest}")


@pytest.mark.parametrize("phrase,property_text,canonical", [
    ("If my current team of 50 engineers had limited authority, I would compare criteria.", "my current team of 50 engineers", True),
    ("If my team had 50 engineers, I would compare criteria.", "my team", False),
    ("If my hypothetical team of 50 engineers had limited authority, I would compare criteria.", "my hypothetical team of 50 engineers", False),
    ("I would monitor involvement if my review becomes the critical path and my hypothetical team needs support.", "my hypothetical team", False),
])
def test_complete_nominal_unit_has_own_coverage_and_canonical_projection(phrase, property_text, canonical):
    from jobctrl.domain.interview.question_generation import _assess_prose, _predicate_syntax, _resolve_content

    left = phrase.index(property_text)
    unit = (left, left + len(property_text))
    owners = [owner for owner in _predicate_syntax(phrase)
              if any(witness.property_span == unit for witness in owner.personal_content_witnesses)]
    assert len(owners) == 1
    owner = owners[0]
    witness = next(witness for witness in owner.personal_content_witnesses if witness.property_span == unit)
    assert witness.content == unit and witness.source_spans == (unit,)
    records = [record for record in _assess_prose(phrase).propositions
               if (record.start, record.end) == unit]
    assert len(records) == 1
    record = records[0]
    assert record.hypothesis_start == phrase.lower().index("if")
    resolved = _resolve_content(witness, owner=(owner.start, owner.end, owner.quote_scope),
                                hypothesis=(record.hypothesis_start, record.hypothesis_postposed), dependency_operator=None)
    assert resolved.source_units == (unit,)
    assert resolved.units[0].canonical == record.canonical_property == canonical
    assert record.source_check_text == (property_text if canonical else "")
    assert all(coverage.owner == (owner.start, owner.end, owner.quote_scope) for coverage in witness.coverage)
    if canonical:
        assert not witness.coverage
    else:
        assert witness.coverage and all(coverage.source_units == (unit,) for coverage in witness.coverage)


def test_covered_nominal_does_not_drop_second_full_canonical_residual_unit():
    from jobctrl.domain.interview.question_generation import _ContentCoverage, _PersonalContentBinding, _resolve_content

    phrase = "my hypothetical team; my current team of 50 engineers"
    first = (0, phrase.index(";"))
    second = (phrase.index("my current"), len(phrase))
    owner = (0, len(phrase), None)
    coverage = _ContentCoverage((first,), "hypothesis", "conditional",
                                ("assumed_nominal", (first,), None, first, (16, 20), (2, 16), None), owner)
    witness = _PersonalContentBinding((0, 2), first, first, None, None, "subject", "existing_property",
                                      (first, second), canonical_obligation=True, coverage=(coverage,))
    result = _resolve_content(witness, owner=owner, hypothesis=(0, False), dependency_operator=None)
    assert result.source_units == (first, second)
    assert [(unit.canonical, unit.checked) for unit in result.units] == [(False, False), (True, True)]
    assert result.checked_units == (second,)
    assert phrase[slice(*result.checked_units[0])] == "my current team of 50 engineers"
    # An adjacent owner's hypothesis cannot activate this unit's coverage.
    unrelated = _resolve_content(witness, owner=(1, len(phrase), None), hypothesis=(0, False), dependency_operator=None)
    assert unrelated.checked_units == (first, second)
    assert all(unit.canonical for unit in unrelated.units)


@pytest.mark.parametrize("scope", ["matching", "unrelated", "empty", "split"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_current_subject_np_keeps_same_excerpt_proof_and_refresh_retention(tmp_path: Path, scope, location, support):
    conn = _init_conn(tmp_path)
    try:
        question_id = "M02" if scope == "empty" else "B11"
        request = _request(question_id)
        rows = [{"evidence_id": "ev-platform-latency", "source_text":
                 "My current team of 50 engineers." if scope == "matching" else
                 "My current team." if scope == "split" else "I reduced API latency by 30% using Python.",
                 "user_confirmed": 1, "evidence_strength": "supported"}]
        if scope == "split":
            rows.append({"evidence_id": "ev-team-size", "source_text": "50 engineers.",
                         "user_confirmed": 1, "evidence_strength": "supported"})
            request["selection_input"]["evidenceSelections"] = [{"questionId": question_id,
                                                                  "evidenceIds": ["ev-platform-latency", "ev-team-size"]}]
        request["canonical_evidence"] = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=request["tenant_id"], profile_id=request["profile_snapshot"].profile_id, profile_version=1, rows=rows)
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        assert prior.status == "accepted"
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        phrase = "If my current team of 50 engineers had limited authority, I would compare criteria."
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="np-coverage", **request)
        accepted = scope == "matching"
        assert outcome.status == ("accepted" if accepted else "failed"), outcome.errors
        assert len(llm.calls) == (2 if accepted else 1)
        if not accepted:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")
