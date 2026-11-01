"""Bounded input fencing and model-owned question/evidence planning."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from copy import deepcopy
from typing import Any, Literal

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import (
    Citation,
    DeterminationFailure,
    DeterminationModel,
    DeterminationRepository,
    Source,
    determine,
)
from jobctrl.domain.interview.catalog import (
    INTERVIEW_FORMATS,
    INTERVIEW_ROLE_LENSES,
    INTERVIEW_STAGES,
    MAX_INTERVIEW_SELECTED_QUESTIONS,
    MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION,
    InterviewCatalog,
    InterviewQuestionCard,
    InterviewSelectionError,
    canonical_json_digest,
    validate_interview_selection,
)
from jobctrl.domain.interview.evidence import InterviewEvidenceSnapshot
from jobctrl.domain.job_snapshot import build_jd_snapshot, compute_snapshot_hash
from jobctrl.domain.ports.llm import LlmPort
from jobctrl.domain.profile.snapshot import ProfileSnapshot

PROMPT_VERSION = "interview-questions-v6"
GATE_VERSION = "interview-claim-verification-v1"
MAX_PROMPT_CONTEXT_CHARS = 110_000
DEFAULT_QUESTION_COUNT = 5
_SELECTION_KEYS = frozenset(
    {
        "selectedQuestionIds",
        "catalogBinding",
        "interviewStage",
        "interviewFormat",
        "roleLens",
        "roleResponsibilities",
        "knownCriteria",
        "selectionRationale",
        "evidenceSelections",
        "evidenceProfileVersion",
    }
)


class PlannedEvidence(DeterminationModel):
    evidence_id: StrictStr = Field(min_length=1, max_length=200)
    scope: Literal["direct", "transferable"]
    citation: Citation
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class PlannedQuestion(DeterminationModel):
    question_id: StrictStr = Field(min_length=1, max_length=12)
    rationale: StrictStr = Field(min_length=1, max_length=2000)
    citations: list[Citation] = Field(min_length=1, max_length=16)
    evidence: list[PlannedEvidence] = Field(max_length=MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION)
    requirement_ids: list[StrictStr] = Field(max_length=20)


class InterviewPlan(DeterminationModel):
    questions: list[PlannedQuestion] = Field(min_length=1, max_length=MAX_INTERVIEW_SELECTED_QUESTIONS)


def fence_evidence_selection(selection, profile_snapshot, canonical_evidence):
    if canonical_evidence is not None and (
        canonical_evidence.tenant_id != profile_snapshot.tenant_id
        or canonical_evidence.profile_id != profile_snapshot.profile_id
        or canonical_evidence.profile_version != profile_snapshot.version
    ):
        raise InterviewSelectionError("evidence_profile_changed")
    if "evidenceSelections" in selection and selection["evidenceProfileVersion"] != profile_snapshot.version:
        raise InterviewSelectionError("evidence_profile_changed")
    by_id = {source["id"]: source for source in accepted_evidence_sources(canonical_evidence)}
    for row in selection.get("evidenceSelections", ()):
        if any(evidence_id not in by_id for evidence_id in row["evidenceIds"]):
            raise InterviewSelectionError("invalid_evidence_selection", row["questionId"])
    return by_id


class ModelInterviewPlanner:
    def __init__(
        self,
        *,
        llm: LlmPort | None,
        repository: DeterminationRepository,
        tenant_id: str,
        provider: str,
        model: str,
        preflight: Callable[[], object],
    ):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._preflight = provider, model, preflight

    def plan(
        self, *, catalog: InterviewCatalog, selection, profile_snapshot, canonical_evidence, requirements, entity_id
    ):
        context = normalize_selection(selection)
        binding = {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}
        if context.get("catalogBinding") is not None and context["catalogBinding"] != binding:
            raise InterviewSelectionError("catalog_mismatch")
        requested = context.get("selectedQuestionIds")
        if requested is not None:
            validate_interview_selection(requested, catalog_binding=context.get("catalogBinding"), catalog=catalog)
        by_id = fence_evidence_selection(context, profile_snapshot, canonical_evidence)
        overrides = {row["questionId"]: row["evidenceIds"] for row in context.get("evidenceSelections", ())}
        cards_by_id = {card["id"]: card for card in catalog["questions"]}
        if set(overrides) - set(requested or cards_by_id):
            raise InterviewSelectionError("invalid_evidence_selection")
        requirement_ids = {str(row["requirementId"]) for row in requirements}
        available_cards = (
            [cards_by_id[question_id] for question_id in requested]
            if requested is not None
            else list(cards_by_id.values())
        )
        sources = [
            *(
                Source(source_id="card:" + card["id"], text=card["title"] + "\n" + card["intent"])
                for card in available_cards
            ),
            *(Source(source_id=evidence_id, text=row["excerpt"]) for evidence_id, row in by_id.items()),
            *(
                Source(source_id="requirement:" + str(row["requirementId"]), text=str(row.get("requirementText") or ""))
                for row in requirements
            ),
        ]

        def validate(result: InterviewPlan) -> None:
            ids = [row.question_id for row in result.questions]
            if len(set(ids)) != len(ids) or set(ids) - set(cards_by_id):
                raise DeterminationFailure("foreign_question_id")
            if requested is not None and ids != requested:
                raise DeterminationFailure("question_selection_changed")
            if requested is None and len(ids) > DEFAULT_QUESTION_COUNT:
                raise DeterminationFailure("selection_over_budget")
            for row in result.questions:
                evidence_ids = [item.evidence_id for item in row.evidence]
                if len(set(evidence_ids)) != len(evidence_ids) or set(evidence_ids) - set(by_id):
                    raise DeterminationFailure("foreign_source_id")
                if row.question_id in overrides and evidence_ids != overrides[row.question_id]:
                    raise DeterminationFailure("evidence_selection_changed")
                if any(item.citation.source_id != item.evidence_id for item in row.evidence):
                    raise DeterminationFailure("evidence_binding_invalid")
                if set(row.requirement_ids) - requirement_ids:
                    raise DeterminationFailure("foreign_requirement_id")

        result, envelope = determine(
            kind="interview_plan",
            schema=InterviewPlan,
            schema_version="1",
            prompt_version="interview-plan-v1",
            instruction="Select relevant interview questions and accepted personal evidence by understanding the supplied question intents, responsibilities, criteria and evidence. Identify direct versus transferable evidence semantically. Cite the canonical evidence verbatim. Honor explicit question IDs in order and explicit evidence IDs exactly, including empty selections. Empty means no personal evidence. Otherwise recommend at most the maximum question count and eight evidence items per question. Link only supplied requirement IDs. Give a rationale for every selection. Catalog guidance is not evidence of the candidate's history.",
            sources=sources,
            context={
                "selection": context,
                "maximum_questions": DEFAULT_QUESTION_COUNT,
                "profile_id": profile_snapshot.profile_id,
                "profile_version": profile_snapshot.version,
            },
            tenant_id=self._tenant_id,
            entity_id=entity_id,
            provider=self._provider,
            model=self._model,
            lane="interview",
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
            validate=validate,
        )
        context.update(
            {
                "catalogBinding": binding,
                "selectedQuestionIds": [row.question_id for row in result.questions],
                "selectionMode": "user_selected" if requested is not None else "model",
                "questionRationales": {row.question_id: row.rationale for row in result.questions},
                "requirementSelections": {row.question_id: row.requirement_ids for row in result.questions},
            }
        )
        for key, value in (
            ("interviewStage", "unknown"),
            ("interviewFormat", "unspecified"),
            ("roleLens", "unknown"),
            ("roleResponsibilities", []),
            ("knownCriteria", []),
        ):
            context.setdefault(key, value)
        plans = {
            row.question_id: [
                {
                    "evidenceId": item.evidence_id,
                    "sourceRef": f"profile:{profile_snapshot.profile_id}:{profile_snapshot.version}:evidence:{item.evidence_id}",
                    "excerpt": by_id[item.evidence_id]["excerpt"],
                    "scope": item.scope,
                }
                for item in row.evidence
            ]
            for row in result.questions
        }
        return tuple(cards_by_id[row.question_id] for row in result.questions), context, plans, envelope


def selection_from_rpc(params: Mapping[str, Any]) -> dict[str, Any]:
    return normalize_selection({key: params[key] for key in _SELECTION_KEYS if key in params})


def normalize_selection(value: Mapping[str, Any] | None) -> dict[str, Any]:
    """Mirror wire bounds without performing resource I/O in workflow replay."""
    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) - _SELECTION_KEYS:
        raise InterviewSelectionError("invalid_selection")
    result = deepcopy(dict(value))
    for key, choices in (
        ("interviewStage", INTERVIEW_STAGES),
        ("interviewFormat", INTERVIEW_FORMATS),
        ("roleLens", INTERVIEW_ROLE_LENSES),
    ):
        if key in result and result[key] not in choices:
            raise InterviewSelectionError("invalid_selection")
    for key, max_length in (("roleResponsibilities", 160), ("knownCriteria", 1000)):
        if key in result:
            rows = result[key]
            if (
                not isinstance(rows, (list, tuple))
                or len(rows) > 20
                or any(not isinstance(row, str) or not row.strip() or len(row.strip()) > max_length for row in rows)
            ):
                raise InterviewSelectionError("invalid_selection")
            result[key] = [row.strip() for row in rows]
    if "selectionRationale" in result:
        text = result["selectionRationale"]
        if not isinstance(text, str) or len(text.strip()) > 2000:
            raise InterviewSelectionError("invalid_selection")
        result["selectionRationale"] = text.strip()
    if "catalogBinding" in result:
        binding = result["catalogBinding"]
        if (
            not isinstance(binding, dict)
            or set(binding) != {"catalogRevision", "catalogDigest"}
            or not isinstance(binding["catalogRevision"], str)
            or not 1 <= len(binding["catalogRevision"].strip()) <= 100
            or not isinstance(binding["catalogDigest"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", binding["catalogDigest"])
        ):
            raise InterviewSelectionError("catalog_mismatch")
    if "selectedQuestionIds" in result:
        ids = result["selectedQuestionIds"]
        if not isinstance(ids, (list, tuple)) or not ids:
            raise InterviewSelectionError("invalid_selection")
        if len(ids) > MAX_INTERVIEW_SELECTED_QUESTIONS:
            raise InterviewSelectionError("selection_over_budget")
        if any(
            not isinstance(question_id, str) or len(question_id) > 12 or not re.fullmatch(r"[A-Z]+\d{2}", question_id)
            for question_id in ids
        ):
            raise InterviewSelectionError("invalid_selection")
        if len(set(ids)) != len(ids):
            raise InterviewSelectionError("duplicate_question")
        result["selectedQuestionIds"] = list(ids)
    if "evidenceProfileVersion" in result:
        version = result["evidenceProfileVersion"]
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise InterviewSelectionError("invalid_evidence_selection")
    if "evidenceSelections" in result:
        rows = result["evidenceSelections"]
        if (
            "evidenceProfileVersion" not in result
            or not isinstance(rows, (list, tuple))
            or len(rows) > MAX_INTERVIEW_SELECTED_QUESTIONS
        ):
            raise InterviewSelectionError("invalid_evidence_selection")
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, Mapping) or set(row) != {"questionId", "evidenceIds"}:
                raise InterviewSelectionError("invalid_evidence_selection")
            question_id, evidence_ids = row["questionId"], row["evidenceIds"]
            if (
                not isinstance(question_id, str)
                or len(question_id) > 12
                or not re.fullmatch(r"[A-Z]+\d{2}", question_id)
                or question_id in seen
                or not isinstance(evidence_ids, (list, tuple))
                or len(evidence_ids) > MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION
                or any(not isinstance(item, str) or not item.strip() or len(item) > 200 for item in evidence_ids)
            ):
                raise InterviewSelectionError("invalid_evidence_selection")
            ids = list(evidence_ids)
            if len(set(ids)) != len(ids) or (
                "selectedQuestionIds" in result and question_id not in result["selectedQuestionIds"]
            ):
                raise InterviewSelectionError("invalid_evidence_selection", question_id)
            seen.add(question_id)
            row["evidenceIds"] = ids
        result["evidenceSelections"] = list(rows)
    return result


def accepted_evidence_sources(canonical_evidence: InterviewEvidenceSnapshot | None) -> list[dict[str, Any]]:
    """Current canonical accepted facts; IDs are exact saved IDs, without aliases.

    The canonical input reader supplies raw accepted rows. Profile display
    reconciliation, legacy bullets and independent notes are never authority.
    """
    return (
        [
            {"id": source.evidence_id, "excerpt": source.excerpt, "tags": source.tags}
            for source in canonical_evidence.sources
        ]
        if canonical_evidence is not None
        else []
    )


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
