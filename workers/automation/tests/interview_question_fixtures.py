"""Public synthetic question-card fixtures for generation boundary tests."""

import json
from typing import Any

from jobctrl.domain.interview.evidence import InterviewEvidenceSnapshot

def card(question_id: str, answer_format: str, *, role: str = "unknown", tags: list[str] | None = None) -> dict[str, Any]:
    return {"id": question_id, "title": f"Synthetic {question_id}", "topic": question_id,
            "status": "active", "maturity": "research_draft", "cardRevision": "1", "cardDigest": "a" * 64,
            "rubricRevision": "1", "rubricDigest": "b" * 64, "roleLenses": [role],
            "responsibilityTags": tags or ["latency"], "competencyTags": tags or ["Python"],
            "answerFormats": [answer_format], "defaultAnswerFormat": answer_format,
            "attributionKind": "editorial_synthesis", "sourceRef": "synthetic.md#question", "variants": "variant",
            "intent": "Explain latency decisions", "answer": "Use true scope and criteria", "adaptation": "No invented authority",
            "alternatives": "Different sound approaches", "probes": "Which information would change the choice?",
            "failures": "Inventing experience", "provenance": "Synthetic fixture", "rubric": [{"dimension": "judgment", "weak": "unexplained", "strong": "criteria"}],
            "sources": ["source-1"], "examples": []}
def canonical_evidence(profile):
    """Explicit raw canonical-row fixture; no display reconciliation or synthesis."""
    rows = []
    for entry in profile.as_dict().get("resume", {}).get("experience_entries", []):
        for fact in entry.get("achievement_evidence", []):
            rows.append({"evidence_id": fact["id"], "source_text": fact.get("source_text"),
                         "scope": fact.get("scope"), "action": fact.get("action"), "outcome": fact.get("outcome"),
                         "user_confirmed": fact.get("user_confirmed"), "evidence_strength": fact.get("evidence_strength"),
                         **{f"{key}_json": json.dumps(fact.get(key, [])) for key in ("metrics", "tools", "tags")}})
    return InterviewEvidenceSnapshot.from_canonical_rows(tenant_id=profile.tenant_id, profile_id=profile.profile_id,
                                                         profile_version=profile.version, rows=rows)

