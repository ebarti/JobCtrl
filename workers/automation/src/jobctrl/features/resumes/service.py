"""Resume lifecycle; canonical business writes use one version-fenced repository."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4
import os
from types import SimpleNamespace

from .domain import (
    ResumeError, assemble, baseline_document, canonical, compose, coverage_manifest, digest, document_lines, dto,
    mechanical_check,
)
from .ports import FitPort, ProfilePort, RendererPort, RequirementsPort, ResumeRepository, SemanticPort


def now():
    return datetime.now(timezone.utc).isoformat()


def current(state):
    return next(row for row in state["revisions"] if row["revision_id"] == state["current_revision"])


def review_schema():
    citation = {"type": "object", "properties": {"source_id": {"type": "string"}, "quote": {"type": "string"}},
                "required": ["source_id", "quote"], "additionalProperties": False}
    finding = {"type": "object", "properties": {"detail": {"type": "string"},
               "citations": {"type": "array", "items": citation, "minItems": 1}},
               "required": ["detail", "citations"], "additionalProperties": False}
    return {"type": "object", "properties": {"verdict": {"enum": ["pass", "findings"]},
            "findings": {"type": "array", "items": finding}}, "required": ["verdict", "findings"],
            "additionalProperties": False}


def validate_model_result(result, sources):
    value = deepcopy(result.value)
    provenance = deepcopy(result.provenance)
    if (not provenance.get("receipt_id") or not provenance.get("provider") or not provenance.get("model")
            or len(provenance.get("input_fingerprint", "")) != 64):
        raise ResumeError("model_provenance_missing")
    inventory = {row["source_id"]: row["text"] for row in sources}
    for finding in value.get("findings", []):
        if not finding.get("detail", "").strip() or not finding.get("citations"):
            raise ResumeError("review_citation_missing")
        for citation in finding["citations"]:
            if (citation.get("source_id") not in inventory or not citation.get("quote", "").strip()
                    or citation["quote"] not in inventory[citation["source_id"]]):
                raise ResumeError("review_citation_invalid")
    if value.get("verdict") not in {"pass", "findings"} or (
        value["verdict"] == "pass" and value.get("findings")
    ) or (value["verdict"] == "findings" and not value.get("findings")):
        raise ResumeError("review_verdict_inconsistent")
    return {"status": value["verdict"], "findings": value["findings"],
            "determination_id": provenance["receipt_id"], "provenance": provenance}


class ResumesService:
    def __init__(self, *, repository: ResumeRepository, profile: ProfilePort, fit: FitPort,
                 requirements: RequirementsPort, renderer: RendererPort, model: SemanticPort | None = None,
                 settings=None, jobs=None, templates=None, artifact_opener=None):
        self.repository = repository
        self.profile = profile
        self.fit = fit
        self.requirements = requirements
        self.renderer = renderer
        self.model = model
        self.settings = settings
        self.jobs = jobs
        self.templates = templates
        self.artifact_opener = artifact_opener

    def get(self, resume_id, *, connection=None):
        state = self.repository.get(resume_id, connection=connection)
        state["composition_freshness"] = self._composition_freshness(current(state), connection=connection)
        if self.jobs is not None:
            job = self.jobs.get_job_snapshots([state["job_id"]], connection=connection, include_deleted=True).get(state["job_id"])
            state["job"] = {"jobId": job["job_id"], "title": job["title"], "company": job["company"],
                            "source": "current_jobs_label"} if job else None
        if state["accepted_revision_id"]:
            revision = next(row for row in state["revisions"] if row["revision_id"] == state["accepted_revision_id"])
            state["accepted_freshness"] = self._accepted_freshness(revision, connection=connection)
        return state

    def list(self, job_id=None):
        states = self.repository.list(job_id=job_id)
        for state in states:
            state["composition_freshness"] = self._composition_freshness(current(state))
        if self.jobs is not None and states:
            ids = list(dict.fromkeys(row["job_id"] for row in states))
            jobs = {}
            for offset in range(0, len(ids), 1000):
                jobs.update(self.jobs.get_job_snapshots(ids[offset:offset + 1000], include_deleted=True))
            for state in states:
                job = jobs.get(state["job_id"])
                state["job"] = {"jobId": job["job_id"], "title": job["title"], "company": job["company"],
                                "source": "current_jobs_label"} if job else None
        return states

    def _composition_freshness(self, revision, connection=None):
        """Inspect source pins without changing a draft, acceptance or model state."""
        reasons = []
        try:
            latest = self._snapshot(revision["profile_snapshot"]["profile_id"], connection)
            if latest["profile_revision"] != revision["profile_revision"]:
                reasons.append("profile_changed")
        except Exception:
            reasons.append("profile_unavailable")
        if revision["mode"] != "baseline_copy":
            if revision["requirements_snapshot"] is None or revision["fit_snapshot"] is None:
                reasons.append("coverage_not_recorded")
            else:
                try:
                    self.requirements.assert_current(revision["requirements_snapshot"], connection=connection)
                except Exception:
                    reasons.append("requirements_changed")
                try:
                    self.fit.assert_current(revision["fit_snapshot"], connection=connection)
                except Exception:
                    reasons.append("fit_coverage_changed")
        return {"current": not reasons, "stale_reasons": reasons, "revision_id": revision["revision_id"]}

    def job_summaries(self, job_ids, connection=None):
        if not isinstance(job_ids, (list, tuple)) or len(job_ids) > 1000 or any(not isinstance(item, str) for item in job_ids):
            raise ResumeError("resume_job_query_too_large")
        result = {ident: {"template": None, "resume_template": None, "resume_id": None, "revision_id": None,
                          "revision_number": None, "accepted_revision_id": None, "acceptance_id": None,
                          "updated_at": None} for ident in job_ids}
        effective = self.templates.effective(connection=connection)["metadata"] if self.templates is not None else None
        accepted_by_job = {}
        for state in self.repository.list_for_jobs(list(dict.fromkeys(job_ids)), connection=connection):
            revision = current(state)
            template = deepcopy((revision.get("template") or {}).get("metadata"))
            template_state = None
            if template:
                template_state = "template_current" if template.get("assignmentSource") == "job_override" or (
                    effective is not None and all(template.get(key) == effective.get(key)
                                                  for key in ("templateId", "templateVersionId", "templateHash"))
                ) else "template_stale"
            acceptance = next((row for row in reversed(state["acceptances"])
                               if row["revision_id"] == state["accepted_revision_id"]), None)
            if acceptance is not None:
                prior = accepted_by_job.get(state["job_id"])
                if prior is None or (acceptance["accepted_at"], acceptance["acceptance_id"]) > (
                    prior[1]["accepted_at"], prior[1]["acceptance_id"]
                ):
                    accepted_by_job[state["job_id"]] = (state["resume_id"], acceptance)
            result[state["job_id"]] = {"template": {**template, "state": template_state, "name": template.get("templateName")} if template else None,
                "resume_template": {"effective": template if template.get("assignmentSource") == "job_override" else effective,
                                    "snapshot": template, "state": template_state,
                                    "reason": "A different default template is selected." if template_state == "template_stale" else None,
                                    "lastRefreshAttempt": None} if template else None,
                "resume_id": state["resume_id"], "revision_id": revision["revision_id"],
                "revision_number": revision["number"], "accepted_revision_id": state["accepted_revision_id"],
                "acceptance_id": acceptance["acceptance_id"] if acceptance else None,
                "review_status": revision["review"]["status"], "mechanical_status": revision["mechanical"]["status"],
                "updated_at": state["updated_at"]}
        for job_id, (accepted_resume_id, acceptance) in accepted_by_job.items():
            result[job_id].update(accepted_resume_id=accepted_resume_id, accepted_revision_id=acceptance["revision_id"],
                                  acceptance_id=acceptance["acceptance_id"])
        return result

    def _snapshot(self, profile_id="default", connection=None):
        return dto(self.profile.snapshot(profile_id, connection=connection))

    @staticmethod
    def _operation(operation_id, payload):
        if operation_id is None:
            return None
        if not isinstance(operation_id, str) or not operation_id.strip() or len(operation_id) > 240:
            raise ResumeError("invalid_resume_operation_id")
        return {"operation_id": operation_id, "input_hash": digest(payload)}

    def _coverage(self, job_id, snapshot, connection=None):
        requirements = dto(self.requirements.get_job_requirements(job_id, connection=connection))
        if requirements.get("stale") is True:
            raise ResumeError("requirements_source_changed")
        coverage = dto(self.fit.coverage_for(
            snapshot["profile_revision"], requirements.get("requirements", []), snapshot["approved_variants"],
            profile_id=snapshot["profile_id"], connection=connection,
        ))
        return requirements, coverage

    def _fence(self, snapshot, requirements, coverage, connection):
        latest = self._snapshot(snapshot["profile_id"], connection)
        if digest(latest) != digest(snapshot):
            raise ResumeError("profile_revision_conflict")
        if requirements is not None:
            self.requirements.assert_current(requirements, connection=connection)
        if coverage is not None:
            self.fit.assert_current(coverage, connection=connection)

    def compose(self, *, job_id, expected_profile_revision, profile_id="default", mode=None,
                resume_id=None, expected_version=None, theme=None, operation_id=None, cancelled=lambda: False,
                template_id=None, template_version=None):
        operation = self._operation(operation_id, {"action": "compose", "job_id": job_id,
                                    "expected_profile_revision": expected_profile_revision, "profile_id": profile_id,
                                    "mode": mode, "resume_id": resume_id, "expected_version": expected_version,
                                    "theme": theme, "template_id": template_id, "template_version": template_version})
        previous = self.repository.operation_result(operation)
        if previous is not None:
            return previous
        if cancelled():
            raise ResumeError("resume_action_cancelled")
        if not isinstance(job_id, str) or not job_id.strip():
            raise ResumeError("job_id_required")
        if self.jobs is not None:
            self.jobs.snapshot(job_id)
        if mode is None:
            saved = self.settings.snapshot().get("resumeMode", "tailored") if self.settings else "tailored"
            mode = "baseline_copy" if saved == "baseline" else "tailored"
        elif mode == "baseline":
            mode = "baseline_copy"
        snapshot = self._snapshot(profile_id)
        if snapshot["profile_revision"] != expected_profile_revision:
            raise ResumeError("profile_revision_conflict")
        requirements, coverage = (None, None) if mode == "baseline_copy" else self._coverage(job_id, snapshot)
        try:
            prepared = compose(snapshot, coverage or {}, mode=mode, cancelled=cancelled)
        except ResumeError as exc:
            if exc.code in {"composition_resource_limit", "resume_action_cancelled"}:
                recorded = self.repository.record_composition_failure(
                    job_id=job_id, profile_id=profile_id, code=exc.code, details=exc.details,
                    resume_id=resume_id, expected_version=expected_version)
                if recorded is not None:
                    exc.details = {**(exc.details or {}), "resume_id": resume_id, "version": recorded["version"]}
            raise
        template = (self.templates.selected(template_id, template_version) if template_id is not None
                    else self.templates.effective()) if self.templates else None
        resolved_theme = {**(template["theme"] if template else {}), **(theme or {})}
        revision = self._revision(snapshot, prepared, requirements, coverage, resolved_theme, template=template)

        def fence(conn):
            if cancelled():
                raise ResumeError("resume_action_cancelled")
            self._fence(snapshot, requirements, coverage, conn)
        if resume_id is None:
            state = {"resume_id": str(uuid4()), "job_id": job_id, "profile_id": profile_id, "version": 1,
                     "created_at": now(), "updated_at": now(), "current_revision": revision["revision_id"],
                     "accepted_revision_id": None, "acceptances": [], "revisions": [revision], "locales": [],
                     "comments": []}
            return self.repository.create(state, event="ResumeComposed", fence=fence, operation=operation)

        def mutate(state, conn):
            if state["job_id"] != job_id or state["profile_id"] != profile_id:
                raise ResumeError("resume_source_identity_mismatch")
            fence(conn)
            revision["number"] = len(state["revisions"]) + 1
            state["revisions"].append(revision)
            state["current_revision"] = revision["revision_id"]
        return self.repository.change(resume_id, expected_version, mutate, event="ResumeComposed", operation=operation)

    def _revision(self, snapshot, prepared, requirements, coverage, theme, *, template=None):
        self.renderer.validate_theme(theme)
        return {"revision_id": str(uuid4()), "number": 1, "created_at": now(),
                "profile_revision": snapshot["profile_revision"], "profile_snapshot": deepcopy(snapshot),
                "requirements_snapshot": deepcopy(requirements), "fit_snapshot": deepcopy(coverage),
                **deepcopy(prepared), "theme": deepcopy(theme), "template": deepcopy(template),
                "renders": [], "render_attempts": [],
                "review": {"status": "not_applicable" if prepared["mode"] == "baseline_copy" else "pending",
                           "reason": "resume_tailoring_disabled" if prepared["mode"] == "baseline_copy" else None,
                           "findings": []}, "review_attempts": [], "edit_draft": None}

    def edit(self, resume_id, *, expected_version, document, selected_variants=None, theme=None,
             plate_document=None):
        if not isinstance(document, dict) or len(canonical(document).encode()) > 2_000_000:
            raise ResumeError("invalid_resume_document")
        if plate_document is not None and (not isinstance(plate_document, list)
                                          or len(canonical(plate_document).encode()) > 2_000_000):
            raise ResumeError("invalid_editor_document")

        def mutate(state, conn):
            previous = current(state)
            snapshot = self._snapshot(state["profile_id"], conn)
            if snapshot["profile_revision"] != previous["profile_revision"]:
                raise ResumeError("profile_revision_conflict")
            selections = deepcopy(selected_variants if selected_variants is not None else previous["selected_variants"])
            check = mechanical_check(snapshot, document, selections)
            manifest = deepcopy(previous["coverage_manifest"])
            if check["status"] != "valid":
                manifest = {"status": "not_assessed", "reason": "unapproved_manual_edits",
                            "requirements": [], "selected_relations": [], "objective": None}
            elif previous["mode"] != "baseline_copy":
                manifest = coverage_manifest(snapshot, previous["fit_snapshot"], selections)
            revision = self._revision(snapshot, {"mode": previous["mode"], "document": deepcopy(document),
                                      "selected_variants": selections, "coverage_manifest": manifest,
                                      "mechanical": check}, previous["requirements_snapshot"], previous["fit_snapshot"],
                                      previous["theme"] if theme is None else theme, template=previous.get("template"))
            revision["number"] = len(state["revisions"]) + 1
            revision["edit_draft"] = {"plate_document": deepcopy(plate_document), "user_authored": True}
            self.renderer.html(document, revision["theme"], plate_document,
                               (revision.get("template") or {}).get("layout"))
            state["revisions"].append(revision)
            state["current_revision"] = revision["revision_id"]
        return self.repository.change(resume_id, expected_version, mutate, event="ResumeEdited")

    def approve_edits(self, resume_id, *, expected_version, user_confirmed=False):
        if user_confirmed is not True:
            raise ResumeError("explicit_wording_approval_required")

        def mutate(state, conn):
            previous = current(state)
            snapshot = self._snapshot(state["profile_id"], conn)
            if snapshot["profile_revision"] != previous["profile_revision"]:
                raise ResumeError("profile_revision_conflict")
            baseline = assemble(snapshot, previous["selected_variants"])
            edited = deepcopy(previous["document"])
            baseline_roles = baseline.get("experience", [])
            edited_roles = edited.get("experience", [])
            if [row.get("id") for row in baseline_roles] != [row.get("id") for row in edited_roles]:
                raise ResumeError("every_baseline_role_required")
            texts = {}
            for original, changed in zip(baseline_roles, edited_roles):
                if [row.get("id") for row in original["bullets"]] != [row.get("id") for row in changed.get("bullets", [])]:
                    raise ResumeError("every_baseline_achievement_required")
                for before, after in zip(original["bullets"], changed["bullets"]):
                    if not isinstance(after.get("text"), str) or not after["text"].strip():
                        raise ResumeError("achievement_wording_required")
                    texts[before["achievement_id"]] = after["text"]
                    # All metadata is restored from the exact existing authority before checking facts.
                    after.clear()
                    after.update(deepcopy(before))
            if edited != baseline:
                raise ResumeError("profile_fact_edit_requires_profile_save")
            selections = []
            for variant in previous["selected_variants"]:
                text = texts[variant["achievement_id"]]
                if text == variant["text"]:
                    selections.append(deepcopy(variant))
                    continue
                approved = self.profile.approve_authored_variant(
                    profile_id=state["profile_id"], expected_profile_revision=snapshot["profile_revision"],
                    achievement_id=variant["achievement_id"], text=text, source_refs=variant["source_refs"],
                    user_confirmed=True, connection=conn,
                )
                selections.append(dto(approved))
                snapshot = self._snapshot(state["profile_id"], conn)
            requirements, coverage = (None, None) if previous["mode"] == "baseline_copy" else self._coverage(
                state["job_id"], snapshot, conn)
            # User-chosen edited wording is retained; no optimizer silently replaces it.
            document = assemble(snapshot, selections)
            manifest = {"status": "not_assessed", "reason": "resume_tailoring_disabled", "requirements": [],
                        "selected_relations": [], "objective": None} if coverage is None else coverage_manifest(
                            snapshot, coverage, selections)
            revision = self._revision(snapshot, {"mode": previous["mode"], "document": document,
                                      "selected_variants": selections, "coverage_manifest": manifest,
                                      "mechanical": mechanical_check(snapshot, document, selections)},
                                      requirements, coverage, previous["theme"], template=previous.get("template"))
            revision["number"] = len(state["revisions"]) + 1
            revision["edit_draft"] = deepcopy(previous["edit_draft"])
            state["revisions"].append(revision)
            state["current_revision"] = revision["revision_id"]
        return self.repository.change(resume_id, expected_version, mutate, event="ResumeEdited")

    async def review(self, resume_id, *, expected_version, operation_id=None):
        operation = self._operation(operation_id, {"action": "review", "resume_id": resume_id,
                                                  "expected_version": expected_version})
        previous = self.repository.operation_result(operation)
        if previous is not None:
            return previous
        state = self.get(resume_id)
        revision = current(state)
        continuing = (revision["review"].get("status") == "running" and
                      revision["review"].get("operation") == operation and operation is not None)
        if state["version"] != expected_version and not continuing:
            raise ResumeError("resume_version_conflict")
        if revision["mode"] == "baseline_copy":
            return state  # This branch cannot call the model, including on explicit review requests.
        if revision["mechanical"]["status"] != "valid":
            raise ResumeError("resume_requires_approved_wording")
        if revision["review_attempts"]:
            if revision["review"]["status"] == "running":
                return self._recover_review(state, revision, operation)
            return state  # One advisory review for this immutable document, never a repair/polish loop.
        snapshot = revision["profile_snapshot"]
        attempt_id = str(uuid4())
        sources = document_lines(revision["document"])
        request = dict(
            operation="resumes.coherence", instructions=(
                "Review this complete assembled resume once for coherence, repeated wording, contradictory "
                "expression and awkward transitions. Return advisory findings with exact source citations. "
                "Do not rescore fit, judge qualifications, demand brevity, omit achievements, rewrite text, "
                "invent claims, or request a polishing/repair loop. All recorded approvals remain user-owned."),
            sources=sources, response_schema=review_schema(),
            context={"resume_id": resume_id, "revision_id": revision["revision_id"],
                     "profile_revision": snapshot["profile_revision"], "document_sha256": digest(revision["document"])},
            prompt_version="resume-coherence-v1", lane="resumes",
        )
        fingerprint = None
        preflight_failure = None
        try:
            if self.model is None:
                raise ResumeError("resume_review_model_unavailable")
            selection = self.model.selection()
            request["model"] = selection["provider"] + ":" + selection["model"]
            fingerprint = self.model.fingerprint(**request)
        except Exception:
            preflight_failure = "resume_review_model_unavailable"

        def reserve(latest, conn):
            self._fence(snapshot, revision["requirements_snapshot"], revision["fit_snapshot"], conn)
            target = current(latest)
            target["review"] = {"status": "running", "findings": [], "attempt_id": attempt_id,
                                "started_at": now(), "advisory": True, "operation": operation,
                                "input_fingerprint": fingerprint, "owner_pid": os.getpid()}
            target["review_attempts"].append(deepcopy(target["review"]))
        reserved = self.repository.change(resume_id, expected_version, reserve, event="ResumeReviewStarted")
        settlement_version = reserved["version"]
        cancelled = False
        try:
            if preflight_failure:
                raise ResumeError(preflight_failure)
            result = await self.model.determine(**request)
            review = validate_model_result(result, sources)
        except asyncio.CancelledError:
            review = {"status": "failed", "findings": [], "failure_code": "coherence_review_cancelled"}
            cancelled = True
        except Exception as exc:
            review = {"status": "timeout" if isinstance(exc, TimeoutError) else "failed", "findings": [],
                      "failure_code": exc.code if isinstance(exc, ResumeError) else "coherence_review_unavailable"}
        review.update(reviewed_at=now(), document_sha256=digest(revision["document"]), advisory=True)

        def mutate(latest, conn):
            self._fence(snapshot, revision["requirements_snapshot"], revision["fit_snapshot"], conn)
            target = current(latest)
            if target["revision_id"] != revision["revision_id"]:
                raise ResumeError("resume_version_conflict")
            target["review"] = deepcopy(review)
            target["review_attempts"][-1] = {**deepcopy(review), "attempt_id": attempt_id}
        result = self.repository.change(resume_id, settlement_version, mutate, event="ResumeReviewed", operation=operation)
        if cancelled:
            raise asyncio.CancelledError()
        return result

    def _recover_review(self, state, revision, operation):
        """Read the gateway receipt after interruption; never repeat the model call."""
        claim = revision["review"]
        receipts = self.model.receipts_for("resumes.coherence", claim["input_fingerprint"]) if (
            self.model is not None and claim.get("input_fingerprint")
        ) else []
        if receipts and receipts[0]["status"] == "running" and receipts[0].get("owner_alive"):
            return state
        if not receipts:
            # A live/unknown owner may still be between claim and gateway admission.
            try:
                os.kill(claim.get("owner_pid", 0), 0)
                return state
            except PermissionError:
                return state
            except ProcessLookupError:
                pass
        if receipts and receipts[0]["status"] == "succeeded":
            receipt = receipts[0]
            provenance = {key: receipt[key] for key in (
                "receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at",
            )}
            try:
                review = validate_model_result(SimpleNamespace(value=receipt["value"], provenance=provenance),
                                               document_lines(revision["document"]))
            except ResumeError as exc:
                review = {"status": "failed", "findings": [], "failure_code": exc.code}
        else:
            review = {"status": "failed", "findings": [], "failure_code": "coherence_review_interrupted",
                      "receipt_id": receipts[0]["receipt_id"] if receipts else None,
                      "provider_outcome": receipts[0]["status"] if receipts else "not_recorded"}
        review.update(reviewed_at=now(), document_sha256=digest(revision["document"]), advisory=True,
                      recovered=True, attempt_id=claim["attempt_id"])

        def mutate(latest, conn):
            target = current(latest)
            if target["revision_id"] != revision["revision_id"] or target["review"]["status"] != "running":
                raise ResumeError("resume_version_conflict")
            target["review"] = deepcopy(review)
            target["review_attempts"][-1] = deepcopy(review)
        return self.repository.change(state["resume_id"], state["version"], mutate,
                                      event="ResumeReviewed", operation=operation)

    def render(self, resume_id, *, expected_version, operation_id=None, cancelled=lambda: False):
        operation = self._operation(operation_id, {"action": "render", "resume_id": resume_id,
                                                  "expected_version": expected_version})
        previous = self.repository.operation_result(operation)
        if previous is not None:
            return previous
        if cancelled():
            raise ResumeError("resume_action_cancelled")
        state = self.get(resume_id)
        if state["version"] != expected_version:
            raise ResumeError("resume_version_conflict")
        revision = current(state)
        snapshot = revision["profile_snapshot"]
        self._fence(snapshot, revision["requirements_snapshot"], revision["fit_snapshot"], None)
        try:
            artifact = self.renderer.render(revision["document"], revision["theme"],
                                            {"resume_id": resume_id, "revision_id": revision["revision_id"],
                                             "plate_document": (revision.get("edit_draft") or {}).get("plate_document"),
                                             "template_layout": (revision.get("template") or {}).get("layout")})
            attempt = {"status": "rendered", "artifact_id": artifact["artifact_id"], "created_at": now()}
        except Exception as exc:
            artifact = None
            attempt = {"status": "failed", "created_at": now(),
                       "failure_code": exc.code if isinstance(exc, ResumeError) else "resume_render_failed",
                       "details": exc.details if isinstance(exc, ResumeError) else None}

        def mutate(latest, conn):
            if cancelled():
                raise ResumeError("resume_action_cancelled")
            self._fence(snapshot, revision["requirements_snapshot"], revision["fit_snapshot"], conn)
            target = current(latest)
            if target["revision_id"] != revision["revision_id"]:
                raise ResumeError("resume_version_conflict")
            target["render_attempts"].append(attempt)
            if artifact:
                target["renders"].append(artifact)
        try:
            return self.repository.change(resume_id, expected_version, mutate, event="ResumeRendered", operation=operation)
        except Exception:
            if artifact is not None:
                self.repository.abandon_file_intent(artifact["artifact_id"])
            raise

    def assign_template(self, resume_id, *, expected_version, template_id, template_version=None):
        if self.templates is None:
            raise ResumeError("resume_templates_unavailable")
        template = self.templates.selected(template_id, template_version)

        def mutate(state, conn):
            previous = current(state)
            if previous["review"]["status"] == "running":
                raise ResumeError("resume_review_running")
            snapshot = previous["profile_snapshot"]
            self._fence(snapshot, previous["requirements_snapshot"], previous["fit_snapshot"], conn)
            prepared = {key: deepcopy(previous[key]) for key in (
                "mode", "document", "selected_variants", "coverage_manifest", "mechanical",
            )}
            revision = self._revision(snapshot, prepared, previous["requirements_snapshot"], previous["fit_snapshot"],
                                      template["theme"], template=template)
            revision["number"] = len(state["revisions"]) + 1
            revision["review"] = {**deepcopy(previous["review"]), "reused_from_revision": previous["revision_id"]}
            revision["review_attempts"] = deepcopy(previous["review_attempts"])
            state["revisions"].append(revision)
            state["current_revision"] = revision["revision_id"]
        return self.repository.change(resume_id, expected_version, mutate, event="ResumeTemplateUpdated")

    def accept(self, resume_id, *, expected_version, override_review=False):
        if type(override_review) is not bool:
            raise ResumeError("explicit_review_override_required")

        def mutate(state, conn):
            revision = current(state)
            snapshot = revision["profile_snapshot"]
            self._fence(snapshot, revision["requirements_snapshot"], revision["fit_snapshot"], conn)
            check = mechanical_check(snapshot, revision["document"], revision["selected_variants"])
            if check["status"] != "valid":
                raise ResumeError("resume_requires_approved_wording")
            if not revision["renders"]:
                raise ResumeError("resume_render_required")
            artifact = revision["renders"][-1]
            if artifact.get("layout_conflicts"):
                raise ResumeError("resume_layout_conflict")
            self.renderer.read_pdf(artifact)
            status = revision["review"]["status"]
            if status not in {"pass", "not_applicable"} and not override_review:
                raise ResumeError("explicit_review_override_required")
            if status in {"pending", "running"}:
                raise ResumeError("resume_review_required")
            acceptance = {"acceptance_id": str(uuid4()), "revision_id": revision["revision_id"],
                          "accepted_at": now(), "review_status": status,
                          "review_override": override_review and status not in {"pass", "not_applicable"},
                          "document_sha256": digest(revision["document"]), "pdf": deepcopy(artifact),
                          "profile_revision": snapshot["profile_revision"],
                          "mechanical": check}
            state["acceptances"].append(acceptance)
            state["accepted_revision_id"] = revision["revision_id"]
        return self.repository.change(resume_id, expected_version, mutate, event="ResumeAccepted")

    def accepted_snapshot(self, job_id, connection=None):
        states = self.repository.list(job_id=job_id, connection=connection)
        candidates = [(acceptance["accepted_at"], state, acceptance)
                      for state in states for acceptance in state["acceptances"]
                      if acceptance["revision_id"] == state["accepted_revision_id"]]
        if not candidates:
            return None
        _, state, acceptance = max(candidates, key=lambda row: (row[0], row[2]["acceptance_id"]))
        revision = next(row for row in state["revisions"] if row["revision_id"] == acceptance["revision_id"])
        return {"resume_id": state["resume_id"], "revision_id": acceptance["revision_id"],
                "revision_number": revision["number"],
                "version": state["version"], "acceptance_id": acceptance["acceptance_id"],
                "accepted_at": acceptance["accepted_at"], "profile_id": state["profile_id"],
                "profile_revision": acceptance["profile_revision"], "job_id": job_id,
                "review_status": acceptance["review_status"], "review_override": acceptance["review_override"],
                "document_sha256": acceptance["document_sha256"], "pdf": deepcopy(acceptance["pdf"]), "status": "accepted",
                "template": deepcopy(revision.get("template")), "composition_mode": revision["mode"],
                "composition_policy": deepcopy(revision["coverage_manifest"].get("objective")),
                "source_freshness": self._accepted_freshness(revision, connection=connection)}

    def _accepted_freshness(self, revision, connection=None):
        """Accepted authority depends on selected sources, not today's whole library."""
        pinned = revision["profile_snapshot"]
        try:
            latest = self._snapshot(pinned["profile_id"], connection)
        except Exception:
            return {"status": "invalid", "failures": ["accepted_profile_unavailable"],
                    "library_outdated": True, "coverage_stale": True}
        failures = []
        approved = {(row["variant_id"], row["revision"]): row for row in latest["approved_variants"]}
        refs = set()
        for variant in revision["selected_variants"]:
            current_variant = approved.get((variant["variant_id"], variant["revision"]))
            if current_variant is None or any(current_variant.get(key) != variant.get(key)
                                               for key in ("achievement_id", "text", "approval_id", "source_refs")):
                failures.append("selected_wording_authority_changed")
            refs.update(item["source_id"] for item in variant["source_refs"])
        raw = pinned["document"]
        personal = raw.get("personal", {})
        old_sources = {row["source_id"]: row for row in pinned.get("evidence_sources", [])}
        new_sources = {row["source_id"]: row for row in latest.get("evidence_sources", [])}

        def recorded_source(*, path=None, role_id=None):
            matches = [row["source_id"] for row in old_sources.values()
                       if (path is not None and row.get("path") == path) or
                       (role_id is not None and row.get("kind") == "role" and row.get("role_id") == role_id)]
            if len(matches) != 1:
                failures.append("selected_fact_source_identity_missing")
            else:
                refs.add(matches[0])

        name_key = "full_name" if personal.get("full_name") else "name"
        website_key = "website_url" if personal.get("website_url") else "portfolio_url"
        for key in (name_key, "address", "city", "postal_code", "country", "phone", "email",
                    website_key, "linkedin_url", "github_url"):
            if personal.get(key):
                recorded_source(path=["personal", key])
        resume = raw.get("resume", raw.get("resume_master", {}))
        if revision["document"].get("summary"):
            recorded_source(path=["resume", "executive_profile"])
        for role in pinned["roles"]:
            recorded_source(role_id=role["role_id"])
        for section in ("education_entries", "skill_categories"):
            for row in resume.get(section, []):
                recorded_source(path=["resume", section, row["id"]])
        for ident in refs:
            previous, actual = old_sources.get(ident), new_sources.get(ident)
            if (previous is None or actual is None or previous["revision"] != actual["revision"]
                    or previous.get("text") != actual.get("text") or
                    actual.get("confirmation") in {"rejected", "disputed", "revoked"}):
                failures.append("selected_fact_or_source_authority_changed")
        coverage_stale = False
        try:
            if revision["requirements_snapshot"] is not None:
                self.requirements.assert_current(revision["requirements_snapshot"], connection=connection)
            if revision["fit_snapshot"] is not None:
                self.fit.assert_current(revision["fit_snapshot"], connection=connection)
        except Exception:
            coverage_stale = True
        return {"status": "invalid" if failures else "current", "failures": sorted(set(failures)),
                "library_outdated": pinned["profile_revision"] != latest["profile_revision"],
                "coverage_stale": coverage_stale,
                "accepted_baseline_profile_revision": pinned["profile_revision"],
                "latest_profile_revision": latest["profile_revision"]}

    def validate_attachment(self, snapshot, connection=None):
        latest = self.accepted_snapshot(snapshot["job_id"], connection=connection)
        # A new draft may change the aggregate version while the accepted source remains exact.
        fields = ("resume_id", "revision_id", "acceptance_id", "profile_revision", "document_sha256", "pdf")
        if latest is None or any(latest[key] != snapshot.get(key) for key in fields):
            raise ResumeError("accepted_resume_changed")
        state = self.get(snapshot["resume_id"], connection=connection)
        revision = next(row for row in state["revisions"] if row["revision_id"] == snapshot["revision_id"])
        if self._accepted_freshness(revision, connection=connection)["status"] != "current":
            raise ResumeError("accepted_resume_source_changed")
        return self.renderer.read_pdf(latest["pdf"])

    def interview_snapshot(self, job_id, connection=None):
        accepted = self.accepted_snapshot(job_id, connection=connection)
        if accepted is None:
            return None
        self.validate_attachment(accepted, connection=connection)
        state = self.get(accepted["resume_id"], connection=connection)
        revision = next(row for row in state["revisions"] if row["revision_id"] == accepted["revision_id"])
        return {"accepted": accepted, "document": deepcopy(revision["document"]),
                "text": "\n".join(row["text"] for row in document_lines(revision["document"]))}

    def assert_interview_current(self, snapshot, connection=None):
        self.validate_attachment(snapshot["accepted"], connection=connection)

    def _artifact(self, state, artifact_id, *, revision_id=None, accepted=False):
        acceptances = {row["pdf"]["artifact_id"] for row in state["acceptances"]}
        candidates = [(revision["revision_id"], artifact, artifact["artifact_id"] in acceptances)
                      for revision in state["revisions"] for artifact in revision["renders"]]
        candidates.extend((row["revision_id"], row["pdf"], True) for row in state["acceptances"])
        candidates.extend((locale["locale_id"], artifact, bool(locale.get("accepted_at")))
                          for locale in state["locales"] for artifact in locale["renders"])
        for source_id, artifact, was_accepted in candidates:
            if artifact["artifact_id"] == artifact_id and (revision_id is None or revision_id == source_id):
                if accepted and not was_accepted:
                    raise ResumeError("accepted_resume_artifact_not_found")
                return deepcopy(artifact)
        raise ResumeError("resume_artifact_not_found")

    def open_artifact(self, resume_id, artifact_id):
        state = self.get(resume_id)
        artifact = self._artifact(state, artifact_id)
        self.renderer.read_pdf(artifact)
        if self.artifact_opener is None:
            raise ResumeError("resume_artifact_open_unavailable")
        self.artifact_opener.open(artifact["path"])
        return {"ok": True, "artifactId": artifact_id, "sha256": artifact["sha256"], "status": "requested"}

    def export(self, resume_id, *, format="pdf", accepted=False, revision_id=None, artifact_id=None):
        state = self.get(resume_id)
        if artifact_id is not None:
            if format != "pdf":
                raise ResumeError("registered_artifact_format_is_pdf")
            artifact = self._artifact(state, artifact_id, revision_id=revision_id, accepted=accepted)
            return self.renderer.read_pdf(artifact), "application/pdf", ".pdf"
        revision_id = revision_id or (state["accepted_revision_id"] if accepted else state["current_revision"])
        if not revision_id:
            raise ResumeError("accepted_resume_not_found")
        revision = next((row for row in state["revisions"] if row["revision_id"] == revision_id), None)
        if revision is None:
            raise ResumeError("resume_revision_not_found")
        if accepted:
            acceptance = next((row for row in reversed(state["acceptances"]) if row["revision_id"] == revision_id), None)
            if acceptance is None:
                raise ResumeError("accepted_resume_not_found")
            revision = {**revision, "renders": [deepcopy(acceptance["pdf"])]}
        return self.renderer.export(revision, format)

    def digest_summary(self):
        return {"reviewNeededMaterials": sum(
            1 for state in self.list() if current(state)["mechanical"]["status"] != "valid" or
            current(state)["review"]["status"] not in {"pass", "not_applicable"} or
            state["accepted_revision_id"] != state["current_revision"]
        )}

    def delete_job_data(self, job_id, connection=None):
        self.repository.delete_job_data(job_id, connection=connection)

    def after_job_deletion(self, job_ids):
        """Only committed deletion journals authorize owned file retirement."""
        return self.cleanup_retired_artifacts(job_ids, deletion_committed=True)

    def recover_orphaned_files(self):
        jobs = self.repository.orphan_job_ids()
        return self.cleanup_retired_artifacts(jobs) if jobs else None

    def cleanup_retired_artifacts(self, job_ids, *, deletion_committed=False):
        if not isinstance(job_ids, (list, tuple)) or len(job_ids) > 1000 or any(not isinstance(item, str) for item in job_ids):
            raise ResumeError("invalid_retirement_selection")
        retired = 0
        failures = []
        for row in self.repository.retirement_candidates(list(dict.fromkeys(job_ids))):
            claim = self.repository.claim_retirement(row["artifact_id"])
            if claim is None:
                continue
            try:
                self.renderer.retire_pdf(claim["artifact"], claim["claim_name"], allow_partial=claim["allow_partial"])
                self.repository.finish_retirement(row["artifact_id"])
                retired += 1
            except Exception as exc:
                code = exc.code if isinstance(exc, ResumeError) else "resume_artifact_retirement_unavailable"
                self.repository.finish_retirement(row["artifact_id"], failure_code=code)
                failures.append({"artifact_id": row["artifact_id"], "failure_code": code})
        summary = self.repository.retirement_summary(list(dict.fromkeys(job_ids)))
        return {"feature": "resumes", "status": "pending" if summary["pending"] else "complete",
                "deletionCommitted": deletion_committed, "retired_this_attempt": retired, **summary, "failures": failures}

    async def preview_profile(self, *, snapshot, format="html", style=None, template_text=None):
        from asyncio import to_thread
        snapshot = dto(snapshot)
        document = baseline_document(snapshot)
        saved = style or snapshot.get("style", {})
        saved_template_text = template_text if template_text is not None else snapshot.get("template_text")
        theme = {"pageSize": "letter" if saved.get("paper_size") == "letterpaper" else "a4",
                 "fontFamily": "serif" if saved.get("font_family") == "roman" else "sans",
                 "alignment": "left" if saved.get("body_alignment") == "left" else "justified"}
        template = self.templates.effective() if self.templates else None
        if saved_template_text and saved_template_text.strip() != "{{ personal_data }}\n\n{{ resume_body }}" and (
            template is None or template["metadata"]["assignmentSource"] == "built_in"
        ):
            raise ResumeError("legacy_resume_template_requires_selection",
                              "The saved legacy template text is retained. Select a structured resume template before previewing it.")
        if template:
            theme = ({**template["theme"], **theme} if style is not None or
                     template["metadata"]["assignmentSource"] == "built_in" else {**theme, **template["theme"]})
        if format == "html":
            return self.renderer.html(document, theme, template_layout=template["layout"] if template else None)
        if format != "pdf":
            raise ResumeError("unsupported_resume_export")
        artifact = await to_thread(self.renderer.render, document, theme,
                                   {"resume_id": "profile-preview", "revision_id": str(uuid4()),
                                    "template_layout": template["layout"] if template else None, "ephemeral": True})
        return artifact["data"]

    def comment(self, resume_id, *, expected_version, body, source_id=None, thread_id=None, decision=None):
        if not isinstance(body, str) or len(body) > 10_000 or not body.strip():
            raise ResumeError("invalid_resume_comment")

        def mutate(state, conn):
            revision = current(state)
            source_ids = {row["source_id"] for row in document_lines(revision["document"])}
            if source_id is not None and source_id not in source_ids:
                raise ResumeError("foreign_comment_source_id")
            if thread_id is None:
                state["comments"].append({"thread_id": str(uuid4()), "source_id": source_id,
                                          "revision_id": revision["revision_id"], "body": body,
                                          "status": "open", "replies": [], "created_at": now()})
            else:
                thread = next((row for row in state["comments"] if row["thread_id"] == thread_id), None)
                if thread is None or decision not in {None, "resolved", "open", "dismissed"}:
                    raise ResumeError("invalid_comment_thread")
                thread["replies"].append({"body": body, "created_at": now(), "revision_id": revision["revision_id"]})
                if decision:
                    thread["status"] = decision
        return self.repository.change(resume_id, expected_version, mutate, event="ResumeCommentUpdated")
