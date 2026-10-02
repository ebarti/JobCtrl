"""Versioned public interview guidance, loaded identically in source and installed workers.

Wire keys intentionally match the pure TypeScript vocabulary. This module owns
no personal facts, provider calls, SQLite state, or runtime Markdown inference.
"""

from __future__ import annotations

import hashlib
import json
from importlib.resources import files
from typing import Any, Literal, NotRequired, TypedDict

InterviewAnswerFormat = Literal["historical", "situational", "principle", "negotiation", "narrative", "preference"]
InterviewRoleLens = Literal["ic", "senior_ic", "staff_principal", "first_time_manager", "engineering_manager", "director", "executive", "unknown"]
InterviewStage = Literal["recruiter", "behavioral", "management", "technical", "executive", "mixed", "unknown"]
InterviewFormat = Literal["phone", "video", "onsite", "written", "unspecified"]
INTERVIEW_ANSWER_FORMATS = ("historical", "situational", "principle", "negotiation", "narrative", "preference")
INTERVIEW_ROLE_LENSES = ("ic", "senior_ic", "staff_principal", "first_time_manager", "engineering_manager", "director", "executive", "unknown")
INTERVIEW_STAGES = ("recruiter", "behavioral", "management", "technical", "executive", "mixed", "unknown")
INTERVIEW_FORMATS = ("phone", "video", "onsite", "written", "unspecified")
MAX_INTERVIEW_SELECTED_QUESTIONS = 16
MAX_INTERVIEW_NOTE_TEXT_LENGTH = 20_000
CATALOG_RESOURCE_NAME = "catalog.v1.json"


class InterviewCatalogBinding(TypedDict):
    catalogRevision: str
    catalogDigest: str


class InterviewQuestionCard(TypedDict):
    id: str
    title: str
    topic: str
    status: Literal["active"]
    maturity: Literal["research_draft"]
    cardRevision: str
    cardDigest: str
    rubricRevision: str
    rubricDigest: str
    roleLenses: list[InterviewRoleLens]
    responsibilityTags: list[str]
    competencyTags: list[str]
    answerFormats: list[InterviewAnswerFormat]
    defaultAnswerFormat: InterviewAnswerFormat
    attributionKind: Literal["direct_interview_guidance", "practice_extrapolation", "editorial_synthesis"]
    sourceRef: str
    variants: str
    intent: str
    answer: str
    adaptation: str
    alternatives: str
    probes: str
    failures: str
    provenance: str
    rubric: list[dict[str, str]]
    sources: list[str]
    examples: list[dict[str, str]]


class InterviewCatalog(TypedDict):
    schemaVersion: Literal["1"]
    catalogRevision: str
    catalogDigest: str
    maturity: Literal["research_draft"]
    reviewedAt: str
    sourcePacketDigest: str
    sourceFiles: list[dict[str, str]]
    topics: list[dict[str, Any]]
    questions: list[InterviewQuestionCard]
    retiredQuestions: list[dict[str, Any]]
    sources: list[dict[str, Any]]
    authors: list[dict[str, Any]]
    relationships: list[dict[str, str]]
    guidance: dict[str, str]


class InterviewEvidenceExcerpt(TypedDict):
    evidenceId: str
    sourceRef: str
    excerpt: str
    scope: Literal["direct", "transferable"]


class InterviewSelectedQuestion(TypedDict):
    questionId: str
    cardRevision: str
    cardDigest: str
    rubricRevision: str
    rubricDigest: str
    answerFormat: InterviewAnswerFormat
    selectionRationale: str
    snapshot: InterviewQuestionCard


class InterviewProfileContext(TypedDict):
    profileId: str
    version: int
    evidence: list[InterviewEvidenceExcerpt]


class InterviewJobContext(TypedDict):
    jobId: str
    title: str
    company: str
    descriptionExcerpt: str
    snapshotHash: str


class InterviewRequirementExcerpt(TypedDict):
    requirementId: str
    requirementText: str
    sourceExcerpt: str


class InterviewEmployerSnapshot(TypedDict):
    roleFraming: str
    inferredSeniority: str
    requirements: list[InterviewRequirementExcerpt]


class InterviewEmployerContext(TypedDict):
    generation: int
    snapshotHash: str
    snapshot: InterviewEmployerSnapshot


class InterviewFitContext(TypedDict):
    generation: int
    employerAnalysisGeneration: int
    profileSnapshotVersion: int
    status: Literal["current", "stale_excluded"]


class InterviewApprovedMaterialRef(TypedDict):
    materialId: str
    generation: int
    sha256: str


class InterviewModelContext(TypedDict):
    model: str
    promptVersion: str
    gateVersion: str


class InterviewGenerationContext(TypedDict):
    schemaVersion: Literal["1"]
    catalogBinding: InterviewCatalogBinding
    contextDigest: str
    selectedQuestionIds: list[str]
    selectedQuestions: list[InterviewSelectedQuestion]
    selectionMode: Literal["user_selected", "deterministic"]
    interviewStage: InterviewStage
    interviewFormat: InterviewFormat
    roleLens: InterviewRoleLens
    roleResponsibilities: list[str]
    knownCriteria: list[str]
    profile: InterviewProfileContext
    jobContext: InterviewJobContext
    employerAnalysis: InterviewEmployerContext | None
    fitReport: InterviewFitContext | None
    approvedMaterials: list[InterviewApprovedMaterialRef]
    model: InterviewModelContext


class InterviewQuestionMetadata(TypedDict):
    questionId: str
    cardRevision: str
    cardDigest: str
    rubricRevision: str
    rubricDigest: str
    answerFormat: InterviewAnswerFormat
    selectionRationale: str
    evidenceLinks: list[InterviewEvidenceExcerpt]
    outline: list[dict[str, Any]]
    gaps: list[dict[str, str]]
    probes: list[str]
    sourceGuidanceRefs: list[str]
    factualSupport: Literal["accepted_profile_fact", "hypothetical", "new_user_statement", "needs_clarification"]
    userEditStatus: Literal["generated", "user_edited"]


class InterviewSelectionInput(TypedDict):
    selectedQuestionIds: NotRequired[list[str]]
    catalogBinding: NotRequired[InterviewCatalogBinding]
    interviewStage: NotRequired[InterviewStage]
    interviewFormat: NotRequired[InterviewFormat]
    roleLens: NotRequired[InterviewRoleLens]
    roleResponsibilities: NotRequired[list[str]]
    knownCriteria: NotRequired[list[str]]
    selectionRationale: NotRequired[str]


class InterviewSelectionError(ValueError):
    def __init__(self, code: str, question_id: str | None = None) -> None:
        self.code = code
        self.question_id = question_id
        super().__init__(code if question_id is None else f"{code}: {question_id}")


def canonical_json_digest(value: Any) -> str:
    """Shared digest convention: sorted keys, UTF-8, compact JSON, no ASCII escaping."""
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def load_interview_catalog_bytes() -> bytes:
    """Fail closed if the package asset is absent; never look in docs or a plugin."""
    return files("jobctrl").joinpath("assets", "interview", CATALOG_RESOURCE_NAME).read_bytes()


def catalog_raw_digest() -> str:
    return hashlib.sha256(load_interview_catalog_bytes()).hexdigest()


def load_interview_catalog() -> InterviewCatalog:
    """Each caller receives its own snapshot; edits cannot mutate another reader."""
    catalog = json.loads(load_interview_catalog_bytes())
    if not isinstance(catalog, dict) or catalog.get("schemaVersion") != "1":
        raise ValueError("unsupported interview catalog schema")
    digest = catalog.get("catalogDigest")
    if canonical_json_digest({key: value for key, value in catalog.items() if key != "catalogDigest"}) != digest:
        raise ValueError("interview catalog digest mismatch")
    return catalog


def get_interview_question(question_id: str, *, catalog: InterviewCatalog | None = None) -> InterviewQuestionCard:
    catalog = load_interview_catalog() if catalog is None else catalog
    if any(card["id"] == question_id for card in catalog["retiredQuestions"]):
        raise InterviewSelectionError("retired_question", question_id)
    for card in catalog["questions"]:
        if card["id"] == question_id:
            return card
    raise InterviewSelectionError("unknown_question", question_id)


def validate_interview_selection(
    selected_question_ids: list[str] | tuple[str, ...],
    *,
    catalog_binding: InterviewCatalogBinding | None = None,
    catalog: InterviewCatalog | None = None,
) -> tuple[InterviewQuestionCard, ...]:
    """Validate before provider/spend admission; preserve the user's selected order."""
    catalog = load_interview_catalog() if catalog is None else catalog
    if not isinstance(selected_question_ids, (list, tuple)) or not selected_question_ids:
        raise InterviewSelectionError("invalid_selection")
    if len(selected_question_ids) > MAX_INTERVIEW_SELECTED_QUESTIONS:
        raise InterviewSelectionError("selection_over_budget")
    if any(not isinstance(question_id, str) for question_id in selected_question_ids):
        raise InterviewSelectionError("invalid_selection")
    if len(set(selected_question_ids)) != len(selected_question_ids):
        raise InterviewSelectionError("duplicate_question")
    expected = {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}
    if catalog_binding is not None and catalog_binding != expected:
        raise InterviewSelectionError("catalog_mismatch")
    return tuple(get_interview_question(question_id, catalog=catalog) for question_id in selected_question_ids)
