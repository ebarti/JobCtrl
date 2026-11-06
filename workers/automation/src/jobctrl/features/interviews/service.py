"""Interview preparation and independently revisioned user notes."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import re

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.semantic.identifiers import TenantId, canonical_job_id
from jobctrl.features.interviews.domain.catalog import (
    INTERVIEW_ANSWER_FORMATS, INTERVIEW_ROLE_LENSES, InterviewSelectionError,
    canonical_json_digest, get_interview_question, load_interview_catalog, validate_interview_selection,
)
from jobctrl.features.interviews.domain.evidence import InterviewEvidenceSnapshot, InterviewEvidenceSource
from jobctrl.features.interviews.domain.preparation import fence_evidence_selection, job_context_snapshot, normalize_selection
from jobctrl.features.interviews.domain.value_objects import InterviewPrep
from jobctrl.features.interviews.generation import InterviewGeneration
from jobctrl.features.interviews.source_authority.profile_snapshot import ProfileSnapshot as PreparationProfile
from jobctrl.features.interviews.ports import InterviewRepository, ModelPort


def _now():
    return datetime.now(timezone.utc).isoformat()


def _job_id(value):
    try:
        return str(canonical_job_id(value))
    except ValueError:
        raise AppError("invalid_job_id", "The job identifier is invalid.") from None


def _pagination(page, page_size, *, max_size=100):
    try:
        page, page_size = int(page), int(page_size)
        if not 1 <= page <= 1000 or not 1 <= page_size <= max_size:
            raise ValueError()
        return page, page_size
    except (ValueError, TypeError):
        raise AppError("invalid_pagination", "The requested page is invalid.") from None


class PreparationRepository:
    def __init__(self, service, *, profile, job, requirements, fit_revision, material, material_available, cancelled):
        self.service, self.profile, self.job, self.requirements = service, profile, job, requirements
        self.fit_revision = fit_revision
        self.material, self.material_available = material, material_available
        self.cancelled = cancelled

    def next_generation(self, tenant_id, job_id):
        with self.service.repository.read_session() as session:
            return session.next_generation(str(job_id))

    def find_completed_for_run(self, tenant_id, job_id, origin_run_id):
        with self.service.repository.read_session() as session:
            found = session.preparation_for_run(str(job_id), origin_run_id)
            if not found:
                return None
            value, receipts = found
            if value["status"] in {"accepted", "superseded"}:
                self.service._verify_prep(value, receipts, session)
            return InterviewPrep.from_dict(value)

    def save_determination(self, identity, envelope_json, receipt_id):
        # Deletion and insertion share the Jobs-owned transaction boundary. A
        # model call that returns after reviewed deletion cannot recreate an
        # Interview-owned row for the deleted Job.
        with self.service.repository.transaction() as session:
            self.service.jobs.get_posting_snapshot(self.job["job_id"], connection=session.source_context)
            session.save_determination(identity, envelope_json, receipt_id)

    def assert_sources(self, job_id, session):
        self.service.profile.assert_current(self.profile, connection=session.source_context)
        self.service.jobs.assert_posting_current(job_id, self.job["revision"], self.job.get("source_hash"), connection=session.source_context)
        if self.requirements is not None:
            self.service.requirements.assert_current(self.requirements, connection=session.source_context)
        elif self.service.requirements is not None:
            try:
                current = self.service.requirements.get_job_requirements(job_id, connection=session.source_context)
            except NotFoundError:
                current = None
            if current is not None and not current.get("stale"):
                raise ConflictError("Requirements appeared during interview preparation.")
        if self.fit_revision is not None:
            current_fit = self.service.fit.get_job_fit(job_id, connection=session.source_context, include_coverage=False)
            if not current_fit["current"] or current_fit["score"]["revision"] != self.fit_revision:
                raise ConflictError("Fit changed during interview preparation.")
        if self.service.resumes is not None and self.material_available:
            if self.material is not None:
                self.service.resumes.assert_interview_current(self.material, connection=session.source_context)
            elif self.service.resumes.accepted_snapshot(job_id, connection=session.source_context) is not None:
                raise ConflictError("An approved resume appeared during preparation.")

    def save(self, prep, *, tenant_id, origin_run_id="", receipts=()):
        if self.cancelled():
            raise ConflictError("Interview preparation was cancelled.")
        with self.service.repository.transaction() as session:
            if self.cancelled():
                raise ConflictError("Interview preparation was cancelled.")
            # A concurrent reviewed deletion must not be followed by a late
            # failed attempt recreating a job-owned preparation row.
            self.service.jobs.get_posting_snapshot(str(prep.job_id), connection=session.source_context)
            if prep.generation != session.next_generation(str(prep.job_id)):
                raise ConflictError("Interview preparation changed during generation.")
            if prep.status == "accepted":
                self.assert_sources(str(prep.job_id), session)
            receipts = list({item["receipt_id"]: item for item in receipts}.values())
            for provenance in receipts:
                receipt = self.service.model.receipt(provenance["receipt_id"], connection=session.source_context)
                if not receipt or receipt.get("status") != "succeeded" or any(receipt.get(k) != v for k, v in provenance.items()):
                    raise ConflictError("Interview preparation provenance is unavailable.")
            if prep.status == "accepted":
                self.service._verify_prep(prep.to_read_model(), receipts, session)
            session.save_preparation(prep.to_read_model(), origin_run_id, receipts)


class InterviewService:
    def __init__(self, repository: InterviewRepository, *, model: ModelPort, profile, jobs, requirements=None, fit=None, resumes=None):
        self.repository, self.model, self.profile, self.jobs = repository, model, profile, jobs
        self.requirements, self.fit, self.resumes = requirements, fit, resumes

    def _verify_prep(self, prep, receipts, session):
        """Resolve the recorded model and domain determination identities."""
        context = prep.get("generationContext")
        try:
            binding = context["determinations"]
            selected = context["selectedQuestions"]
            claims = binding["claimVerification"]
            if (canonical_json_digest({key: value for key, value in context.items() if key != "contextDigest"}) != context["contextDigest"]
                    or context["jobContext"]["jobId"] != prep["jobId"]
                    or len(claims) != len(selected) or len(selected) != len(prep["items"])):
                raise ValueError()
            for selected_question, item in zip(selected, prep["items"], strict=True):
                metadata = item["questionMetadata"]
                ids = selected_question["selectedEvidenceIds"]
                if (metadata["questionId"] != selected_question["questionId"]
                        or metadata["cardRevision"] != selected_question["cardRevision"]
                        or metadata["cardDigest"] != selected_question["cardDigest"]
                        or [link["evidenceId"] for link in metadata["evidenceLinks"]] != ids
                        or set(item["evidenceIds"]) - set(ids)):
                    raise ValueError()
                for section in metadata["outline"]:
                    if (set(section["evidenceIds"]) - set(ids)
                            or (section["factualSupport"] == "accepted_profile_fact") != bool(section["evidenceIds"])):
                        raise ValueError()
                text = "\n\n".join(f"{section['heading']}: {section['text']}" for section in metadata["outline"])
                if metadata["gaps"]:
                    text += "\n\nMissing details:\n" + "\n".join(gap["prompt"] for gap in metadata["gaps"])
                if text != item["generatedText"]:
                    raise ValueError()
            expected = [(binding["plan"], "interview_plan", prep["jobId"]),
                        *[(ident, "claim_verification", f"{prep['jobId']}:question:{item['questionId']}")
                          for ident, item in zip(claims, selected, strict=True)],
                        (binding["quality"], "artifact_quality", prep["jobId"])]
            receipt_ids = {item["receipt_id"] for item in receipts}
            if (len(receipt_ids) != len(receipts) or len(receipt_ids) < 2 * len(selected) + 2
                    or len({ident for ident, _, _ in expected}) != len(expected)):
                raise ValueError()
            for provenance in receipts:
                receipt = self.model.receipt(provenance["receipt_id"], connection=session.source_context)
                if (receipt.get("status") != "succeeded" or receipt.get("operation") != "interviews.preparation"
                        or any(receipt.get(key) != value for key, value in provenance.items())):
                    raise ValueError()
            for ident, kind, entity_id in expected:
                row = session.determination(ident)
                if row is None or row[1] not in receipt_ids:
                    raise ValueError()
                envelope = json.loads(row[0])
                receipt = self.model.receipt(row[1], connection=session.source_context)
                expected_id = canonical_json_digest({"inputFingerprint": receipt.get("input_fingerprint"), "receiptId": row[1]})
                if (envelope.get("determination_id") != ident or expected_id != ident
                        or envelope.get("input_fingerprint") != receipt.get("input_fingerprint")
                        or envelope.get("receipt_id") != row[1]
                        or envelope.get("raw_result_digest") != canonical_json_digest(receipt.get("value"))
                        or envelope.get("tenant_id") != "local" or envelope.get("kind") != kind
                        or envelope.get("entity_id") != entity_id or envelope.get("lane") != "interview"
                        or receipt.get("status") != "succeeded" or receipt.get("operation") != "interviews.preparation"):
                    raise ValueError()
        except (KeyError, TypeError, ValueError, NotFoundError):
            raise AppError("interview_provenance_invalid", "The saved interview preparation provenance is invalid.", status_code=409) from None

    def _material(self, job_id, conn):
        if self.resumes is None:
            return None, True, []
        try:
            snapshot = self.resumes.interview_snapshot(job_id, connection=conn)
            if snapshot is None:
                return None, True, []
            accepted = snapshot["accepted"]
            return snapshot, True, [{"artifactId": accepted["resume_id"], "generation": accepted["revision_number"],
                                     "materialSha256": accepted["pdf"]["sha256"]}]
        except (AppError, ValueError, OSError):
            return None, False, [{"inputWarning": "Current approved resume is unavailable as a preparation input."}]

    def catalog(self, query):
        catalog = load_interview_catalog()
        allowed = {"topic", "role", "answerFormat", "source", "search", "page", "pageSize"}
        if set(query) - allowed:
            raise AppError("invalid_selection", "The catalog filter is invalid.")
        if ((query.get("role") and query["role"] not in INTERVIEW_ROLE_LENSES)
                or (query.get("answerFormat") and query["answerFormat"] not in INTERVIEW_ANSWER_FORMATS)
                or any(key in query and (not query[key].strip() or len(query[key]) > limit)
                       for key, limit in (("topic", 80), ("source", 20)))):
            raise AppError("invalid_selection", "The catalog filter is invalid.")
        page, size = _pagination(query.get("page", 1), query.get("pageSize", 121), max_size=121)
        search = str(query.get("search", "")).strip().lower()
        if len(search) > 200:
            raise AppError("invalid_selection", "The catalog filter is invalid.")
        source = next((row for row in catalog["sources"] if row["id"] == query.get("source")), None)
        cards = [card for card in catalog["questions"] if (not query.get("topic") or card["topic"] == query["topic"])
                 and (not query.get("role") or query["role"] in card["roleLenses"])
                 and (not query.get("answerFormat") or query["answerFormat"] in card["answerFormats"])
                 and (not query.get("source") or source is not None and card["id"] in source["questionIds"])
                 and (not search or search in " ".join([card["id"], card["title"], card["variants"], card["intent"],
                     *card["responsibilityTags"], *card["competencyTags"]]).lower())]
        return {"ok": True, "catalog": {**catalog, "questions": cards[(page - 1) * size:page * size]},
                "page": page, "pageSize": size, "total": len(cards)}

    def question(self, question_id):
        catalog = load_interview_catalog()
        try:
            question = get_interview_question(question_id, catalog=catalog)
        except InterviewSelectionError as error:
            raise AppError(error.code, "The interview question is unavailable.",
                           status_code=400 if error.code == "invalid_selection" else 404) from None
        return {"ok": True, "catalogBinding": {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}, "question": question}

    def _inputs(self, job_id, selection, *, connection=None):
        job = self.jobs.get_posting_snapshot(job_id, connection=connection)
        profile = self.profile.snapshot(connection=connection)
        data = profile.to_dict()
        legacy = PreparationProfile(tenant_id=TenantId("local"), profile_id=profile.profile_id,
                                    version=profile.profile_revision, _data=deepcopy(data.get("document", {})))
        sources = []
        for item in data.get("evidence_sources", []):
            if item.get("kind") == "evidence" and item.get("confirmation") == "review_required":
                raise AppError("legacy_evidence_review_required", "Review imported evidence confirmation before preparing for an interview.", status_code=409)
            if (item.get("kind") == "evidence" and item.get("confirmation") == "confirmed"
                    and item.get("record", {}).get("evidence_strength") in {"supported", "verified"}
                    and isinstance(item.get("source_id"), str) and isinstance(item.get("text"), str)):
                sources.append(InterviewEvidenceSource(item["source_id"], item["text"], ()))
        if len(sources) > 400 or len({item.evidence_id for item in sources}) != len(sources) or any(len(item.excerpt) > 4000 for item in sources):
            raise AppError("invalid_evidence_selection", "The confirmed evidence cannot be used for preparation.")
        evidence = InterviewEvidenceSnapshot(TenantId("local"), profile.profile_id, profile.profile_revision, tuple(sources))
        catalog = load_interview_catalog()
        try:
            selection = normalize_selection(selection)
            if "selectedQuestionIds" in selection:
                validate_interview_selection(selection["selectedQuestionIds"], catalog_binding=selection.get("catalogBinding"), catalog=catalog)
            fence_evidence_selection(selection, legacy, evidence)
        except InterviewSelectionError as error:
            raise AppError(error.code, "The selected questions or evidence have changed.", status_code=409) from None
        requirement_snapshot = None
        if self.requirements is not None:
            try:
                candidate = self.requirements.get_job_requirements(job_id, connection=connection)
                if not candidate.get("stale"):
                    requirement_snapshot = candidate
            except NotFoundError:
                pass
        rows = []
        if requirement_snapshot:
            seen = set()
            for item in requirement_snapshot["requirements"]:
                # Different occurrences may join the same canonical meaning.
                # Keep one exact ID and source occurrence, not duplicate model sources.
                if item["requirement_id"] in seen:
                    continue
                seen.add(item["requirement_id"])
                rows.append({"requirementId": item["requirement_id"], "requirementText": item["text"],
                             "sourceExcerpt": " ".join(span["quote"] for span in item.get("spans", [])),
                             "tier": item["tier"], "weight": item["weight"]})
                if len(rows) == 20:
                    break
            if any(len(row["requirementText"]) > 3000 or len(row["sourceExcerpt"]) > 3000 for row in rows):
                raise AppError("requirements_over_budget", "A requirement exceeds the interview preparation budget.")
        fit_context = None
        if self.fit is not None and requirement_snapshot is not None:
            fit = self.fit.get_job_fit(job_id, connection=connection, include_coverage=False)
            if fit["current"] and fit["score"] is not None:
                fit_context = {"scoreVersion": fit["score"]["revision"],
                               "employerAnalysisGeneration": requirement_snapshot["revision"],
                               "profileSnapshotVersion": profile.profile_revision, "status": "current"}
        # The existing domain accepts a job DTO, not a sibling repository row.
        job_for_domain = {"job_id": job_id, "title": job.get("title") or "", "company": job.get("company") or "",
                          "description": job.get("text") or job.get("description") or ""}
        material, material_available, materials = self._material(job_id, connection)
        return profile, job, legacy, evidence, requirement_snapshot, rows, job_for_domain, selection, catalog, material, material_available, materials, fit_context

    def validate_generation(self, job_id, payload):
        job_id = _job_id(job_id)
        if not isinstance(payload, dict):
            raise AppError("invalid_selection", "The interview preparation request is invalid.")
        model = payload.get("llmModel")
        if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > 120):
            raise AppError("invalid_selection", "The model selection is invalid.")
        selection = {key: value for key, value in payload.items() if key != "llmModel"}
        with self.repository.read_session() as session:
            self._inputs(job_id, selection, connection=session.source_context)
        return {"jobId": job_id, **selection, **({"llmModel": model} if model is not None else {})}

    async def generate(self, context, payload):
        if not isinstance(payload, dict) or "jobId" not in payload:
            raise AppError("invalid_selection", "A job is required for interview preparation.")
        job_id = _job_id(payload["jobId"])
        # The preparation commit can precede the action-run acknowledgement.
        # A recovered run returns that exact artifact even if sources changed.
        with self.repository.read_session() as session:
            completed = session.preparation_for_run(job_id, context.run_id)
            if completed:
                value, receipts = completed
                if value["status"] in {"accepted", "superseded"}:
                    self._verify_prep(value, receipts, session)
        if completed:
            prep = InterviewPrep.from_dict(value)
            return {"status": "failed" if prep.status == "failed" else "accepted", "jobId": job_id,
                    "generation": prep.generation, "itemCount": len(prep.items),
                    "errors": [*prep.gate_audit.fabrication_findings, *prep.gate_audit.grounding_findings]}
        checked = self.validate_generation(job_id, {key: value for key, value in payload.items() if key != "jobId"})
        if context.cancelled():
            raise ConflictError("Interview preparation was cancelled.")
        with self.repository.read_session() as session:
            inputs = self._inputs(job_id, {k: v for k, v in checked.items() if k not in {"jobId", "llmModel"}}, connection=session.source_context)
        profile, job, legacy, evidence, req_snapshot, requirements, job_domain, selection, catalog, material, material_available, materials, fit_context = inputs
        writer = PreparationRepository(self, profile=profile, job=job, requirements=req_snapshot, material=material,
                                       fit_revision=fit_context["scoreVersion"] if fit_context else None,
                                       material_available=material_available, cancelled=context.cancelled)
        source_hash = canonical_json_digest({"profile": profile.fingerprint, "jobId": job_id,
            "jobRevision": job["revision"], "jobSourceHash": job["source_hash"], "requirements": req_snapshot,
            "fit": fit_context, "materials": materials, "selection": selection, "requestedModel": checked.get("llmModel")})
        with self.repository.transaction() as session:
            writer.assert_sources(job_id, session)
            previous = session.generation_run(context.run_id)
            if previous:
                if previous["job_id"] != job_id or previous["input_hash"] != source_hash:
                    raise ConflictError("Interview preparation sources changed during recovery.")
                model_selection = previous["selection"]
            else:
                model_selection = self.model.selection(checked.get("llmModel"))
                session.reserve_generation_run(context.run_id, job_id, source_hash, model_selection)
        employer_context = ({"generation": req_snapshot["revision"], "snapshotHash": req_snapshot["posting_hash"],
                             "roleFraming": "", "inferredSeniority": "", "requirements": requirements}
                            if req_snapshot else None)
        engine = InterviewGeneration(model=self.model, writer=writer,
                                     context=context, selection=model_selection)
        return await engine.execute(job=job_domain, profile=legacy, evidence=evidence, requirements=requirements,
                                    selection=selection, catalog=catalog, employer=employer_context,
                                    fit=fit_context, materials=materials)

    def _stale(self, prep, job_id, conn):
        context = prep.get("generationContext")
        if not context:
            return ["legacy_unbound"]
        reasons = []
        catalog = load_interview_catalog()
        if context.get("catalogBinding") != {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}:
            reasons.append("catalog_changed")
        try:
            profile = self.profile.snapshot(connection=conn)
            if profile.profile_revision != context["profile"]["version"]:
                reasons.append("profile_changed")
        except NotFoundError:
            reasons.append("profile_changed")
        try:
            job = self.jobs.get_posting_snapshot(job_id, connection=conn)
            current = job_context_snapshot({"job_id": job_id, "title": job.get("title") or "", "company": job.get("company") or "",
                                            "description": job.get("text") or job.get("description") or ""})
            if current != context.get("jobContext"):
                reasons.append("job_changed")
        except NotFoundError:
            reasons.append("job_changed")
        old_requirements = context.get("employerAnalysis")
        if old_requirements is not None or self.requirements is not None:
            try:
                if self.requirements is None:
                    raise NotFoundError()
                current_requirements = self.requirements.get_job_requirements(job_id, connection=conn)
                if (old_requirements is None or current_requirements.get("stale") or current_requirements["revision"] != old_requirements["generation"]
                        or current_requirements["posting_hash"] != old_requirements["snapshotHash"]):
                    reasons.append("employer_analysis_changed")
            except NotFoundError:
                if old_requirements is not None:
                    reasons.append("employer_analysis_changed")
        old_materials = context.get("approvedMaterials", [])
        if self.resumes is not None:
            _snapshot, available, current_materials = self._material(job_id, conn)
            actual = [{"materialId": item["artifactId"], "generation": item["generation"], "sha256": item["materialSha256"]}
                      for item in current_materials if "materialSha256" in item]
            if not available or actual != old_materials:
                reasons.append("approved_materials_changed")
        elif old_materials:
            reasons.append("approved_materials_changed")
        return reasons

    def history(self, job_id, query):
        job_id = _job_id(job_id)
        if set(query) - {"generation", "page", "pageSize"}:
            raise AppError("invalid_pagination", "The requested history query is invalid.")
        page, size = _pagination(query.get("page", 1), query.get("pageSize", 20))
        generation = query.get("generation")
        if generation is not None:
            try:
                generation = int(generation)
                if generation < 1:
                    raise ValueError()
            except ValueError:
                raise AppError("invalid_generation", "The preparation generation is invalid.") from None
        with self.repository.read_session() as session:
            self.jobs.get_posting_snapshot(job_id, connection=session.source_context)
            total, rows = session.preparations(job_id, generation, size, (page - 1) * size)
            generations = []
            for value, receipts in rows:
                if value["status"] in {"accepted", "superseded"}:
                    self._verify_prep(value, receipts, session)
                value["staleReasons"] = self._stale(value, job_id, session.source_context)
                generations.append(value)
        return {"ok": True, "jobId": job_id, "generations": generations, "page": page, "pageSize": size, "total": total}

    def latest(self, job_id):
        job_id = _job_id(job_id)
        with self.repository.read_session() as session:
            self.jobs.get_posting_snapshot(job_id, connection=session.source_context)
            found = session.latest_accepted(job_id)
            prep = found[0] if found else None
            if prep is not None:
                self._verify_prep(prep, found[1], session)
                prep["staleReasons"] = self._stale(prep, job_id, session.source_context)
        return {"ok": True, "jobId": job_id, "prep": prep}

    def get_generation(self, job_id, generation, connection=None):
        """Public source binding for optional application interview reflections."""
        job_id = _job_id(job_id)
        if type(generation) is not int or generation < 1:
            raise AppError("invalid_generation", "The preparation generation is invalid.")
        with self.repository.read_session(connection) as session:
            found = session.preparation(job_id, generation)
            value = found[0] if found else None
            if value is None or value.get("status") not in {"accepted", "superseded"}:
                raise NotFoundError("The accepted interview preparation was not found.")
            self._verify_prep(value, found[1], session)
            return value

    def delete_job_data(self, job_id, connection=None):
        """Delete only job-owned records within Jobs' reviewed delete transaction.

        The shared gateway retains its independent model/spend audit receipts.
        """
        job_id = _job_id(job_id)
        with self.repository.transaction(connection) as session:
            session.delete_job_data(job_id)

    def provenance(self, job_id, generation):
        job_id = _job_id(job_id)
        with self.repository.read_session() as session:
            found = session.preparation(job_id, generation)
            if not found:
                raise NotFoundError()
            prep, receipts = found
            if prep["status"] in {"accepted", "superseded"}:
                self._verify_prep(prep, receipts, session)
            for provenance in receipts:
                receipt = self.model.receipt(provenance["receipt_id"], connection=session.source_context)
                if not receipt or any(receipt.get(key) != value for key, value in provenance.items()):
                    raise ConflictError("Preparation provenance is unavailable.")
            ids = {item["receipt_id"] for item in receipts}
            bindings = session.determination_bindings(ids)
        return {"ok": True, "jobId": job_id, "generation": generation, "receipts": receipts, "determinations": bindings}

    def notes(self, job_id, query):
        job_id = _job_id(job_id)
        if set(query) - {"questionId", "history", "page", "pageSize"}:
            raise AppError("invalid_note_query", "The note query is invalid.")
        page, size = _pagination(query.get("page", 1), query.get("pageSize", 20))
        question = query.get("questionId")
        history = query.get("history", "false")
        if history not in ("true", "false", True, False) or (history in ("true", True) and not question):
            raise AppError("invalid_note_query", "The note query is invalid.")
        if question and (not isinstance(question, str) or not re.fullmatch(r"[A-Z]+\d{2}", question) or len(question) > 12):
            raise AppError("invalid_note_query", "The note question is invalid.")
        with self.repository.read_session() as session:
            self.jobs.get_posting_snapshot(job_id, connection=session.source_context)
            total, rows = session.notes(job_id, question, history in ("true", True), size, (page - 1) * size)
        return {"ok": True, "jobId": job_id, "notes": rows, "page": page, "pageSize": size, "total": total}

    def save_note(self, job_id, payload):
        job_id = _job_id(job_id)
        allowed = {"questionId", "expectedRevision", "noteText", "factualSupport", "sourceGeneration", "bindings"}
        if not isinstance(payload, dict) or set(payload) - allowed:
            raise AppError("invalid_note", "The interview note is invalid.")
        question_id, revision, text = payload.get("questionId"), payload.get("expectedRevision"), payload.get("noteText")
        support = payload.get("factualSupport", "unverified_user_statement")
        if (type(revision) is not int or revision < 0 or not isinstance(text, str) or len(text) > 20000
                or support not in {"unverified_user_statement", "needs_clarification", "hypothetical"}):
            raise AppError("invalid_note", "The interview note is invalid.")
        if not isinstance(question_id, str) or not re.fullmatch(r"[A-Z]+\d{2}", question_id) or len(question_id) > 12:
            raise AppError("invalid_note", "The interview question is invalid.")
        with self.repository.transaction() as session:
            self.jobs.get_posting_snapshot(job_id, connection=session.source_context)
            current = session.latest_note(job_id, question_id)
            if (current["revision"] if current else 0) != revision:
                raise ConflictError("This interview note has a newer saved revision.", currentNote=current)
            generation = payload.get("sourceGeneration", current["sourceGeneration"] if current else None)
            if generation is not None and (type(generation) is not int or generation < 1):
                raise AppError("invalid_interview_note_source", "The note source is invalid.")
            try:
                question = self.question(question_id)
            except AppError:
                if not current and generation is None:
                    raise
                question = None
            bindings = ({"catalogBinding": question["catalogBinding"], "cardRevision": question["question"]["cardRevision"],
                         "cardDigest": question["question"]["cardDigest"], "contextDigest": None} if question else None)
            if generation is not None:
                saved = session.preparation(job_id, generation)
                prep = saved[0] if saved else None
                context = prep.get("generationContext") if prep else None
                selected = [item for item in (context or {}).get("selectedQuestions", []) if item.get("questionId") == question_id]
                if (not context or context.get("jobContext", {}).get("jobId") != job_id or len(selected) != 1
                        or question_id not in context.get("selectedQuestionIds", []) or selected[0].get("snapshot", {}).get("id") != question_id
                        or selected[0].get("cardRevision") != selected[0]["snapshot"].get("cardRevision")
                        or selected[0].get("cardDigest") != selected[0]["snapshot"].get("cardDigest")):
                    raise AppError("invalid_interview_note_source", "The note source does not identify this question.")
                bindings = {"catalogBinding": context["catalogBinding"], "cardRevision": selected[0]["cardRevision"],
                            "cardDigest": selected[0]["cardDigest"], "contextDigest": context["contextDigest"]}
            claims = payload.get("bindings")
            if claims is not None and (not isinstance(claims, dict) or set(claims) - {"catalogBinding", "cardRevision", "cardDigest", "contextDigest"}
                    or any(value != (bindings or {}).get(key) for key, value in claims.items())):
                raise AppError("invalid_interview_note_bindings", "The note bindings do not match its source.")
            value = {"jobId": job_id, "questionId": question_id, "revision": revision + 1, "noteText": text,
                     "factualSupport": support, "editStatus": "user_edited", "sourceGeneration": generation,
                     "bindings": bindings, "updatedAt": _now()}
            session.save_note(value)
        return {"ok": True, "note": value}
