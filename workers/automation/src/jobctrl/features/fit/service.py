"""Canonical Fit application actions shared by HTTP, CLI and durable execution."""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timezone
from typing import Callable
import unicodedata
from uuid import uuid4

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.model_custody import current_owner, model_call_scope
from jobctrl.features.requirements import job_demand_fingerprints

from .contract import (CONTRACT_VERSION, assessment_fields, current_contract, current_qualification,
                       qualification_key, require_contract, require_demand, reusable)
from .coverage import Coverage, variant_fingerprint
from .domain import FORMULA_VERSION, calculate_score, fit_band
from .models import (QualificationDecision, QUALIFICATION_PROMPT_VERSION, QUALIFICATION_SEMANTICS_VERSION,
                     WORDING_GROUP_VERSION, WORDING_PROMPT_VERSION)
from .ports import FitStorePort, ModelPort, ProfilePort, RequirementsPort, SettingsPort
from .qualification import Qualification, now
from .refresh import ManualRefresh
from .library import requirement_library
from .current_wording import assignment_view
from .sources import (
    achievements, approved_fingerprint, dto, fact_fingerprint, fact_sources, fingerprint, requirement_source,
    job_fingerprint, qualification_fingerprint, semantic_sources, wording_eligible,
)
from .cohort import InitialCohortService


def unique_requirements(snapshot: dict) -> list[dict]:
    """Count each canonical meaning or distinct direct demand once."""
    from jobctrl.features.requirements import snapshot_items
    require_contract(snapshot)
    if snapshot.get("status") != "complete":
        raise AppError("unsupported_posting_language", "Fit is unavailable for this posting language. The posting is skipped without a replacement score.", 409)
    rows: dict[str, dict] = {}
    for occurrence in snapshot_items(snapshot):
        required = ("requirement_id", "requirement_revision", "definition", "category", "name")
        if any(key not in occurrence for key in required):
            raise AppError("fit_requirement_snapshot_invalid", "Fit requires typed source-bound requirement identities.", 409)
        row = deepcopy(occurrence)
        require_demand(row)
        ident = row["requirement_id"]
        if ident in rows:
            previous = rows[ident]
            if any(previous.get(key) != row.get(key) for key in ("requirement_revision", "definition", "category", "name",
                                                                "capability_definition", "demand_fingerprint", "normalization_version")):
                raise AppError("fit_requirement_snapshot_invalid", "A canonical requirement has conflicting definitions.", 409)
            previous["occurrence_ids"].append(row["occurrence_id"])
        else:
            row["occurrence_ids"] = [row["occurrence_id"]]
            rows[ident] = row
    return list(rows.values())


def scored_demands(score):
    if not current_contract(score) or score.get("formula_version") != FORMULA_VERSION:
        return None
    if any(not current_qualification(row) for row in score["assessments"]):
        return None
    binding = score["source_binding"]
    return {"revision": binding["requirements_revision"], "posting_hash": binding["posting_hash"],
            "job_demands": job_demand_fingerprints(score["assessments"])}


def score_stale_reasons(score, profile, guidance_fingerprint, requirements, scored):
    if not current_contract(score) or score.get("formula_version") != FORMULA_VERSION:
        return ["contract_changed"]
    if requirements is None or not requirements["posting_available"] or profile is None:
        return ["source_unavailable"]
    if requirements["status"] == "unsupported_language":
        return ["unsupported_posting_language"]
    if requirements["job_demands"] is None:
        return ["requirements_consolidation_required"]

    binding, assessments = score["source_binding"], score["assessments"]
    reasons = []
    semantics_changed = scored is None
    if semantics_changed:
        reasons.append("qualification_semantics_changed")
    if guidance_fingerprint != binding["scoring_guidance_fingerprint"]:
        reasons.append("scoring_guidance_changed")
    elif not semantics_changed and job_fingerprint(profile, assessments) != binding["source_fingerprint"]:
        # Use the score's original criteria to test only a change in evidence.
        reasons.append("profile_facts_changed")
    if scored is not None and scored["job_demands"] != requirements["job_demands"] and not requirements["regrouped"]:
        reasons.append("requirements_changed")
    return reasons


class FitService(InitialCohortService):
    def __init__(self, *, store: FitStorePort, model: ModelPort, profile: ProfilePort,
                 requirements: RequirementsPort, settings: SettingsPort | None = None):
        self.store, self.model = store, model
        self.profile, self.requirements, self.settings = profile, requirements, settings
        self.qualification = Qualification(model=model, store=store)
        self.coverage = Coverage(model=model, profile=profile, store=store, qualification=self.qualification)
        self.manual_refresh = ManualRefresh(self)

    @staticmethod
    def authority_version():
        """Public durable-action authority; consumers never import private prompts."""
        return CONTRACT_VERSION + ":" + fingerprint({
            "qualification_semantics": QUALIFICATION_SEMANTICS_VERSION,
            "qualification_prompt": QUALIFICATION_PROMPT_VERSION,
            "wording_prompt": WORDING_PROMPT_VERSION, "wording_group": WORDING_GROUP_VERSION,
        })

    def requirement_library(self, profile_id="default"):
        return requirement_library(self.store, profile_id)

    def current_wording_assignments(self, profile_id="default", connection=None):
        with self.store.read_snapshot(connection) as read:
            try:
                profile = dto(read.profile_snapshot(profile_id))
            except NotFoundError:
                profile = None
            return [assignment_view(row, read, profile) for row in read.current_wordings(profile_id)]

    def assert_current_wording_assignments(self, expected, profile_id="default", connection=None):
        current = self.current_wording_assignments(profile_id, connection)
        if fingerprint(expected) != fingerprint(current):
            raise ConflictError("The maintained wording assignments changed.")

    def set_current_wording(self, request):
        return self.store.set_current_wording(request)

    def set_current_wording_state(self, assignment_id, request):
        return self.store.set_current_wording_state(assignment_id, request)

    def current_wording_history(self, assignment_id, profile_id="default", *, limit=50, offset=0):
        return self.store.current_wording_history(assignment_id, profile_id, limit=limit, offset=offset)

    def create_association(self, request):
        return self.store.create_association(request)

    def set_association_state(self, association_id, request):
        return self.store.set_association_state(association_id, request)

    def revise_association(self, association_id, request):
        return self.store.revise_association(association_id, request)

    def association_history(self, association_id, profile_id="default", *, limit=50, offset=0):
        return self.store.association_history(association_id, profile_id, limit=limit, offset=offset)

    def refresh_pending(self, profile_id="default"):
        return self.manual_refresh.pending(profile_id)

    def refresh_operation(self, operation_id, *, allow_pending=False):
        return self.manual_refresh.operation(operation_id, allow_pending=allow_pending)

    async def refresh(self, *, operation_id, cancelled=lambda: False, heartbeat=lambda details: None, **request):
        prepare_coverage = request.get("prepare_coverage", True)
        if type(prepare_coverage) is not bool:
            raise AppError("fit_invalid_option", "Fit options must be booleans.", 422)
        if not prepare_coverage and (request["prepare_wording"] or request.get("retry_wording_proposal_ids")):
            raise AppError("fit_refresh_options_invalid", "Disabling coverage requires prepare_wording=false and no wording retries.", 422)
        if len(request["job_ids"]) != len(set(request["job_ids"])) or any(not value for value in request["job_ids"]):
            raise AppError("fit_refresh_job_scope_invalid", "Select each saved job once.", 422)
        retry_ids = request.get("retry_wording_proposal_ids", [])
        if len(retry_ids) != len(set(retry_ids)) or any(not value for value in retry_ids):
            raise AppError("fit_refresh_retry_invalid", "Select each failed wording proposal once.", 422)
        if retry_ids and (not request["prepare_wording"] or request["job_ids"]):
            raise AppError("fit_refresh_retry_invalid", "An explicit wording retry prepares only the selected proposals; use an empty job selection.", 422)
        return await self.manual_refresh.run(operation_id=operation_id, request=request, cancelled=cancelled, heartbeat=heartbeat)

    def interrupt_refresh(self, operation_id, status, failure_code=None, *, connection=None):
        return self.manual_refresh.interrupt(operation_id, status, failure_code, connection=connection)

    @staticmethod
    def _wording_inventory_current(read, profile, score):
        current = approved_fingerprint(profile)
        if score["source_binding"].get("approved_variants_fingerprint") == current:
            return True
        completed = read.completed_refresh(profile["profile_id"])
        return bool(completed and approved_fingerprint(completed["snapshot"]["profile"]) == current
                    and fact_fingerprint(completed["snapshot"]["profile"]) == fact_fingerprint(profile))

    def _require_manual_refresh(self, read, job_id, profile_id, *, force=False):
        previous = read.latest_score(job_id)
        if previous is None:
            return
        profile = dto(read.profile_snapshot(profile_id))
        current = self._get_job_fit(read, job_id, profile_id, include_coverage=False)
        if (force or not current["current"]
                or not self._wording_inventory_current(read, profile, previous)):
            raise AppError("fit_refresh_required", "Saved inputs changed. Start a manual Fit refresh to update existing assessments.", 409)

    async def assess_job(self, job_id: str, *, expected_revision: int, profile_id="default", force=False,
                         prepare_wording=True, prepare_coverage=True, cancelled: Callable[[], bool] = lambda: False,
                         operation_id: str | None = None) -> dict:
        self._expected_revision(expected_revision)
        if any(type(value) is not bool for value in (force, prepare_wording, prepare_coverage)):
            raise AppError("fit_invalid_option", "Fit options must be booleans.")
        operation_fingerprint = fingerprint({"action": "assess", "job_id": job_id, "profile_id": profile_id,
                                             "contract_version": CONTRACT_VERSION,
                                             "qualification_semantics_version": QUALIFICATION_SEMANTICS_VERSION,
                                             "qualification_prompt_version": QUALIFICATION_PROMPT_VERSION,
                                             "expected_revision": expected_revision, "force": force,
                                             "prepare_wording": prepare_wording, "prepare_coverage": prepare_coverage})
        replay = self._replay_operation(operation_id, operation_fingerprint)
        if replay is not None:
            return replay
        self._check_cancelled(cancelled)
        profile_snapshot = self.qualification.snapshot(profile_id)
        profile = dto(profile_snapshot)
        requirements_snapshot = self.requirements.get_job_requirements(job_id)
        rows = unique_requirements(requirements_snapshot)
        with self.store.read_snapshot() as read:
            read.validate_sources(profile_snapshot, requirements_snapshot)
            self._assert_score_revision(read, job_id, expected_revision)
            self._require_manual_refresh(read, job_id, profile_id, force=force)
            initial_assessment = read.latest_score(job_id) is None
            for requirement in rows:
                source_hash = qualification_fingerprint(profile, requirement)
                previous = read.latest_requirement_assessment(profile_id, requirement["requirement_id"],
                                                               demand_fingerprint=requirement.get("demand_fingerprint"))
                if previous is not None and (force or not initial_assessment and (
                        not current_qualification(previous) or previous["source_fingerprint"] != source_hash
                        or str(previous["requirement_revision"]) != str(requirement["requirement_revision"]))):
                    raise AppError("fit_refresh_required", "Saved inputs changed. Start a manual Fit refresh to update existing assessments.", 409)
        # Direct initial Fit and saved-job Preparation share the same qualification
        # authorities as Search. Keep an existing Search stage's original receipt owner.
        custody = (model_call_scope(f"fit.qualification:{operation_id or uuid4()}", allow_settled_replacement=True)
                   if initial_assessment and current_owner() is None else nullcontext())
        with custody:
            records, reused = await self.qualification.resolve_many(
                profile_snapshot, rows, requirements_snapshot, force=force,
                initial_assessment=initial_assessment, cancelled=cancelled,
            )
        qualifications = []
        for requirement, record in zip(rows, records, strict=True):
            self._check_cancelled(cancelled)
            qualifications.append({**record, **assessment_fields(requirement)})
        self._check_cancelled(cancelled)
        try:
            resolved = calculate_score(qualifications)
        except (ValueError, KeyError, TypeError):
            raise AppError("fit_score_inputs_invalid", "No coherent typed qualification score can be calculated.", 422) from None
        source_binding = {
            "contract_version": CONTRACT_VERSION,
            "profile_id": profile_id, "profile_revision": profile["profile_revision"],
            "fact_semantics_version": profile["fact_semantics_version"],
            "source_fingerprint": job_fingerprint(profile, rows),
            "scoring_guidance_fingerprint": fingerprint(profile_snapshot.scoring_guidance),
            "approved_variants_fingerprint": approved_fingerprint(profile),
            "requirements_revision": requirements_snapshot["revision"],
            "posting_revision": requirements_snapshot["posting_revision"],
            "posting_hash": requirements_snapshot["posting_hash"],
            "assessment_ids": [row["assessment_id"] for row in qualifications],
            "requirements": [{"requirement_id": row["requirement_id"],
                              "requirement_revision": row["requirement_revision"],
                              "demand_fingerprint": row.get("demand_fingerprint")} for row in rows],
        }
        candidate = {**resolved, "job_id": job_id, "revision": expected_revision + 1,
                     "source_binding": source_binding, "created_at": now(), "origin": "model",
                     "correction": None, "policy_version": FORMULA_VERSION}
        accepted = self.store.publish_score(candidate, profile_snapshot, requirements_snapshot,
            expected_revision, qualifications, not force, operation_id, operation_fingerprint, cancelled=cancelled)
        # Expression preparation has separate authority and failure state. A
        # provider failure here never downgrades a successfully qualified person.
        coverage_result = None
        coverage_failure = None
        try:
            if prepare_coverage:
                coverage_result = await self.coverage.refresh(
                    profile_snapshot, requirements_snapshot, [row for row in rows if reusable(row)],
                    prepare_wording=prepare_wording, cancelled=cancelled,
                )
        except asyncio.CancelledError:
            raise
        except AppError as failure:
            coverage_failure = failure.code
        result = self._result_for_score(accepted)
        result["reuse"] = {"reused_qualifications": reused, "assessed_qualifications": len(rows) - reused,
                           "score_reused": accepted["revision"] == expected_revision}
        if coverage_result is not None:
            result["coverage_preparation"] = coverage_result
        elif not prepare_coverage:
            result["coverage_preparation"] = {"status": "not_requested", "assessed_relations": 0,
                                               "reused_relations": 0, "proposals": []}
        if coverage_failure is not None:
            result["coverage_failure_code"] = coverage_failure
            if result["coverage"] is not None:
                result["coverage"]["failure_code"] = coverage_failure
        self.store.complete_operation(operation_id, operation_fingerprint, result)
        return result

    def get_job_fit(self, job_id: str, profile_id="default", connection=None, *, include_coverage=True) -> dict:
        with self.store.read_snapshot(connection) as read:
            return self._get_job_fit(read, job_id, profile_id, include_coverage=include_coverage)

    def _get_job_fit(self, read, job_id, profile_id="default", *, include_coverage=True):
        score = read.latest_score(job_id)
        result = {"contract_version": CONTRACT_VERSION, "job_id": job_id, "current": False,
                  "requirements_current": False, "qualifications_current": False,
                  "stale_reasons": [], "score": score, "coverage": None}
        threshold = read.settings_snapshot().get("minFitScore", 7)
        result["selection"] = {"min_fit_score": threshold, "ready_for_materials": False}
        if score is None:
            return result
        if not current_contract(score) or score.get("formula_version") != FORMULA_VERSION:
            result["stale_reasons"].append("contract_changed")
            return result
        binding = score["source_binding"]
        if binding["profile_id"] != profile_id:
            result["stale_reasons"].append("profile_changed")
            return result
        try:
            profile_snapshot = read.profile_snapshot(profile_id)
        except NotFoundError:
            result["stale_reasons"].append("source_unavailable")
            return result
        profile = dto(profile_snapshot)
        scored = scored_demands(score)
        requirements = read.requirement_bindings([job_id], scored={job_id: scored}).get(job_id)
        reasons = score_stale_reasons(score, profile, fingerprint(profile_snapshot.scoring_guidance), requirements, scored)
        if requirements and not reasons and read.superseded_assessments(binding["assessment_ids"]):
            reasons.append("qualification_changed")
        result["stale_reasons"] = reasons
        result["current"] = not reasons
        result["requirements_current"] = bool(requirements and not requirements["stale"]
                                             and requirements["job_demands"] is not None)
        result["qualifications_current"] = not reasons and not requirements["regrouped"]
        result["selection"]["ready_for_materials"] = (
            result["qualifications_current"] and result["requirements_current"] and score["score"] is not None and score["score"] >= threshold
            and score["eligibility"]["status"] != "blocked"
        )
        if include_coverage and requirements and requirements["posting_available"] and requirements["job_demands"] is not None:
            rows = unique_requirements(read.job_requirements(job_id))
            result["coverage"] = self._coverage_for(read, profile["profile_revision"], [row for row in rows if reusable(row)], profile["approved_variants"],
                                                   profile_id=profile_id)
            if requirements["stale"]:
                coverage = result["coverage"]
                coverage["status"] = "stale"
                coverage["relations"] = [{**relation, "covered": False, "status": "stale"}
                                         for relation in coverage["relations"]]
                coverage.pop("snapshot_id")
                coverage["snapshot_id"] = "fit-coverage-snapshot-" + fingerprint(coverage)
        return result

    def history(self, job_id: str, connection=None) -> dict:
        return {"job_id": job_id, "versions": self.store.history(job_id, connection)}

    def correct_score(self, job_id: str, *, expected_revision: int, score: int, rationale: str,
                      operation_id: str | None = None) -> dict:
        self._expected_revision(expected_revision)
        if type(score) is not int or not 1 <= score <= 10:
            raise AppError("fit_invalid_score", "A corrected Fit score must be an integer from 1 to 10.")
        rationale = self._rationale(rationale)
        operation_fingerprint = fingerprint({"action": "correct", "job_id": job_id,
                                             "contract_version": CONTRACT_VERSION,
                                             "expected_revision": expected_revision, "score": score, "rationale": rationale})
        replay = self._replay_operation(operation_id, operation_fingerprint)
        if replay is not None:
            return replay
        with self.store.read_snapshot() as read:
            previous = self._assert_score_revision(read, job_id, expected_revision)
        if previous is None:
            raise NotFoundError("Assess this job before correcting its Fit score.")
        require_contract(previous)
        if previous["score"] is None:
            raise AppError("fit_score_unavailable", "No demands were assessed, so there is no score to correct.", 409)
        created = now()
        correction = {
            "contract_version": CONTRACT_VERSION,
            "correction_id": "fit-correction-" + fingerprint({
                "job_id": job_id, "previous_revision": expected_revision, "score": score,
                "rationale": rationale, "created_at": created,
            }),
            "job_id": job_id, "score_revision": expected_revision + 1,
            "original_score": previous["score"], "corrected_score": score,
            "rationale": rationale, "actor": "user", "created_at": created,
            "source_policy_version": previous["policy_version"],
        }
        corrected = {**previous, "revision": expected_revision + 1, "score": score,
                     "fit_band": fit_band(score), "correction": correction,
                     "created_at": created, "origin": "manual"}
        self.store.publish_score_correction(corrected, correction, expected_revision,
                                             operation_id, operation_fingerprint)
        result = self._result_for_score(corrected)
        self.store.complete_operation(operation_id, operation_fingerprint, result)
        return result

    def correct_requirement(self, requirement_id: str, *, expected_assessment_id: str,
                            expected_fact_semantics_version: int, requirement_revision: int | str,
                            kind: str, strength: str | None, confidence: str, rationale: str,
                            evidence_refs: list[dict], achievement_ids: list[str],
                            eligibility="unknown", blocker_category=None, warning_category=None,
                            profile_id="default", wording_support=None, evidence_route=None) -> dict:
        """An explicit human source-bound correction, retained separately from model authority."""
        self._rationale(rationale)
        if type(expected_fact_semantics_version) is not int or expected_fact_semantics_version < 1:
            raise AppError("fit_invalid_profile_version", "The reviewed factual Profile version is required.", 428)
        snapshot = self.qualification.snapshot(profile_id)
        profile = dto(snapshot)
        if profile["fact_semantics_version"] != expected_fact_semantics_version:
            raise ConflictError("The factual Profile has changed.")
        requirement = self.requirements.get_requirement(requirement_id)
        canonical_revision = requirement.get("requirement_revision") or requirement["revision"]
        if str(canonical_revision) != str(requirement_revision):
            raise ConflictError("The canonical requirement has changed.")
        requirement = {**requirement, "requirement_revision": canonical_revision}
        reviewed = self.store.assessment(expected_assessment_id)
        demands = self.requirements.demand_catalog_snapshot(active_only=True)
        requirement = next((row for row in demands["demands"] if row["requirement_id"] == requirement_id
                            and str(row["requirement_revision"]) == str(requirement_revision)
                            and reviewed is not None and row["demand_fingerprint"] == reviewed.get("demand_fingerprint")), None)
        if requirement is None:
            raise ConflictError("The reviewed source demand is unavailable or changed. Refresh Fit first.")
        facts = fact_sources(profile)
        source_hash = qualification_fingerprint(profile, requirement, facts)
        previous = self.store.latest_assessment(profile_id, requirement_id, requirement_revision,
                                               source_fingerprint=source_hash)
        if previous is None or previous["assessment_id"] != expected_assessment_id:
            raise ConflictError("The accepted person qualification has changed.")
        index = {source["source_id"]: source for source in facts}
        evidence = []
        for ref in evidence_refs:
            if (not isinstance(ref, dict) or ref.get("source_id") not in index
                    or ref.get("revision") != index[ref["source_id"]]["revision"]):
                raise ConflictError("The selected factual evidence has changed.")
            evidence.append({"source_id": "evidence:" + ref["source_id"], "quote": ref.get("quote")})
        try:
            selected = QualificationDecision.model_validate({
                "requirement_id": requirement_id, "requirement_revision": str(requirement_revision),
                "demand_fingerprint": requirement["demand_fingerprint"],
                "kind": kind, "strength": strength, "confidence": confidence, "rationale": rationale,
                "evidence": evidence,
                "requirement_citations": [{"source_id": "requirement", "quote": requirement_source(requirement)["text"]}],
                "achievement_ids": achievement_ids, "keywords": [], "eligibility": eligibility,
                "wording_support": wording_support if wording_support is not None else (
                    previous["wording_support"] if kind in {"matched", "transferable"} else "none"),
                "evidence_route": evidence_route,
                "blocker_category": blocker_category, "warning_category": warning_category,
            })
        except (ValueError, TypeError):
            raise AppError("fit_invalid_requirement_correction", "The requirement correction is structurally invalid.") from None
        self.qualification.validate(selected, requirement, facts, achievements(profile), semantic_sources(requirement, facts))
        created = now()
        correction_id = "fit-human-determination-" + fingerprint({
            "expected_assessment_id": expected_assessment_id, "selected": selected.model_dump(), "created_at": created,
        })
        record = {**previous, "assessment_id": "fit-assessment-" + fingerprint(correction_id),
                  **{key: getattr(selected, key) for key in (
                      "kind", "strength", "confidence", "rationale", "achievement_ids",
                      "eligibility", "blocker_category", "warning_category",
                      "wording_support", "evidence_route",
                  )}, "evidence_refs": evidence_refs, "determination_id": correction_id,
                  "origin": "manual", "correction_of": previous["assessment_id"],
                  "provenance": {"receipt_id": correction_id, "actor": "user", "created_at": created},
                  "created_at": created}
        for obsolete in ("revalidation_provenance", "revalidation_rationale", "revalidated_from"):
            record.pop(obsolete, None)
        self.store.publish_requirement_correction(record, facts, snapshot, requirement_id,
                                                   requirement_revision, expected_assessment_id)
        return deepcopy(record)

    async def refresh_coverage(self, job_id: str, *, profile_id="default", prepare_wording=True,
                               cancelled=lambda: False) -> dict:
        with self.store.read_snapshot() as read:
            self._require_manual_refresh(read, job_id, profile_id)
        profile_snapshot = self.qualification.snapshot(profile_id)
        requirements_snapshot = self.requirements.get_job_requirements(job_id)
        result = await self.coverage.refresh(profile_snapshot, requirements_snapshot,
                                              [row for row in unique_requirements(requirements_snapshot) if reusable(row)],
                                              prepare_wording=prepare_wording, cancelled=cancelled)
        return {**self.get_job_fit(job_id, profile_id), "coverage_preparation": result}

    def coverage_for(self, profile_revision, requirements, approved_variants, *, profile_id="default",
                     connection=None) -> dict:
        with self.store.read_snapshot(connection) as read:
            return self._coverage_for(read, profile_revision, requirements, approved_variants, profile_id=profile_id)

    def _coverage_for(self, read, profile_revision, requirements, approved_variants, *, profile_id="default"):
        if any(not current_contract(row) for row in requirements):
            raise AppError("contract_changed", "Wording coverage requires the current requirements contract.", 409)
        requirements = [row for row in requirements if reusable(row)]
        profile = dto(read.profile_snapshot(profile_id))
        source_hash = fact_fingerprint(profile)
        variants = {row["variant_id"]: row for row in profile["approved_variants"]}
        requirement_ids = sorted({row["requirement_id"] for row in requirements})
        achievement_ids = sorted({row["achievement_id"] for row in approved_variants})
        maintained = [row for row in read.current_wordings(profile_id, achievement_ids=achievement_ids)
                      if row["requirement_id"] in requirement_ids]
        maintained_scope = {"profile_id": profile_id, "requirement_ids": requirement_ids,
                            "achievement_ids": achievement_ids, "assignments": maintained}
        result = {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "profile_revision": profile_revision,
                  "fact_semantics_version": profile["fact_semantics_version"],
                  "status": "current", "requirements": [], "relations": [], "wording_gaps": [],
                  "approved_variants": [], "current_wordings": [], "section_support": [],
                  "source_binding": {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "profile_revision": profile_revision,
                                     "source_fingerprint": source_hash, "relation_ids": [], "assessment_ids": {},
                                     "current_wordings_scope": {"requirement_ids": requirement_ids, "achievement_ids": achievement_ids},
                                     "current_wordings_fingerprint": fingerprint(maintained_scope)}}
        if profile["profile_revision"] != profile_revision:
            result["status"] = "stale"
        selected_variants = []
        for supplied in approved_variants:
            variant = variants.get(supplied["variant_id"])
            revision = supplied.get("variant_revision", supplied.get("revision"))
            if (variant is None or str(variant["revision"]) != str(revision)
                    or variant["achievement_id"] != supplied["achievement_id"]):
                result["status"] = "stale"
                continue
            selected_variants.append(variant)
            result["approved_variants"].append({"variant_id": variant["variant_id"],
                                                 "revision": variant["revision"],
                                                 "achievement_id": variant["achievement_id"]})
        for supplied in requirements:
            ident = supplied["requirement_id"]
            revision = supplied.get("requirement_revision", supplied.get("revision"))
            key = qualification_key(supplied)
            current = next((row for row in read.demand_catalog_snapshot(active_only=True)["demands"]
                            if qualification_key(row) == key), None)
            result["requirements"].append({"contract_version": CONTRACT_VERSION,
                "requirement_id": ident, "requirement_revision": revision,
                **{name: supplied[name] for name in ("category", "name", "definition", "capability_definition",
                                                    "demand_fingerprint", "normalization_version") if name in supplied}})
            if (current is None or any(current.get(name) != supplied.get(name) for name in
                                       ("definition", "capability_definition", "demand_fingerprint", "normalization_version"))):
                result["status"] = "stale"
                continue
            assessment = read.latest_assessment(profile_id, ident, revision,
                                                       source_fingerprint=qualification_fingerprint(profile, current))
            result["source_binding"]["assessment_ids"][key] = assessment["assessment_id"] if assessment else None
            if assessment is None:
                if result["status"] != "stale":
                    result["status"] = "not_recorded"
                result["wording_gaps"].append({"requirement_id": ident, "demand_fingerprint": supplied["demand_fingerprint"],
                                              "status": "qualification_not_recorded"})
                continue
            if assessment["kind"] in {"matched", "transferable"} and not wording_eligible(assessment):
                result["section_support"].append({"requirement_id": ident, "assessment_id": assessment["assessment_id"],
                    "demand_fingerprint": current["demand_fingerprint"],
                    "category": assessment["category"], "evidence_refs": assessment["evidence_refs"]})
                continue
            current_wordings = []
            for head in maintained:
                if head["requirement_id"] != ident:
                    continue
                view = assignment_view(head, read, profile)
                pin = next((row for row in view["demand_bindings"] if row["demand_fingerprint"] == current["demand_fingerprint"]
                            and row["assessment_id"] == assessment["assessment_id"]), None)
                if pin is None:
                    continue
                reasons = list(dict.fromkeys([*view["stale_reasons"], *pin["stale_reasons"]]))
                current_wordings.append({**view, **{name: pin[name] for name in
                    ("demand_fingerprint", "assessment_id", "relation_id")}, "current": not reasons,
                    "stale_reasons": reasons})
            result["current_wordings"].extend(current_wordings)
            supplied_variant_ids = {row["variant_id"] for row in selected_variants}
            covered = False
            for assignment in current_wordings:
                if (not assignment["current"] or assignment["variant_id"] not in supplied_variant_ids
                        or assignment["achievement_id"] not in assessment["achievement_ids"]):
                    continue
                variant = variants[assignment["variant_id"]]
                relation = read.coverage(profile_id, ident, revision, assessment["assessment_id"],
                                                 variant["variant_id"], variant["revision"])
                if relation is not None and relation["relation_id"] == assignment["relation_id"]:
                    result["relations"].append({**relation, "assignment_id": assignment["assignment_id"],
                                                "assignment_revision": assignment["revision"]})
                    result["source_binding"]["relation_ids"].append(relation["relation_id"])
                    covered = covered or relation["covered"]
            if assessment["kind"] in {"matched", "transferable"} and not covered:
                if result["status"] != "stale":
                    result["status"] = "not_recorded"
                gap = {"requirement_id": ident, "demand_fingerprint": current["demand_fingerprint"],
                       "status": "current_wording_not_selected" if not current_wordings else "current_wording_stale",
                       "person_qualification": assessment["kind"]}
                requests = read.wording_requests(profile_id, ident, revision)
                for binding in requests:
                    if not any(qualification_key(row) == key for row in binding.get("requirements", [binding])):
                        continue
                    proposal = read.authoring_request(binding["origin_key"], profile_id=profile_id)
                    if proposal is not None:
                        gap.update({"proposal_id": binding["proposal_id"], "proposal_status": proposal["status"]})
                        break
                result["wording_gaps"].append(gap)
        # A stale caller binding never receives a positive composition edge.
        if result["status"] == "stale":
            result["relations"] = [{**relation, "covered": False, "status": "stale"}
                                   for relation in result["relations"]]
            result["wording_gaps"] = [{**gap, "status": "stale"} for gap in result["wording_gaps"]]
        result["snapshot_id"] = "fit-coverage-snapshot-" + fingerprint(result)
        return result

    def assert_current(self, snapshot: dict, connection=None) -> None:
        """Check public Resumes source tokens inside the caller's publication snapshot."""
        with self.store.read_snapshot(connection) as read:
            self._assert_current(read, snapshot)

    def _assert_current(self, read, snapshot):
        require_contract(snapshot)
        if snapshot.get("status") not in {"current", "not_recorded"}:
            raise ConflictError("Source-current Fit coverage is required.")
        profile = dto(read.profile_snapshot(snapshot["profile_id"]))
        if (profile["profile_revision"] != snapshot["profile_revision"]
                or fact_fingerprint(profile) != snapshot["source_binding"]["source_fingerprint"]):
            raise ConflictError("The Profile used for wording coverage has changed.")
        current = self._coverage_for(read, snapshot["profile_revision"], snapshot["requirements"], snapshot["approved_variants"],
                                      profile_id=snapshot["profile_id"])
        if (current["status"] != snapshot["status"]
                or current["source_binding"] != snapshot["source_binding"]
                or current["relations"] != snapshot["relations"]):
            raise ConflictError("The qualified requirements or approved wording relations have changed.")

    def summary_for_jobs(self, job_ids, connection=None) -> dict:
        return {job_id: self.get_job_fit(job_id, connection=connection, include_coverage=False) for job_id in job_ids}

    def query_summaries(self, job_ids, connection=None, *, postings=None) -> dict:
        """Bounded Jobs-grid scalars with bulk authority checks and no inference."""
        if not isinstance(job_ids, (list, tuple)) or len(job_ids) > 1000 or any(
            not isinstance(ident, str) or not ident for ident in job_ids
        ):
            raise AppError("invalid_job_selection", "Read at most 1,000 Fit summaries.")
        with self.store.read_snapshot(connection) as read:
            return self._query_summaries(read, job_ids, postings=postings)

    def _query_summaries(self, read, job_ids, *, postings=None):
        ids = list(dict.fromkeys(job_ids))
        scores = read.score_batch(ids)
        scored = {ident: scored_demands(score) for ident, score in scores.items()}
        requirement_bindings = read.requirement_bindings(ids if postings is not None else list(scores), postings=postings, scored=scored)
        profiles = {}
        for profile_id in {score["source_binding"]["profile_id"] for score in scores.values()}:
            try:
                snapshot = read.profile_snapshot(profile_id)
                profiles[profile_id] = (dto(snapshot), fingerprint(snapshot.scoring_guidance))
            except NotFoundError:
                profiles[profile_id] = (None, None)
        superseded = read.superseded_assessments([
            ident for score in scores.values() if current_contract(score)
            for ident in score["source_binding"]["assessment_ids"]
        ])
        result = {ident: {"contract_version": CONTRACT_VERSION, "job_id": ident, "current": False,
                          "qualifications_current": False, "stale_reasons": [], "score": None, "normalized_keywords": []} for ident in ids}
        if postings is not None:
            for ident in result.keys() - scores.keys():
                requirements = requirement_bindings.get(ident)
                result[ident]["current_requirements"] = (
                    {"status": requirements["status"], "revision": requirements["revision"]}
                    if requirements and requirements["status"] in {"complete", "unsupported_language"}
                    and requirements["posting_available"] and not requirements["stale"]
                    and requirements["posting_revision"] == postings[ident]["revision"] else None)
        for ident, score in scores.items():
            source = score["source_binding"]
            profile, guidance = profiles[source["profile_id"]]
            current_requirements = requirement_bindings.get(ident)
            reasons = score_stale_reasons(score, profile, guidance, current_requirements, scored[ident])
            if not reasons and superseded.intersection(source["assessment_ids"]):
                reasons.append("qualification_changed")
            keywords = [] if {"contract_changed", "unsupported_posting_language", "qualification_semantics_changed",
                              "requirements_consolidation_required"}.intersection(reasons) else sorted({
                " ".join(unicodedata.normalize("NFKC", label).split()).casefold()
                for row in score["assessments"] for label in row["keywords"] if label.strip()})
            summary = {key: score[key] for key in ("revision", "score", "computed_score", "fit_band", "confidence",
                                                   "eligibility", "created_at", "source_binding")}
            summary.update({key: score[key] for key in ("contract_version", "formula_version", "policy_version", "summary") if key in score})
            result[ident] = {"contract_version": CONTRACT_VERSION, "job_id": ident, "current": not reasons,
                             "qualifications_current": not reasons and not current_requirements["regrouped"],
                             "stale_reasons": reasons, "score": summary, "normalized_keywords": keywords}
        return result

    def minimum_fit_score(self, connection=None) -> int:
        with self.store.read_snapshot(connection) as read:
            return read.settings_snapshot().get("minFitScore", 7)

    def digest_summary(self, job_ids, since: str | None = None, threshold=None, connection=None) -> dict:
        if threshold is None:
            threshold = self.minimum_fit_score(connection)
        summaries = self.summary_for_jobs(job_ids, connection=connection)
        high = [ident for ident, value in summaries.items()
                if not {"contract_changed", "unsupported_posting_language"}.intersection(value["stale_reasons"]) and value["score"] is not None
                and value["score"]["score"] is not None and value["score"]["score"] >= threshold]
        cutoff = self._instant(since) if since is not None else None
        new = [ident for ident, value in summaries.items() if not {"contract_changed", "unsupported_posting_language"}.intersection(value["stale_reasons"])
               and value["score"] is not None and value["score"]["score"] is not None
               and (cutoff is None or self._instant(value["score"]["created_at"]) >= cutoff)]
        return {"highFitJobIds": high, "currentHighFitJobIds": [ident for ident in high if summaries[ident]["current"]],
                "newMatchJobIds": new,
                "staleJobIds": [ident for ident, value in summaries.items() if value["score"] and not value["current"]]}

    def keywords(self) -> dict:
        results = {}
        for job_id, value in self.summary_for_jobs(self.store.scored_job_ids()).items():
            if value["score"] is None or {"contract_changed", "unsupported_posting_language"}.intersection(value["stale_reasons"]):
                continue
            for label in {label for row in value["score"]["assessments"] for label in row["keywords"] if label.strip()}:
                display = " ".join(unicodedata.normalize("NFKC", label).split())
                key = display.casefold()
                entry = results.setdefault(key, {"normalized_keyword": key, "display_keyword": display,
                                                  "job_ids": set(), "score_versions": {}})
                entry["job_ids"].add(job_id)
                entry["score_versions"][job_id] = value["score"]["revision"]
        return {"keywords": [{**{key: value for key, value in entry.items() if key != "job_ids"},
                               "job_count": len(entry["job_ids"])} for _, entry in sorted(results.items())]}

    def evidence_map(self, profile_id="default") -> dict:
        sources, gaps, coverage, wording_gaps = {}, [], [], []
        with self.store.read_snapshot() as read:
            try:
                profile = dto(read.profile_snapshot(profile_id))
                variants = {row["variant_id"]: row for row in profile["approved_variants"]}
            except NotFoundError:
                variants = {}
            job_ids = read.scored_job_ids()
            for offset in range(0, len(job_ids), 200):
                ids = job_ids[offset:offset + 200]
                scores = read.score_batch(ids)
                summaries = self._query_summaries(read, ids)
                assessments = {row["assessment_id"] for score in scores.values()
                               if score["source_binding"]["profile_id"] == profile_id for row in score["assessments"]}
                recorded = {}
                assessment_ids = sorted(assessments)
                for start in range(0, len(assessment_ids), 1000):
                    for relation in read.coverage_rows(assessment_ids[start:start + 1000]):
                        recorded.setdefault(relation["assessment_id"], []).append(relation)
                for job_id, score in scores.items():
                    if score["source_binding"]["profile_id"] != profile_id:
                        continue
                    current = summaries[job_id]["qualifications_current"]
                    for row in score["assessments"]:
                        binding = {"job_id": job_id, "current": current, "score_revision": score["revision"],
                                   "requirement_id": row["requirement_id"], "requirement_revision": row["requirement_revision"]}
                        for ref in row["evidence_refs"]:
                            entry = sources.setdefault(ref["source_id"], {"source_id": ref["source_id"], "usages": []})
                            entry["usages"].append({**binding, "kind": row["kind"], "evidence_ref": ref,
                                                    "determination_id": row["determination_id"]})
                        if row["kind"] in {"missing", "blocked", "transferable", "not_assessed"}:
                            gaps.append({**binding, **{key: row[key] for key in (
                                "text", "name", "category", "kind", "rationale", "determination_id",
                            ) if key in row}})
                        seen, current_variants, covered = set(), set(), False
                        for relation in recorded.get(row["assessment_id"], []):
                            key = (relation["variant_id"], str(relation["variant_revision"]))
                            latest = key not in seen
                            seen.add(key)
                            variant = variants.get(relation["variant_id"])
                            source_current = bool(current and latest and variant is not None
                                and str(variant["revision"]) == str(relation["variant_revision"])
                                and variant_fingerprint(variant) == relation["variant_fingerprint"])
                            coverage.append({**binding, "current": source_current,
                                "achievement_id": relation["achievement_id"], "variant_id": relation["variant_id"],
                                "variant_revision": relation["variant_revision"], "status": relation["status"],
                                "covered": relation["covered"], "determination_id": relation["determination_id"],
                                "source_refs": [{key: ref[key] for key in ("source_id", "revision")}
                                                for ref in relation.get("source_refs", [])]})
                            if source_current:
                                current_variants.add(key)
                            covered = covered or source_current and relation["covered"]
                        if wording_eligible(row) and row["kind"] in {"matched", "transferable"} and not covered:
                            expected_variants = {(variant["variant_id"], str(variant["revision"]))
                                                 for variant in variants.values()
                                                 if variant["achievement_id"] in row["achievement_ids"]}
                            status = "stale" if not current else (
                                "missing_approved_wording" if expected_variants.issubset(current_variants) else "not_recorded")
                            wording_gaps.append({**binding, "status": status,
                                                 "person_qualification": row["kind"]})
        return {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "sources": list(sources.values()), "gaps": gaps,
                "coverage": coverage, "wording_gaps": wording_gaps}

    def delete_job_data(self, job_id, connection=None):
        """Delete job scores, retaining reusable person/requirement intelligence."""
        self.store.delete_job_data(job_id, connection)

    def delete_requirement_data(self, requirement_ids, connection=None):
        """Remove relations to meanings permanently deleted by their owner."""
        self.store.delete_requirement_data(requirement_ids, connection)

    def _replay_operation(self, operation_id, input_fingerprint):
        recorded = self.store.operation(operation_id, input_fingerprint)
        if recorded is None:
            return None
        require_contract(recorded)
        current = self.get_job_fit(recorded["job_id"], recorded["score"]["source_binding"]["profile_id"],
                                   include_coverage=False)
        result = {**recorded, "operation_reused": True, "requirements_current": current["requirements_current"],
                  "qualifications_current": current["qualifications_current"], "selection": current["selection"]}
        if current["score"] is None or current["score"]["revision"] != recorded["score"]["revision"]:
            result.update({"current": False, "stale_reasons": ["superseded"],
                           "current_revision": current["score"]["revision"] if current["score"] else None})
            result["qualifications_current"] = False
            result["selection"]["ready_for_materials"] = False
        else:
            result.update({"current": current["current"], "stale_reasons": current["stale_reasons"]})
        return result

    def _result_for_score(self, accepted):
        result = self.get_job_fit(accepted["job_id"], accepted["source_binding"]["profile_id"])
        if result["score"] is None or result["score"]["revision"] != accepted["revision"]:
            result.update({"current": False, "stale_reasons": ["superseded"],
                           "current_revision": result["score"]["revision"] if result["score"] else None,
                           "score": deepcopy(accepted)})
            result["qualifications_current"] = False
            result["selection"]["ready_for_materials"] = False
        return result

    def _assert_score_revision(self, read, job_id, expected_revision):
        current = read.latest_score(job_id)
        revision = current["revision"] if current else 0
        if revision != expected_revision:
            raise ConflictError("The saved Fit version has changed.", current_revision=revision)
        return current

    @staticmethod
    def _expected_revision(value):
        if type(value) is not int or value < 0:
            raise AppError("expected_revision_required", "The current Fit revision is required.", 428)

    @staticmethod
    def _rationale(value):
        if not isinstance(value, str) or not 0 < len(value.strip()) <= 4000:
            raise AppError("fit_rationale_required", "Supply a correction rationale of at most 4000 characters.")
        return value.strip()

    @staticmethod
    def _check_cancelled(cancelled):
        if cancelled():
            raise asyncio.CancelledError()

    @staticmethod
    def _instant(value):
        try:
            instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            raise AppError("fit_invalid_timestamp", "Fit timestamps must be ISO timestamps.") from None
        instant = instant.replace(tzinfo=timezone.utc) if instant.tzinfo is None else instant.astimezone(timezone.utc)
        return instant.replace(microsecond=(instant.microsecond // 1000) * 1000)
