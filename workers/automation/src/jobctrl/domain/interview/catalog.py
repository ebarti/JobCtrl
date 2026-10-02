"""Versioned public interview guidance, loaded identically in source and installed workers.

Wire keys intentionally match the pure TypeScript vocabulary. This module owns
no personal facts, provider calls, SQLite state, or runtime Markdown inference.
"""

from __future__ import annotations

import hashlib
import json
import re
from importlib.resources import files
from typing import Any, Literal, NotRequired, TypedDict

InterviewAnswerFormat = Literal["historical", "situational", "principle", "negotiation", "narrative", "preference"]
InterviewRoleLens = Literal["ic", "senior_ic", "staff_principal", "first_time_manager", "engineering_manager", "director", "executive", "unknown"]
InterviewStage = Literal["recruiter", "behavioral", "management", "technical", "executive", "mixed", "unknown"]
InterviewFormat = Literal["phone", "video", "onsite", "written", "unspecified"]
InterviewSelectionErrorCode = Literal[
    "unknown_question", "retired_question", "duplicate_question", "selection_over_budget",
    "catalog_mismatch", "invalid_selection", "evidence_profile_changed", "invalid_evidence_selection",
]
INTERVIEW_SELECTION_ERROR_CODES = (
    "unknown_question", "retired_question", "duplicate_question", "selection_over_budget",
    "catalog_mismatch", "invalid_selection", "evidence_profile_changed", "invalid_evidence_selection",
)
INTERVIEW_ANSWER_FORMATS = ("historical", "situational", "principle", "negotiation", "narrative", "preference")
INTERVIEW_ROLE_LENSES = ("ic", "senior_ic", "staff_principal", "first_time_manager", "engineering_manager", "director", "executive", "unknown")
INTERVIEW_STAGES = ("recruiter", "behavioral", "management", "technical", "executive", "mixed", "unknown")
INTERVIEW_FORMATS = ("phone", "video", "onsite", "written", "unspecified")
MAX_INTERVIEW_SELECTED_QUESTIONS = 16
MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION = 8
MAX_INTERVIEW_NOTE_TEXT_LENGTH = 20_000
CATALOG_RESOURCE_NAME = "catalog.v1.json"
MAX_CATALOG_BYTES = 2_000_000


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
    evidenceSelectionMode: Literal["user_selected", "deterministic"]
    selectedEvidenceIds: list[str]


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


class InterviewEvidenceSelection(TypedDict):
    questionId: str
    evidenceIds: list[str]


class InterviewSelectionInput(TypedDict):
    selectedQuestionIds: NotRequired[list[str]]
    catalogBinding: NotRequired[InterviewCatalogBinding]
    evidenceSelections: NotRequired[list[InterviewEvidenceSelection]]
    evidenceProfileVersion: NotRequired[int]
    interviewStage: NotRequired[InterviewStage]
    interviewFormat: NotRequired[InterviewFormat]
    roleLens: NotRequired[InterviewRoleLens]
    roleResponsibilities: NotRequired[list[str]]
    knownCriteria: NotRequired[list[str]]
    selectionRationale: NotRequired[str]


class InterviewNoteBindings(TypedDict):
    catalogBinding: NotRequired[InterviewCatalogBinding | None]
    cardRevision: NotRequired[str | None]
    cardDigest: NotRequired[str | None]
    contextDigest: NotRequired[str | None]


class InterviewQuestionNote(TypedDict):
    jobId: str
    questionId: str
    revision: int
    noteText: str
    factualSupport: Literal["supported", "unverified_user_statement", "needs_clarification", "hypothetical"]
    editStatus: Literal["user_edited"]
    sourceGeneration: int | None
    bindings: InterviewNoteBindings | None
    updatedAt: str


class SaveInterviewQuestionNoteRequest(TypedDict):
    questionId: str
    expectedRevision: int
    noteText: str
    factualSupport: NotRequired[Literal["unverified_user_statement", "needs_clarification", "hypothetical"]]
    sourceGeneration: NotRequired[int | None]
    bindings: NotRequired[InterviewNoteBindings | None]


class InterviewSelectionError(ValueError):
    def __init__(self, code: InterviewSelectionErrorCode, question_id: str | None = None) -> None:
        self.code = code
        self.question_id = question_id
        super().__init__(code if question_id is None else f"{code}: {question_id}")


def canonical_json_digest(value: Any) -> str:
    """Shared digest convention: sorted keys, UTF-8, compact JSON, no ASCII escaping."""
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def load_interview_catalog_bytes() -> bytes:
    """Fail closed if the package asset is absent; never look in docs or a plugin."""
    with files("jobctrl").joinpath("assets", "interview", CATALOG_RESOURCE_NAME).open("rb") as reader:
        raw = reader.read(MAX_CATALOG_BYTES + 1)
    if len(raw) > MAX_CATALOG_BYTES:
        raise ValueError("interview catalog exceeds the resource budget")
    return raw


def catalog_raw_digest() -> str:
    return hashlib.sha256(load_interview_catalog_bytes()).hexdigest()


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate interview catalog JSON key: {key}")
        result[key] = value
    return result


def parse_interview_catalog(raw: bytes) -> InterviewCatalog:
    """Validate the public asset before consumers use it for selection or snapshots."""
    if len(raw) > MAX_CATALOG_BYTES:
        raise ValueError("interview catalog exceeds the resource budget")
    catalog = json.loads(raw, object_pairs_hook=_unique_json_object)
    if not isinstance(catalog, dict) or catalog.get("schemaVersion") != "1":
        raise ValueError("unsupported interview catalog schema")
    digest = catalog.get("catalogDigest")
    if canonical_json_digest({key: value for key, value in catalog.items() if key != "catalogDigest"}) != digest:
        raise ValueError("interview catalog digest mismatch")
    if set(catalog) != set(InterviewCatalog.__required_keys__):
        raise ValueError("invalid interview catalog fields")
    if catalog["catalogRevision"] != "2026-10-01.1" or catalog["maturity"] != "research_draft":
        raise ValueError("unsupported interview catalog revision or maturity")
    collections = ("questions", "topics", "sources", "authors", "retiredQuestions", "sourceFiles", "relationships")
    if any(not isinstance(catalog[key], list) for key in collections):
        raise ValueError("invalid interview catalog collections")
    if tuple(len(catalog[key]) for key in collections) != (121, 15, 57, 20, 1, 21, 31):
        raise ValueError("incomplete interview catalog inventory")
    ids_by_collection = {}
    for key in ("questions", "topics", "sources", "authors", "retiredQuestions"):
        ids = [row.get("id") for row in catalog[key] if isinstance(row, dict)]
        if len(ids) != len(catalog[key]) or any(not isinstance(value, str) for value in ids) or len(ids) != len(set(ids)):
            raise ValueError(f"invalid/duplicate interview {key} IDs")
        ids_by_collection[key] = set(ids)
    question_ids = ids_by_collection["questions"]
    if ids_by_collection["retiredQuestions"] != {"C08"} or "C08" in question_ids:
        raise ValueError("C08 must remain reserved-retired")
    for card in catalog["questions"]:
        if set(card) != set(InterviewQuestionCard.__required_keys__) or card["status"] != "active" or card["maturity"] != "research_draft":
            raise ValueError("invalid interview question fields/status/maturity")
        if not re.fullmatch(r"[A-Z]+\d{2}", card["id"]):
            raise ValueError("invalid interview question ID")
        for key, vocabulary in (("roleLenses", INTERVIEW_ROLE_LENSES), ("answerFormats", INTERVIEW_ANSWER_FORMATS)):
            values = card[key]
            if not isinstance(values, list) or not values or any(value not in vocabulary for value in values) or len(values) != len(set(values)):
                raise ValueError(f"invalid interview question {key}")
        if card["defaultAnswerFormat"] not in card["answerFormats"]:
            raise ValueError("interview question default format is not supported")
        for key in ("responsibilityTags", "competencyTags"):
            values = card[key]
            if not isinstance(values, list) or not values or any(not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", value) for value in values):
                raise ValueError(f"invalid interview question {key}")
        if card["topic"] not in ids_by_collection["topics"] or not set(card["sources"]) <= ids_by_collection["sources"]:
            raise ValueError("dangling interview question topic/source")
        if canonical_json_digest(card["rubric"]) != card["rubricDigest"]:
            raise ValueError("interview rubric digest mismatch")
        if canonical_json_digest({key: value for key, value in card.items() if key != "cardDigest"}) != card["cardDigest"]:
            raise ValueError("interview card digest mismatch")
    for topic in catalog["topics"]:
        expected_ids = [card["id"] for card in catalog["questions"] if card["topic"] == topic["id"]]
        if topic["questionIds"] != expected_ids:
            raise ValueError("interview topic membership mismatch")
    for source in catalog["sources"]:
        if source["authorId"] not in ids_by_collection["authors"] or not source["readingCoverage"]:
            raise ValueError("interview source attribution/reading coverage missing")
        expected_ids = [card["id"] for card in catalog["questions"] if source["id"] in card["sources"]]
        if source["questionIds"] != expected_ids:
            raise ValueError("interview source citation membership mismatch")
    for author in catalog["authors"]:
        expected_ids = [source["id"] for source in catalog["sources"] if source["authorId"] == author["id"]]
        if author["sourceIds"] != expected_ids:
            raise ValueError("interview author/source membership mismatch")
    for edge in catalog["relationships"]:
        if edge["kind"] != "editorial_related" or edge["fromQuestionId"] not in question_ids or edge["toQuestionId"] not in question_ids:
            raise ValueError("dangling interview editorial relationship")
    by_id = {card["id"]: card for card in catalog["questions"]}
    if any(by_id[key]["defaultAnswerFormat"] != "principle" for key in ("B11", "TS09")):
        raise ValueError("decision quality questions require principle format")
    if "budgeted range" not in by_id["C07"]["answer"].lower() or "persist" not in by_id["C07"]["answer"].lower():
        raise ValueError("C07 requires persistent employer-range-first guidance")
    return catalog


def load_interview_catalog() -> InterviewCatalog:
    """Each caller receives its own snapshot; edits cannot mutate another reader."""
    return parse_interview_catalog(load_interview_catalog_bytes())


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
