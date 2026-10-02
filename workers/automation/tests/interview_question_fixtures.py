"""Public synthetic question-card fixtures for generation boundary tests."""

from typing import Any

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

