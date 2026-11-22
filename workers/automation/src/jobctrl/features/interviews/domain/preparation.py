"""Pure snapshot construction for grounded interview preparation."""

from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

from jobctrl.features.interviews.domain.catalog import InterviewQuestionCard, canonical_json_digest
from jobctrl.features.interviews.source_authority.job_snapshot import build_jd_snapshot, compute_snapshot_hash
from jobctrl.features.interviews.source_authority.profile_snapshot import ProfileSnapshot
from jobctrl.features.interviews.source_authority.interview_plan import (
    accepted_evidence_sources, fence_evidence_selection, normalize_selection, selection_from_rpc,
)

PROMPT_VERSION = "interview-questions-v6"
GATE_VERSION = "interview-claim-verification-v1"
MAX_PROMPT_CONTEXT_CHARS = 110_000

__all__ = ["accepted_evidence_sources", "fence_evidence_selection", "normalize_selection", "selection_from_rpc",
           "generation_context", "job_context_snapshot", "rationale", "MAX_PROMPT_CONTEXT_CHARS"]


def generation_context(
    *,
    cards: tuple[InterviewQuestionCard, ...],
    selection: Mapping[str, Any],
    plans: Mapping[str, list[dict[str, str]]],
    profile_snapshot: ProfileSnapshot,
    accepted_materials: Sequence[Mapping[str, Any]],
    model: str,
    job: Mapping[str, Any],
    employer_context: Mapping[str, Any] | None,
    fit_context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    evidence = {link["evidenceId"]: link for links in plans.values() for link in links}
    explicit_questions = {row["questionId"] for row in selection.get("evidenceSelections", ())}
    selected = [
        {
            "questionId": card["id"],
            "cardRevision": card["cardRevision"],
            "cardDigest": card["cardDigest"],
            "rubricRevision": card["rubricRevision"],
            "rubricDigest": card["rubricDigest"],
            "answerFormat": card["defaultAnswerFormat"],
            "selectionRationale": rationale(card, selection),
            "snapshot": deepcopy(card),
            "evidenceSelectionMode": "user_selected" if card["id"] in explicit_questions else "model",
            "selectedEvidenceIds": [link["evidenceId"] for link in plans[card["id"]]],
        }
        for card in cards
    ]
    materials: dict[tuple[str, int], list[Mapping[str, Any]]] = {}
    for material in accepted_materials:
        if "materialSha256" not in material:
            continue
        key = (str(material["artifactId"]), int(material["generation"]))
        materials.setdefault(key, []).append(material)
    context = {
        "schemaVersion": "2",
        "catalogBinding": deepcopy(selection["catalogBinding"]),
        "selectedQuestionIds": list(selection["selectedQuestionIds"]),
        "selectedQuestions": selected,
        "selectionMode": selection["selectionMode"],
        "interviewStage": selection["interviewStage"],
        "interviewFormat": selection["interviewFormat"],
        "roleLens": selection["roleLens"],
        "roleResponsibilities": list(selection["roleResponsibilities"]),
        "knownCriteria": list(selection["knownCriteria"]),
        "profile": {
            "profileId": profile_snapshot.profile_id,
            "version": profile_snapshot.version,
            "evidence": list(evidence.values()),
        },
        "jobContext": job_context_snapshot(job),
        "employerAnalysis": (
            {
                "generation": employer_context["generation"],
                "snapshotHash": employer_context["snapshotHash"],
                "snapshot": {
                    "roleFraming": employer_context["roleFraming"],
                    "inferredSeniority": employer_context["inferredSeniority"],
                    "requirements": [
                        {key: str(row.get(key) or "") for key in ("requirementId", "requirementText", "sourceExcerpt")}
                        for row in employer_context["requirements"]
                    ],
                },
            }
            if employer_context
            else None
        ),
        "fitReport": (
            {
                "generation": fit_context["scoreVersion"],
                "employerAnalysisGeneration": fit_context["employerAnalysisGeneration"],
                "profileSnapshotVersion": fit_context["profileSnapshotVersion"],
                "status": fit_context["status"],
            }
            if fit_context
            else None
        ),
        "approvedMaterials": [
            {"materialId": artifact_id, "generation": generation, "sha256": str(rows[0]["materialSha256"])}
            for (artifact_id, generation), rows in materials.items()
        ],
        "model": {"model": model, "promptVersion": PROMPT_VERSION, "gateVersion": GATE_VERSION},
    }
    context["contextDigest"] = canonical_json_digest(context)
    return context


def rationale(card: InterviewQuestionCard, selection: Mapping[str, Any]) -> str:
    if selection["selectionMode"] == "user_selected":
        return str(selection.get("selectionRationale") or "Selected by the user for this preparation.")
    return str(selection["questionRationales"][card["id"]])


def job_context_snapshot(job: Mapping[str, Any]) -> dict[str, str]:
    title = str(job.get("title") or "").strip()
    company = str(job.get("company") or job.get("employer") or "").strip()
    if len(title) > 500 or len(company) > 500:
        raise ValueError("job title/company exceeds preparation budget")
    return {
        "jobId": str(job["job_id"]),
        "title": title,
        "company": company,
        "descriptionExcerpt": str(job.get("full_description") or job.get("description") or "").strip()[:12000],
        "snapshotHash": compute_snapshot_hash(build_jd_snapshot(dict(job))),
    }
