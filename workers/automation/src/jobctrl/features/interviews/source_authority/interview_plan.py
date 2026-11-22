"""Pure Interview question planning, selection and source binding."""

from __future__ import annotations

import re
from collections.abc import Mapping
from copy import deepcopy
from typing import TYPE_CHECKING, Any, Literal

from pydantic import Field, StrictStr

from jobctrl.semantic.determinations import Citation, DeterminationFailure, DeterminationModel, Source, parse_model_result, validate_citations
from jobctrl.features.interviews.domain.catalog import (
    INTERVIEW_FORMATS, INTERVIEW_ROLE_LENSES, INTERVIEW_STAGES,
    MAX_INTERVIEW_SELECTED_QUESTIONS, MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION,
    InterviewSelectionError, validate_interview_selection,
)

if TYPE_CHECKING:
    from jobctrl.features.interviews.domain.evidence import InterviewEvidenceSnapshot

DEFAULT_QUESTION_COUNT = 5
INTERVIEW_PLAN_SCHEMA_VERSION = "1"
INTERVIEW_PLAN_PROMPT_VERSION = "interview-plan-v1"
INTERVIEW_PLAN_INSTRUCTION = (
    "Select relevant interview questions and accepted personal evidence by understanding the supplied question intents, responsibilities, criteria and evidence. "
    "Identify direct versus transferable evidence semantically. Cite the canonical evidence verbatim. Honor explicit question IDs in order and explicit evidence IDs exactly, including empty selections. "
    "Empty means no personal evidence. Otherwise recommend at most the maximum question count and eight evidence items per question. Link only supplied requirement IDs. "
    "Give a rationale for every selection. Catalog guidance is not evidence of the candidate's history."
)

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



class InterviewPlanRequest:
    """Bind a planner result to the exact selected catalog and Profile sources."""

    def __init__(self, *, catalog, selection, profile_snapshot, canonical_evidence, requirements):
        self._selection = normalize_selection(selection)
        self._binding = {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}
        if self._selection.get("catalogBinding") is not None and self._selection["catalogBinding"] != self._binding:
            raise InterviewSelectionError("catalog_mismatch")
        self._requested = self._selection.get("selectedQuestionIds")
        if self._requested is not None:
            validate_interview_selection(self._requested, catalog_binding=self._selection.get("catalogBinding"), catalog=catalog)
        self._evidence = deepcopy(fence_evidence_selection(self._selection, profile_snapshot, canonical_evidence))
        self._overrides = {row["questionId"]: list(row["evidenceIds"]) for row in self._selection.get("evidenceSelections", ())}
        self._cards = {card["id"]: deepcopy(card) for card in catalog["questions"]}
        if set(self._overrides) - set(self._requested or self._cards):
            raise InterviewSelectionError("invalid_evidence_selection")
        self._requirements = {str(row["requirementId"]) for row in requirements}
        available = ([self._cards[question_id] for question_id in self._requested]
                     if self._requested is not None else list(self._cards.values()))
        self._sources = [*(Source(source_id="card:" + card["id"], text=card["title"] + "\n" + card["intent"]) for card in available),
                         *(Source(source_id=evidence_id, text=row["excerpt"]) for evidence_id, row in self._evidence.items()),
                         *(Source(source_id="requirement:" + str(row["requirementId"]), text=str(row.get("requirementText") or "")) for row in requirements)]
        if len({source.source_id for source in self._sources}) != len(self._sources):
            raise DeterminationFailure("duplicate_source_id")
        self._profile_id, self._profile_version = profile_snapshot.profile_id, profile_snapshot.version
        self._context = {"selection": deepcopy(self._selection), "maximum_questions": DEFAULT_QUESTION_COUNT,
                         "profile_id": self._profile_id, "profile_version": self._profile_version}
        self.response_model = InterviewPlan
        self.instruction = INTERVIEW_PLAN_INSTRUCTION

    @property
    def sources(self):
        return [source.model_copy(deep=True) for source in self._sources]

    @property
    def context(self):
        return deepcopy(self._context)

    def validate(self, raw):
        result = parse_model_result(InterviewPlan, raw)
        validate_citations(result, self._sources)
        ids = [row.question_id for row in result.questions]
        if len(set(ids)) != len(ids) or set(ids) - set(self._cards):
            raise DeterminationFailure("foreign_question_id")
        if self._requested is not None and ids != self._requested:
            raise DeterminationFailure("question_selection_changed")
        if self._requested is None and len(ids) > DEFAULT_QUESTION_COUNT:
            raise DeterminationFailure("selection_over_budget")
        for row in result.questions:
            evidence_ids = [item.evidence_id for item in row.evidence]
            if len(set(evidence_ids)) != len(evidence_ids) or set(evidence_ids) - set(self._evidence):
                raise DeterminationFailure("foreign_source_id")
            if row.question_id in self._overrides and evidence_ids != self._overrides[row.question_id]:
                raise DeterminationFailure("evidence_selection_changed")
            if any(item.citation.source_id != item.evidence_id for item in row.evidence):
                raise DeterminationFailure("evidence_binding_invalid")
            if set(row.requirement_ids) - self._requirements:
                raise DeterminationFailure("foreign_requirement_id")
        selected = deepcopy(self._selection)
        selected.update({"catalogBinding": deepcopy(self._binding), "selectedQuestionIds": ids,
                         "selectionMode": "user_selected" if self._requested is not None else "model",
                         "questionRationales": {row.question_id: row.rationale for row in result.questions},
                         "requirementSelections": {row.question_id: list(row.requirement_ids) for row in result.questions}})
        for key, value in (("interviewStage", "unknown"), ("interviewFormat", "unspecified"),
                           ("roleLens", "unknown"), ("roleResponsibilities", []), ("knownCriteria", [])):
            selected.setdefault(key, value)
        plans = {row.question_id: [{"evidenceId": item.evidence_id,
                  "sourceRef": f"profile:{self._profile_id}:{self._profile_version}:evidence:{item.evidence_id}",
                  "excerpt": self._evidence[item.evidence_id]["excerpt"], "scope": item.scope}
                 for item in row.evidence] for row in result.questions}
        return tuple(deepcopy(self._cards[row.question_id]) for row in result.questions), selected, plans


def prepare_interview_plan(*, catalog, selection, profile_snapshot, canonical_evidence, requirements):
    return InterviewPlanRequest(catalog=catalog, selection=selection, profile_snapshot=profile_snapshot,
                                canonical_evidence=canonical_evidence, requirements=requirements)
