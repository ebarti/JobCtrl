"""Bounded selection and evidence planning before interview prose is generated."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

from jobctrl.domain.interview.catalog import (
    INTERVIEW_FORMATS,
    INTERVIEW_ROLE_LENSES,
    INTERVIEW_STAGES,
    InterviewCatalog,
    InterviewQuestionCard,
    InterviewSelectionError,
    canonical_json_digest,
    validate_interview_selection,
)
from jobctrl.domain.materials.analysis import compute_snapshot_hash
from jobctrl.domain.materials.analyze_use_case import build_jd_snapshot
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.interview.evidence import InterviewEvidenceSnapshot

PROMPT_VERSION = "interview-questions-v4"
GATE_VERSION = "interview-question-grounding-v14"
MAX_PROMPT_CONTEXT_CHARS = 110_000
DEFAULT_QUESTION_COUNT = 5
_SELECTION_KEYS = frozenset({"selectedQuestionIds", "catalogBinding", "interviewStage", "interviewFormat",
                             "roleLens", "roleResponsibilities", "knownCriteria", "selectionRationale",
                             "evidenceSelections", "evidenceProfileVersion"})
_WORDS = re.compile(r"[a-z][a-z0-9+#.-]{2,}", re.IGNORECASE)
_STOP_WORDS = frozenset({"the", "and", "with", "from", "this", "that", "your", "what", "how", "for", "you", "our"})


def selection_from_rpc(params: Mapping[str, Any]) -> dict[str, Any]:
    return normalize_selection({key: params[key] for key in _SELECTION_KEYS if key in params})


def normalize_selection(value: Mapping[str, Any] | None) -> dict[str, Any]:
    """Mirror wire bounds without performing resource I/O in workflow replay."""
    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) - _SELECTION_KEYS:
        raise InterviewSelectionError("invalid_selection")
    result = deepcopy(dict(value))
    for key, choices in (("interviewStage", INTERVIEW_STAGES),
                         ("interviewFormat", INTERVIEW_FORMATS), ("roleLens", INTERVIEW_ROLE_LENSES)):
        if key in result and result[key] not in choices:
            raise InterviewSelectionError("invalid_selection")
    for key, max_length in (("roleResponsibilities", 160), ("knownCriteria", 1000)):
        if key in result:
            rows = result[key]
            if (not isinstance(rows, (list, tuple)) or len(rows) > 20
                    or any(not isinstance(row, str) or not row.strip() or len(row.strip()) > max_length for row in rows)):
                raise InterviewSelectionError("invalid_selection")
            result[key] = [row.strip() for row in rows]
    if "selectionRationale" in result:
        text = result["selectionRationale"]
        if not isinstance(text, str) or len(text.strip()) > 2000:
            raise InterviewSelectionError("invalid_selection")
        result["selectionRationale"] = text.strip()
    if "catalogBinding" in result:
        binding = result["catalogBinding"]
        if (not isinstance(binding, dict) or set(binding) != {"catalogRevision", "catalogDigest"}
                or not isinstance(binding["catalogRevision"], str)
                or not 1 <= len(binding["catalogRevision"].strip()) <= 100
                or not isinstance(binding["catalogDigest"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", binding["catalogDigest"])):
            raise InterviewSelectionError("catalog_mismatch")
    if "selectedQuestionIds" in result:
        ids = result["selectedQuestionIds"]
        if not isinstance(ids, (list, tuple)) or not ids:
            raise InterviewSelectionError("invalid_selection")
        if len(ids) > 16:
            raise InterviewSelectionError("selection_over_budget")
        if any(not isinstance(question_id, str) or len(question_id) > 12 or not re.fullmatch(r"[A-Z]+\d{2}", question_id) for question_id in ids):
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
        if ("evidenceProfileVersion" not in result or not isinstance(rows, (list, tuple))
                or len(rows) > 16):
            raise InterviewSelectionError("invalid_evidence_selection")
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, Mapping) or set(row) != {"questionId", "evidenceIds"}:
                raise InterviewSelectionError("invalid_evidence_selection")
            question_id, evidence_ids = row["questionId"], row["evidenceIds"]
            if (not isinstance(question_id, str) or len(question_id) > 12 or not re.fullmatch(r"[A-Z]+\d{2}", question_id)
                    or question_id in seen or not isinstance(evidence_ids, (list, tuple))
                    or len(evidence_ids) > 8
                    or any(not isinstance(item, str) or not item.strip() or len(item) > 200 for item in evidence_ids)):
                raise InterviewSelectionError("invalid_evidence_selection")
            ids = list(evidence_ids)
            if len(set(ids)) != len(ids) or ("selectedQuestionIds" in result and question_id not in result["selectedQuestionIds"]):
                raise InterviewSelectionError("invalid_evidence_selection", question_id)
            seen.add(question_id)
            row["evidenceIds"] = ids
        result["evidenceSelections"] = list(rows)
    return result


def choose_questions(
    catalog: InterviewCatalog, selection: Mapping[str, Any] | None,
    requirements: Sequence[Mapping[str, Any]],
) -> tuple[tuple[InterviewQuestionCard, ...], dict[str, Any]]:
    context = normalize_selection(selection)
    binding = {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}
    if context.get("catalogBinding") is not None and context["catalogBinding"] != binding:
        raise InterviewSelectionError("catalog_mismatch")
    context.setdefault("interviewStage", "unknown")
    context.setdefault("interviewFormat", "unspecified")
    context.setdefault("roleLens", "unknown")
    context.setdefault("roleResponsibilities", [])
    context.setdefault("knownCriteria", [])
    if "selectedQuestionIds" in context:
        cards = validate_interview_selection(context["selectedQuestionIds"], catalog_binding=context.get("catalogBinding"), catalog=catalog)
        context["selectionMode"] = "user_selected"
    else:
        target_words = words(" ".join([*context["roleResponsibilities"], *context["knownCriteria"],
                                       *(str(row.get("requirementText") or "") for row in requirements)]))
        stage_formats = {
            "recruiter": ["narrative", "negotiation", "preference"],
            "behavioral": ["historical"], "management": ["historical", "situational"],
            "technical": ["principle", "situational", "historical"], "executive": ["principle", "historical"],
        }.get(context["interviewStage"], ["narrative", "historical", "principle", "situational", "preference", "negotiation"])
        eligible = [card for card in catalog["questions"] if context["roleLens"] == "unknown" or context["roleLens"] in card["roleLenses"]]
        if context["interviewStage"] == "recruiter":
            preferred = [card for card in eligible if card["defaultAnswerFormat"] in stage_formats]
            if preferred:
                eligible = preferred
        if not eligible:
            raise InterviewSelectionError("invalid_selection")
        def rank(card: InterviewQuestionCard) -> tuple[int, int, str]:
            tags = words(" ".join([*card["responsibilityTags"], *card["competencyTags"]]))
            format_rank = stage_formats.index(card["defaultAnswerFormat"]) if card["defaultAnswerFormat"] in stage_formats else len(stage_formats)
            return ((format_rank, -len(tags & target_words), card["id"]) if context["interviewStage"] == "recruiter"
                    else (-len(tags & target_words), format_rank, card["id"]))
        eligible.sort(key=rank)
        cards_list: list[InterviewQuestionCard] = []
        topics: set[str] = set()
        for card in eligible:
            if card["topic"] not in topics:
                cards_list.append(card)
                topics.add(card["topic"])
            if len(cards_list) == DEFAULT_QUESTION_COUNT:
                break
        for card in eligible:
            if len(cards_list) == DEFAULT_QUESTION_COUNT:
                break
            if card not in cards_list:
                cards_list.append(card)
        cards = tuple(cards_list)
        context["selectedQuestionIds"] = [card["id"] for card in cards]
        context["selectionMode"] = "deterministic"
    context["catalogBinding"] = binding
    return cards, context


def plan_evidence(
    cards: tuple[InterviewQuestionCard, ...], profile_snapshot: ProfileSnapshot,
    selection: Mapping[str, Any], requirements: Sequence[Mapping[str, Any]],
    *, canonical_evidence: InterviewEvidenceSnapshot | None = None,
) -> dict[str, list[dict[str, str]]]:
    """Select canonical excerpts deterministically; projections are hints, never facts."""
    if canonical_evidence is not None and (
        canonical_evidence.tenant_id != profile_snapshot.tenant_id
        or canonical_evidence.profile_id != profile_snapshot.profile_id
        or canonical_evidence.profile_version != profile_snapshot.version
    ):
        raise InterviewSelectionError("evidence_profile_changed")
    sources = accepted_evidence_sources(canonical_evidence)
    overrides = {row["questionId"]: row["evidenceIds"] for row in selection.get("evidenceSelections", ())}
    if "evidenceSelections" in selection and selection["evidenceProfileVersion"] != profile_snapshot.version:
        raise InterviewSelectionError("evidence_profile_changed")
    if set(overrides) - {card["id"] for card in cards}:
        raise InterviewSelectionError("invalid_evidence_selection")
    by_id = {source["id"]: source for source in sources}
    for question_id, ids in overrides.items():
        if any(evidence_id not in by_id for evidence_id in ids):
            raise InterviewSelectionError("invalid_evidence_selection", question_id)
    plans: dict[str, list[dict[str, str]]] = {}
    for card in cards:
        card_words = words(" ".join([*card["responsibilityTags"], *card["competencyTags"], card["intent"]]))
        relevant_requirements = [requirement for requirement in requirements
                                 if words(str(requirement.get("requirementText") or "")) & card_words]
        hinted_ids = {str(evidence_id) for requirement in relevant_requirements for evidence_id in requirement.get("evidenceIds") or ()}
        explicit = card["id"] in overrides
        ranked = ([by_id[evidence_id] for evidence_id in overrides[card["id"]]] if explicit else
                  sorted(sources, key=lambda source: (
                      -int(source["id"] in hinted_ids),
                      -len(words(source["excerpt"] + " " + " ".join(str(tag) for tag in source["tags"])) & card_words), source["id"],
                  )))
        links: list[dict[str, str]] = []
        for source in ranked:
            overlap = words(source["excerpt"] + " " + " ".join(str(tag) for tag in source["tags"])) & card_words
            if not explicit and not overlap and source["id"] not in hinted_ids:
                continue
            scope = "transferable" if selection["roleLens"] == "first_time_manager" else "direct"
            if selection["roleLens"] in {"engineering_manager", "director", "executive"}:
                authority = re.search(r"(?i)\b(hired|direct reports|performance reviews?|budget owner)\b", source["excerpt"])
                if not authority:
                    scope = "transferable"
            links.append({"evidenceId": source["id"], "sourceRef": f"profile:{profile_snapshot.profile_id}:{profile_snapshot.version}:evidence:{source['id']}",
                          "excerpt": source["excerpt"], "scope": scope})
            if not explicit and len(links) == 3:
                break
        plans[card["id"]] = links
    return plans


def accepted_evidence_sources(canonical_evidence: InterviewEvidenceSnapshot | None) -> list[dict[str, Any]]:
    """Current canonical accepted facts; IDs are exact saved IDs, without aliases.

    The canonical input reader supplies raw accepted rows. Profile display
    reconciliation, legacy bullets and independent notes are never authority.
    """
    return [{"id": source.evidence_id, "excerpt": source.excerpt, "tags": source.tags}
            for source in canonical_evidence.sources] if canonical_evidence is not None else []


def generation_context(
    *, cards: tuple[InterviewQuestionCard, ...], selection: Mapping[str, Any],
    plans: Mapping[str, list[dict[str, str]]], profile_snapshot: ProfileSnapshot,
    accepted_materials: Sequence[Mapping[str, Any]], model: str, job: Mapping[str, Any],
    employer_context: Mapping[str, Any] | None, fit_context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    evidence = {link["evidenceId"]: link for links in plans.values() for link in links}
    explicit_questions = {row["questionId"] for row in selection.get("evidenceSelections", ())}
    selected = [{"questionId": card["id"], "cardRevision": card["cardRevision"], "cardDigest": card["cardDigest"],
                 "rubricRevision": card["rubricRevision"], "rubricDigest": card["rubricDigest"],
                 "answerFormat": card["defaultAnswerFormat"], "selectionRationale": rationale(card, selection),
                 "snapshot": deepcopy(card),
                 "evidenceSelectionMode": "user_selected" if card["id"] in explicit_questions else "deterministic",
                 "selectedEvidenceIds": [link["evidenceId"] for link in plans[card["id"]]]} for card in cards]
    materials: dict[tuple[str, int], list[Mapping[str, Any]]] = {}
    for material in accepted_materials:
        if "materialSha256" not in material:
            continue
        key = (str(material["artifactId"]), int(material["generation"]))
        materials.setdefault(key, []).append(material)
    context = {
        "schemaVersion": "1", "catalogBinding": deepcopy(selection["catalogBinding"]),
        "selectedQuestionIds": list(selection["selectedQuestionIds"]), "selectedQuestions": selected,
        "selectionMode": selection["selectionMode"], "interviewStage": selection["interviewStage"],
        "interviewFormat": selection["interviewFormat"], "roleLens": selection["roleLens"],
        "roleResponsibilities": list(selection["roleResponsibilities"]), "knownCriteria": list(selection["knownCriteria"]),
        "profile": {"profileId": profile_snapshot.profile_id, "version": profile_snapshot.version, "evidence": list(evidence.values())},
        "jobContext": job_context_snapshot(job),
        "employerAnalysis": ({"generation": employer_context["generation"], "snapshotHash": employer_context["snapshotHash"],
                              "snapshot": {"roleFraming": employer_context["roleFraming"], "inferredSeniority": employer_context["inferredSeniority"],
                                           "requirements": [{key: str(row.get(key) or "") for key in ("requirementId", "requirementText", "sourceExcerpt")}
                                                            for row in employer_context["requirements"]]}}
                             if employer_context else None),
        "fitReport": ({"generation": fit_context["scoreVersion"], "employerAnalysisGeneration": fit_context["employerAnalysisGeneration"],
                       "profileSnapshotVersion": fit_context["profileSnapshotVersion"], "status": fit_context["status"]}
                      if fit_context else None),
        "approvedMaterials": [{"materialId": artifact_id, "generation": generation, "sha256": str(rows[0]["materialSha256"])}
                              for (artifact_id, generation), rows in materials.items()],
        "model": {"model": model, "promptVersion": PROMPT_VERSION, "gateVersion": GATE_VERSION},
    }
    context["contextDigest"] = canonical_json_digest(context)
    return context


def rationale(card: InterviewQuestionCard, selection: Mapping[str, Any]) -> str:
    if selection["selectionMode"] == "user_selected":
        return str(selection.get("selectionRationale") or "Selected by the user for this preparation.")
    return (f"Deterministic suggestion for {selection['roleLens']} responsibilities and {selection['interviewStage']} stage; "
            f"covers {', '.join(card['responsibilityTags'])}. Employer question occurrence is unknown.")


def words(text: str) -> set[str]:
    return {word.lower() for word in _WORDS.findall(text)} - _STOP_WORDS


def job_context_snapshot(job: Mapping[str, Any]) -> dict[str, str]:
    title = str(job.get("title") or "").strip()
    company = str(job.get("company") or job.get("employer") or "").strip()
    if len(title) > 500 or len(company) > 500:
        raise ValueError("job title/company exceeds preparation budget")
    return {"jobId": str(job["job_id"]), "title": title, "company": company,
            "descriptionExcerpt": str(job.get("full_description") or job.get("description") or "").strip()[:12000],
            "snapshotHash": compute_snapshot_hash(build_jd_snapshot(dict(job)))}
