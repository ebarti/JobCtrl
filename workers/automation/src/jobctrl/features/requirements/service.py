"""Requirement application actions shared by HTTP, CLI and durable workers."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from contextlib import AsyncExitStack

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.model_custody import current_owner, model_call_scope

from .domain import (
    CONTRACT_VERSION, EXTRACTION_INSTRUCTION, MEANING_KEYS,
    OCCURRENCE_CORRECTION_INSTRUCTION, OccurrenceCorrectionSelection,
    ExtractedRequirement, ModelCallBudget, RequirementError, RevisionDecision,
    bind_extraction, bind_occurrence_correction, canonical_json, current_contract, fingerprint, meaning_data, validate_citations,
    validate_extraction_selection,
)
from .ports import PostingReader, RequirementModel, RequirementStore
from .normalization import CatalogNormalizationService
from .cohort import RequirementsCohortService
from .cohort_transport import REFRESH_CATALOG_PROMPT_VERSION
from .catalog_transport import TABLE_CATALOG_PROMPT_VERSION
from .normalization_demand_choices import CITED_OCCURRENCE_PROMPT, DEMAND_CHOICE_PROMPT
from .extraction_wire import (EXTRACTION_VERSION, LEGACY_EXTRACTION_VERSION,
                              V6_EXTRACTION_VERSION, V7_EXTRACTION_VERSION, V8_EXTRACTION_VERSION, extraction_wire)
from .normalization_domain import (BACKGROUND_COHORT_PROMPT, BACKGROUND_MANUAL_PROMPT, BACKGROUND_REFRESH_PROMPT,
                                   NORMALIZATION_PROMPT_VERSION, NORMALIZATION_VERSION)


MAX_POSTING_BYTES = 192000
MAX_NEW_MODEL_CALLS_PER_REFRESH = 2


def _never_cancelled() -> bool:
    return False


class RequirementsService(RequirementsCohortService, CatalogNormalizationService):
    refresh_catalog_prompt_version = CITED_OCCURRENCE_PROMPT
    cohort_catalog_prompt_version = BACKGROUND_COHORT_PROMPT

    def admit_manual_catalog_prompt(self, operation_id, connection):
        self.store.admit_catalog_prompt(operation_id, BACKGROUND_MANUAL_PROMPT, connection)

    def admitted_catalog_prompt(self, operation_id):
        return self.store.catalog_prompt(operation_id)

    def __init__(self, store: RequirementStore, jobs: PostingReader, model: RequirementModel):
        self.store = store
        self.jobs = jobs
        self.model = model
        self.meaning_deletion_ports = []

    def register_meaning_deletion_port(self, callback):
        if callback not in self.meaning_deletion_ports:
            self.meaning_deletion_ports.append(callback)

    def find_job_requirements(self, job_id: str, connection=None) -> dict | None:
        """Read optional acceptance without turning a missing Job into absence.

        First-use HTTP reads may honestly return no artifact. Application
        consumers that require acceptance keep using get_job_requirements.
        """
        if connection is None:
            with self.store.read_session() as connection:
                return self.find_job_requirements(job_id, connection)
        self.jobs.get_posting_snapshot(job_id, connection=connection)
        if self.store.current_snapshot(job_id, connection) is None:
            return None
        return self.get_job_requirements(job_id, connection)

    def _block_attempt(self, attempt_id, failure, default_code):
        code = getattr(failure, "code", default_code)
        details = None
        if isinstance(failure, RequirementError) and code == "requirements_catalog_unavailable":
            # The Requirements owner provides only accounting and catalog-shape metadata.
            details = failure.details
        elif isinstance(failure, (AppError, RequirementError)) and failure.details and failure.details.get("receiptId"):
            # The receipt identifies the rejected call without exposing its content.
            details = {"receiptId": failure.details["receiptId"]}
        self.store.finish_attempt(attempt_id, "cancelled" if code == "cancelled" else "blocked", code, details=details)

    def latest_job_attempt(self, job_id: str) -> dict | None:
        with self.store.read_session() as connection:
            self.jobs.get_posting_snapshot(job_id, connection=connection)
            return self._latest_attempt(job_id, connection)

    def _latest_attempt(self, job_id, connection):
        attempt = self.store.latest_attempt(job_id, connection)
        if not attempt or attempt["state"] != "blocked" or "failure_details" in attempt:
            return attempt
        text = self.jobs.posting_text_at_revision(job_id, attempt["posting_revision"], connection)
        if text:
            receipt_id = self.model.refused_extraction_receipt(
                attempt["attempt_id"], self._content_source(text)["source_id"], attempt["failure_code"], connection,
            )
            if receipt_id:
                attempt["failure_details"] = {"receiptId": receipt_id}
        return attempt

    def get_job_requirements(self, job_id: str, connection=None) -> dict:
        if connection is None:
            with self.store.read_session() as connection:
                return self.get_job_requirements(job_id, connection)
        snapshot = self.store.current_snapshot(job_id, connection)
        if snapshot is None:
            raise NotFoundError("This job has no accepted requirements yet.")
        stale = False
        try:
            self.assert_current(snapshot, connection)
        except (ConflictError, NotFoundError):
            stale = True
        reasons = ["contract_changed"] if not current_contract(snapshot) else (["source_or_requirement_changed"] if stale else [])
        if current_contract(snapshot) and snapshot.get("normalization_version") != NORMALIZATION_VERSION:
            stale = True
            reasons = ["consolidation_required"]
        return {**snapshot, "stale": stale, "stale_reasons": reasons, "latest_attempt": self._latest_attempt(job_id, connection)}

    def job_bindings(self, job_ids, connection=None, *, postings=None, scored=None) -> dict:
        """Bounded list-query authority without per-job feature/private reads.

        Accepted artifacts only are returned. Callers may provide the Jobs
        public snapshot map already read in their same transaction; otherwise
        this owner obtains one batch through that public port.
        """
        if (
            not isinstance(job_ids, (list, tuple)) or len(job_ids) > 1000
            or any(not isinstance(ident, str) or not ident or len(ident) > 240 for ident in job_ids)
        ):
            raise AppError("invalid_job_selection", "Select at most 1,000 saved job IDs.")
        identifiers = list(dict.fromkeys(job_ids))
        if connection is None:
            with self.store.read_session() as connection:
                return self.job_bindings(identifiers, connection, postings=postings, scored=scored)
        if not identifiers:
            return {}
        if postings is None:
            postings = self.jobs.get_job_snapshots(identifiers, connection=connection)
        if not isinstance(postings, dict):
            raise AppError("invalid_posting_snapshots", "Requirement bindings need the public posting snapshot map.")
        bindings = self.store.job_bindings(identifiers, connection, scored=scored)
        for job_id, binding in bindings.items():
            posting = postings.get(job_id)
            available = isinstance(posting, dict) and posting.get("job_id") == job_id and not posting.get("deleted")
            binding["posting_available"] = available
            if not available or posting["source_hash"] != binding["posting_hash"]:
                binding["stale"] = True
                binding["stale_reasons"].append("posting_changed_or_unavailable")
        return bindings

    def assert_current(self, snapshot: dict, connection=None) -> None:
        if connection is None:
            with self.store.read_session() as connection:
                return self.assert_current(snapshot, connection)
        self.store.assert_snapshot_current(snapshot, connection)
        if snapshot.get("normalization_version") != NORMALIZATION_VERSION:
            raise ConflictError("The accepted requirement snapshot needs complete catalog consolidation.", reason="consolidation_required")
        # A restored immutable posting can have a newer revision with the
        # exact original source hash. New extraction writes still pin the head.
        posting = self.jobs.get_posting_snapshot(snapshot["job_id"], connection=connection)
        if posting["source_hash"] != snapshot["posting_hash"]:
            raise ConflictError("The posting source has changed.")

    def get_requirement(self, requirement_id, revision=None, connection=None):
        if connection is None:
            with self.store.read_session() as connection:
                return self.get_requirement(requirement_id, revision, connection)
        meaning = self.store.get_meaning(requirement_id, revision, connection)
        head = self.store.get_meaning(requirement_id, connection=connection)
        reasons = [] if current_contract(meaning) else ["contract_changed"]
        root_id = self.store.alias_root(requirement_id, connection)
        if root_id != requirement_id:
            reasons.append("requirement_consolidated")
        if meaning["revision"] != head["revision"]:
            reasons.append("requirement_revised")
        return {**meaning, "stale": bool(reasons), "stale_reasons": reasons, "resolved_requirement_id": root_id}

    def catalog_snapshot(self, connection=None) -> dict:
        """Complete canonical semantic inventory from one transaction.

        Returned values are detached JSON DTOs. The immutable canonical
        revisions remain owned by Requirements; callers retain the exact DTO
        for source binding and pass it unchanged to assert_current_catalog.
        """
        epoch, meanings = self.store.catalog_snapshot(connection)
        requirements = [{key: row[key] for key in (
            "requirement_id", "revision", *MEANING_KEYS,
        )} for row in meanings]
        return {"contract_version": CONTRACT_VERSION, "catalog_revision": epoch, "requirements": requirements,
                "meanings_fingerprint": fingerprint(requirements)}

    def assert_current_catalog(self, snapshot: dict, connection=None) -> None:
        """Fence the entire captured catalog in the caller's write transaction."""
        if connection is None:
            with self.store.read_session() as connection:
                return self.assert_current_catalog(snapshot, connection)
        current = self.catalog_snapshot(connection)
        try:
            matches = isinstance(snapshot, dict) and canonical_json(snapshot) == canonical_json(current)
        except (TypeError, ValueError):
            matches = False
        if not matches:
            raise ConflictError("The canonical requirement catalog changed or its snapshot is invalid.")

    def catalog(self, *, limit=50, offset=0, query=""):
        with self.store.read_session() as connection:
            epoch, meanings = self._library_meanings(connection)
            normalization = self.normalization_status(connection)
            aliases = self.store.aliases(connection)
        # q is a literal user filter, never equivalence or novelty authority.
        if query:
            meanings = [row for row in meanings if query.casefold() in canonical_json({key: row[key] for key in MEANING_KEYS}).casefold()]
        return {"contract_version": CONTRACT_VERSION, "catalog_revision": epoch,
                "total": len(meanings), "requirements": meanings[offset:offset + limit],
                "normalization": normalization, "aliases": aliases}

    def _active_library_requirement_ids(self, connection, requirement_id=None):
        roots = self.store.accepted_occurrence_jobs(connection, requirement_id)
        job_ids = list(dict.fromkeys(job_id for _, job_id in roots))
        live_job_ids = set()
        for offset in range(0, len(job_ids), 1000):
            postings = self.jobs.get_job_snapshots(job_ids[offset:offset + 1000], connection=connection)
            live_job_ids.update(job_id for job_id, posting in postings.items() if not posting.get("deleted"))
        return {ident for ident, job_id in roots if job_id in live_job_ids}

    def library_catalog_snapshot(self, connection=None) -> dict:
        """Active library membership, distinct from the retained semantic catalog.

        A nondeleted Job's accepted occurrence is the only membership root.
        Hidden Jobs still count. Historical Fit/Profile relations retain their
        identities without keeping a deleted-only meaning in this projection.
        """
        if connection is None:
            with self.store.read_session() as connection:
                return self.library_catalog_snapshot(connection)
        epoch, meanings = self._library_meanings(connection)
        demand_catalog = self.demand_catalog_snapshot(connection, active_only=True)
        return {"contract_version": CONTRACT_VERSION, "catalog_revision": epoch,
                "requirements": [{key: meaning[key] for key in ("requirement_id", "revision", *MEANING_KEYS)} for meaning in meanings],
                "normalization": self.normalization_status(connection),
                "normalization_version": NORMALIZATION_VERSION,
                "aliases": self.store.aliases(connection),
                "demands": demand_catalog["demands"],
                "consolidation_required_job_ids": demand_catalog["consolidation_required_job_ids"]}

    def _library_meanings(self, connection):
        epoch, meanings = self.store.catalog_snapshot(connection)
        active_ids = self._active_library_requirement_ids(connection)
        return epoch, [meaning for meaning in meanings if meaning["requirement_id"] in active_ids]

    def index_status(self):
        return self.store.index_status()

    def rebuild_index(self, *, expected_catalog_revision):
        if type(expected_catalog_revision) is not int or expected_catalog_revision < 0:
            raise RequirementError("invalid_revision")
        return self.store.rebuild_index(expected_catalog_revision)

    def delete_job_data(self, job_id, connection=None):
        if connection is None or not connection.in_transaction:
            raise RuntimeError("Permanent requirement deletion requires Jobs' write transaction.")
        orphaned_ids = self.store.orphaned_meaning_ids_for_job(job_id, connection)
        if orphaned_ids:
            for callback in self.meaning_deletion_ports:
                callback(orphaned_ids, connection=connection)
        self.store.delete_job_data(job_id, connection)
        self.store.delete_meanings(orphaned_ids, job_id, connection)

    def requirement_detail(self, requirement_id, *, revision=None, limit=100, offset=0):
        with self.store.read_session() as connection:
            requested_id = requirement_id
            if revision is None:
                requirement_id = self.store.alias_root(requirement_id, connection)
            meaning = self.get_requirement(requirement_id, revision, connection=connection)
            head = self.store.get_meaning(requirement_id, connection=connection)
            active = requirement_id in self._active_library_requirement_ids(connection, requirement_id)
            return {**meaning, "requested_requirement_id": requested_id, "resolved_requirement_id": requirement_id,
                "current_revision": head["revision"], "active_in_library": active, "occurrences": self.store.occurrences(
                requirement_id, limit=limit, offset=offset, connection=connection,
            )}

    def requirement_history(self, requirement_id, *, kind="revisions", limit=50, offset=0):
        if kind not in {"revisions", "occurrences"}:
            raise AppError("invalid_history_kind", "Choose revisions or occurrences.")
        with self.store.read_session() as connection:
            head = self.store.get_meaning(requirement_id, connection=connection)
            resolved_id = self.store.alias_root(requirement_id, connection)
            page = self.store.history(requirement_id, kind=kind, limit=limit, offset=offset, connection=connection)
            active = requirement_id in self._active_library_requirement_ids(connection, requirement_id)
            postings = self.jobs.get_job_snapshots(list(dict.fromkeys(row["job_id"] for row in page["rows"])),
                                                   connection=connection) if kind == "occurrences" else {}
            for row in page["rows"]:
                reasons = [] if current_contract(row) else ["contract_changed"]
                if row["requirement_id"] != resolved_id:
                    reasons.append("requirement_consolidated")
                recorded = row["revision"] if kind == "revisions" else row["requirement_revision"]
                if recorded != head["revision"]:
                    reasons.append("requirement_revised")
                if kind == "occurrences":
                    if not row["accepted"]:
                        reasons.append("snapshot_superseded")
                    posting = postings.get(row["job_id"])
                    if (posting is None or posting.get("deleted")
                            or posting.get("revision") != row["posting_revision"]
                            or posting.get("source_hash") != row["source_hash"]):
                        reasons.append("posting_changed_or_unavailable")
                row.update(current=not reasons, stale_reasons=reasons)
            return {"requirement_id": requirement_id, "resolved_requirement_id": resolved_id,
                    "current_revision": head["revision"], "active_in_library": active,
                    "kind": kind, "limit": limit, "offset": offset, **page}

    async def correct_occurrences(
        self, job_id: str, *, expected_revision: int, expected_posting_revision: int, corrections: list[dict],
        cancelled: Callable[[], bool] = _never_cancelled, operation_id: str | None = None,
        heartbeat: Callable[[dict], object] | None = None, catalog_prompt_version=BACKGROUND_MANUAL_PROMPT,
    ) -> dict:
        """Replace exactly the selected interpretations, preserving all other authority."""
        self._validate_versions(expected_posting_revision, expected_revision)
        if (not isinstance(corrections, list) or not 1 <= len(corrections) <= 20
                or any(not isinstance(row, dict) or set(row) != {"occurrence_id", "reason"}
                       or not isinstance(row["occurrence_id"], str) or not 0 < len(row["occurrence_id"]) <= 120
                       or not isinstance(row["reason"], str) or not 0 < len(row["reason"].strip()) <= 2000
                       for row in corrections)):
            raise RequirementError("invalid_correction_selection")
        identifiers = [row["occurrence_id"] for row in corrections]
        if len(set(identifiers)) != len(identifiers):
            raise RequirementError("invalid_correction_selection")
        action_fingerprint = fingerprint({"contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION, "normalization_prompt_version": catalog_prompt_version, "operation": "correct_occurrences",
            "job_id": job_id, "expected_revision": expected_revision,
            "expected_posting_revision": expected_posting_revision, "corrections": corrections})
        replay = self._replay_snapshot(operation_id, action_fingerprint)
        if replay is not None:
            return replay
        posting = self.jobs.assert_posting_current(job_id, expected_posting_revision)
        previous = self.store.current_snapshot(job_id)
        if previous is None:
            raise NotFoundError("This job has no accepted requirements yet.")
        if previous["revision"] != expected_revision:
            raise ConflictError("The accepted requirement snapshot changed.")
        with self.store.read_session() as connection:
            self.store.assert_snapshot_current(previous, connection)
        if previous.get("status") != "complete" or previous.get("language", {}).get("classification") != "english":
            raise RequirementError("unsupported_language")
        originals = {row["occurrence_id"]: row for row in previous["requirements"]}
        if not set(identifiers).issubset(originals):
            raise NotFoundError("Select reusable occurrences from the accepted snapshot.")
        source_text = posting.get("text") or posting.get("description") or ""
        if not source_text.strip() or len(source_text.encode()) > MAX_POSTING_BYTES:
            raise RequirementError("posting_source_too_large" if source_text.strip() else "posting_source_missing")
        source_binding = self._content_source(source_text)
        source_id = source_binding["source_id"]
        attempt_id = operation_id or str(uuid.uuid4())
        self.store.start_attempt({"attempt_id": attempt_id, "job_id": job_id, "posting_revision": posting["revision"],
                                  "expected_revision": expected_revision, "input_fingerprint": action_fingerprint})
        budget = ModelCallBudget(action_fingerprint, MAX_NEW_MODEL_CALLS_PER_REFRESH, reserve=lambda value, connection:
            self.store.reserve_correction_call(attempt_id, value, MAX_NEW_MODEL_CALLS_PER_REFRESH,
                                               posting, self.jobs.assert_posting_current, connection=connection),
            check_reservation=lambda value: self.store.check_correction_call(attempt_id, value, MAX_NEW_MODEL_CALLS_PER_REFRESH))
        try:
            self._check_cancel(cancelled)
            context = {"posting": self._posting_identity(posting), "operation_id": attempt_id,
                       "expected_snapshot": {"revision": previous["revision"], "fingerprint": fingerprint(previous)},
                       "selected": [originals[ident] for ident in identifiers], "corrections": corrections}
            selection, correction_receipt = await self.model.determine(
                kind="requirements.correct_occurrences", schema=OccurrenceCorrectionSelection,
                prompt_version="requirements-v2-occurrence-correction-v1", instruction=OCCURRENCE_CORRECTION_INSTRUCTION,
                sources=[{"source_id": source_id, "text": source_text}], context=context, entity_id=job_id,
                validate=lambda value: bind_occurrence_correction(value, source_id=source_id, text=source_text,
                                                                  occurrence_ids=identifiers),
                budget=budget, publication_posting=self._publication_identity(posting), source_binding=source_binding,
            )
            corrected = bind_occurrence_correction(selection, source_id=source_id, text=source_text,
                                                    occurrence_ids=identifiers)
            reasons = {row["occurrence_id"]: row["reason"] for row in corrections}
            reasons = {row["occurrence_id"]: row["reason"] for row in corrections}
            quote_ids = {quote.evidence_id: "correction:" + fingerprint({"receipt": correction_receipt["receipt_id"],
                         "evidence_id": quote.evidence_id}) for quote in corrected.quotes}
            selected = {row.local_id: row for row in corrected.requirements}
            occurrences = []
            for original in previous["requirements"]:
                ident = original["occurrence_id"]
                if ident not in selected:
                    occurrences.append(dict(original))
                    continue
                row = self._proposed_occurrence(selected[ident], posting, correction_receipt, source_binding, attempt_id)
                row.update(local_id=original["local_id"],
                    previous_occurrence_id=ident,
                    evidence_refs=[quote_ids[ref] for ref in row["evidence_refs"]],
                    correction_determination_id=correction_receipt["receipt_id"])
                row["provenance"].update(semantic_stage="occurrence_correction", origin=original["provenance"],
                    correction={"reason": reasons[ident], "previous_occurrence_id": ident,
                        "receipt": correction_receipt, "result_fingerprint": correction_receipt["accepted_result_fingerprint"],
                        "evidence_ids": quote_ids})
                occurrences.append(row)
            proposal = {**previous, "requirements": occurrences, "_attempt_id": attempt_id,
                "quotes": [*previous["quotes"], *[{**quote.model_dump(), "evidence_id": quote_ids[quote.evidence_id]}
                    for quote in corrected.quotes]],
                "correction_history": [*previous.get("correction_history", []), {"contract_version": CONTRACT_VERSION,
                    "previous_revision": previous["revision"], "corrections": corrections, "receipt": correction_receipt,
                    "result_fingerprint": correction_receipt["accepted_result_fingerprint"]}]}
            with self.store.read_session() as connection:
                self.store.assert_snapshot_current(previous, connection)
                captured = self.store.normalization_capture(connection)
            await self._normalize_catalog(captured=captured, proposals={job_id: proposal}, incoming=self._incoming_members(occurrences),
                operation_id=attempt_id, action_fingerprint=action_fingerprint, cancelled=cancelled,
                heartbeat=heartbeat, budget=budget, guidance={"occurrence_corrections": corrections}, prompt_version=catalog_prompt_version)
            return self.get_job_requirements(job_id)
        except asyncio.CancelledError:
            self.store.finish_attempt(attempt_id, "cancelled", "cancelled")
            raise
        except Exception as failure:
            self._block_attempt(attempt_id, failure, "requirements_correction_failed")
            raise

    async def correct_binding(
        self, job_id: str, occurrence_id: str, *, expected_revision: int,
        expected_posting_revision: int, requirement_id: str, requirement_revision: int,
        reason: str, cancelled: Callable[[], bool] = _never_cancelled,
        operation_id: str | None = None, catalog_prompt_version=BACKGROUND_MANUAL_PROMPT,
    ) -> dict:
        """Validate an explicit binding inside the mandatory complete partition."""
        self._validate_versions(expected_posting_revision, expected_revision)
        if not isinstance(reason, str) or not 0 < len(reason.strip()) <= 2000:
            raise RequirementError("correction_reason_required")
        if type(requirement_revision) is not int or requirement_revision < 1:
            raise RequirementError("invalid_revision")
        action_fingerprint = fingerprint({"contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION, "normalization_prompt_version": catalog_prompt_version,
            "operation": "correct_binding", "job_id": job_id, "occurrence_id": occurrence_id,
            "expected_revision": expected_revision, "expected_posting_revision": expected_posting_revision,
            "requirement_id": requirement_id, "requirement_revision": requirement_revision, "reason": reason})
        replay = self._replay_snapshot(operation_id, action_fingerprint)
        if replay is not None:
            return replay
        posting = self.jobs.assert_posting_current(job_id, expected_posting_revision)
        with self.store.read_session() as connection:
            previous = self.store.current_snapshot(job_id, connection)
            if previous is None:
                raise NotFoundError("This job has no accepted requirements yet.")
            if previous["revision"] != expected_revision:
                raise ConflictError("The accepted requirement snapshot changed.")
            self.store.assert_snapshot_current(previous, connection)
            captured = self.store.normalization_capture(connection)
        original = next((row for row in previous["requirements"] if row["occurrence_id"] == occurrence_id), None)
        if original is None:
            raise NotFoundError("The occurrence is not in the accepted job snapshot.")
        target = next((row for row in captured["roots"] if row["requirement_id"] == requirement_id), None)
        if target is None or target["revision"] != requirement_revision:
            raise ConflictError("The selected requirement revision changed.")
        if target["category"] != original["category"]:
            raise RequirementError("requirement_category_mismatch")
        attempt_id = operation_id or str(uuid.uuid4())
        self.store.start_attempt({"attempt_id": attempt_id, "job_id": job_id, "posting_revision": posting["revision"],
                                  "expected_revision": expected_revision, "input_fingerprint": action_fingerprint})
        try:
            extracted = ExtractedRequirement.model_validate({key: original[key] for key in (
                "local_id", "category", "name", "definition", "basis", "rationale", "source_note", "evidence_refs", "spans")})
            source_binding = self._content_source(posting.get("text") or posting.get("description") or "")
            replacement = self._proposed_occurrence(extracted, posting, original["provenance"]["extraction"],
                source_binding, attempt_id, member_id="incoming:" + occurrence_id)
            replacement["correction"] = {"reason": reason, "previous_requirement_id": original["requirement_id"],
                                         "previous_requirement_revision": original["requirement_revision"]}
            replacement["previous_occurrence_id"] = occurrence_id
            proposal = {**previous, "requirements": [replacement if row["occurrence_id"] == occurrence_id else dict(row)
                for row in previous["requirements"]], "_attempt_id": attempt_id}
            await self._normalize_catalog(captured=captured, proposals={job_id: proposal}, incoming=self._incoming_members([replacement]),
                operation_id=attempt_id, action_fingerprint=action_fingerprint, cancelled=cancelled,
                guidance={"binding_correction": {"reason": reason, "occurrence_id": occurrence_id,
                    "requested_requirement_id": requirement_id, "authority": "The requested target is a user-selected hypothesis, not semantic proof."}},
                required_bindings={replacement["_normalization_member_id"]: requirement_id}, prompt_version=catalog_prompt_version)
            return self.get_job_requirements(job_id)
        except asyncio.CancelledError:
            self.store.finish_attempt(attempt_id, "cancelled", "cancelled")
            raise
        except Exception as failure:
            self._block_attempt(attempt_id, failure, "requirements_correction_failed")
            raise

    async def revise_requirement(
        self, requirement_id: str, *, expected_revision: int, job_id: str,
        expected_posting_revision: int, proposed: ExtractedRequirement, reason: str,
        cancelled: Callable[[], bool] = _never_cancelled,
        operation_id: str | None = None,
        heartbeat: Callable[[dict], object] | None = None, catalog_prompt_version=BACKGROUND_MANUAL_PROMPT,
    ) -> dict:
        """Correct a canonical meaning without rewriting its previous revision.

        A semantic correction invalidates consumers through the new canonical
        revision. Old accepted artifacts remain readable, with explicit stale
        status, until their owners successfully refresh them.
        """
        self._validate_versions(expected_posting_revision, expected_revision)
        if not reason.strip():
            raise RequirementError("correction_reason_required")
        action_fingerprint = fingerprint({"contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION, "normalization_prompt_version": catalog_prompt_version, "operation": "revise", "requirement_id": requirement_id,
                                          "expected_revision": expected_revision, "job_id": job_id,
                                          "expected_posting_revision": expected_posting_revision,
                                          "proposed": proposed.model_dump(), "reason": reason})
        self._validate_operation_id(operation_id)
        if operation_id is not None:
            accepted = self.store.accepted_revision_action(operation_id, action_fingerprint)
            if accepted is not None:
                bound_posting = accepted["provenance"]["posting"]
                try:
                    self.jobs.assert_posting_current(bound_posting["job_id"], bound_posting["revision"], bound_posting["source_hash"])
                except (ConflictError, NotFoundError):
                    accepted["stale"] = True
                return accepted
        posting = self.jobs.assert_posting_current(job_id, expected_posting_revision)
        source_text = posting.get("text") or posting.get("description") or ""
        source_id = self._model_source_id(posting)
        for span in proposed.spans:
            if span.end <= span.start or source_text[span.start:span.end] != span.quote:
                raise RequirementError("source_span_invalid")
        epoch, catalog = self.store.catalog_snapshot()
        current = next((row for row in catalog if row["requirement_id"] == requirement_id), None)
        if current is None:
            raise NotFoundError("The requirement does not exist.")
        if current["revision"] != expected_revision:
            raise ConflictError("The canonical requirement changed.")
        proposed_id = f"proposed-revision:{requirement_id}:{expected_revision + 1}"
        source_map = {source_id: source_text, proposed_id: canonical_json(meaning_data(proposed))}

        def validate_revision(result):
            validate_citations(result.citations, source_map, {source_id, proposed_id})
            if result.support != "supported":
                raise RequirementError("unsupported_requirement_revision")

        self._check_cancel(cancelled)
        budget = ModelCallBudget(action_fingerprint, MAX_NEW_MODEL_CALLS_PER_REFRESH)
        _, correction_receipt = await self.model.determine(
            kind="requirements.revise", schema=RevisionDecision, prompt_version="requirements-v2-revision-v5",
            instruction=(EXTRACTION_INSTRUCTION + "\nFor this canonical correction, apply the same in-scope "
                         "skill/professional_experience rules and exclusions to the proposed meaning. Assess only "
                         "whether the complete proposed meaning is supported. Do not extract another inventory. "
                         "Preserve source alternatives. The previous catalog meaning and correction reason are "
                         "context, never factual authority. Return only RevisionDecision with citations to both "
                         "posting and proposed meaning; use unsupported or uncertain when appropriate."),
            sources=[{"source_id": ident, "text": text} for ident, text in source_map.items()],
            context={"posting": self._posting_identity(posting), "previous": {key: current[key] for key in (
                "requirement_id", "revision", *MEANING_KEYS,
            )}, "reason": reason},
            entity_id=requirement_id, validate=validate_revision, budget=budget,
        )
        with self.store.read_session() as connection:
            captured = self.store.normalization_capture(connection)
        if captured["catalog_revision"] != epoch:
            raise RequirementError("catalog_changed")
        attempt_id = operation_id or str(uuid.uuid4())
        report = await self._normalize_catalog(captured=captured, proposals={}, incoming=[], operation_id=attempt_id,
            action_fingerprint=action_fingerprint, cancelled=cancelled, heartbeat=heartbeat, budget=budget,
            source_posting=posting, prompt_version=catalog_prompt_version,
            guidance={"canonical_correction": {"requirement_id": requirement_id, "proposed": proposed.model_dump(),
                "reason": reason, "support_receipt": correction_receipt,
                "authority": "Review this source-checked correction while normalizing the complete catalog; preserve each job's own demand."}},
            revision_action={"operation_id": attempt_id, "input_fingerprint": action_fingerprint, "requirement_id": requirement_id})
        return self.get_requirement(report["mapping"][requirement_id])

    @staticmethod
    def _validate_versions(expected_posting_revision, expected_revision):
        if (
            type(expected_posting_revision) is not int or expected_posting_revision < 1
            or type(expected_revision) is not int or expected_revision < 0
        ):
            raise RequirementError("invalid_revision")

    @staticmethod
    def _validate_operation_id(operation_id):
        if operation_id is not None and (not isinstance(operation_id, str) or not 0 < len(operation_id) <= 240):
            raise RequirementError("invalid_operation_id")

    def _replay_snapshot(self, operation_id, action_fingerprint):
        self._validate_operation_id(operation_id)
        if operation_id is None:
            return None
        accepted = self.store.accepted_action(operation_id, action_fingerprint)
        if accepted is None:
            return None
        # Preserve the exact accepted action result and label any successor
        # source/meaning honestly. Never rerun inference after a committed action.
        try:
            self.assert_current(accepted)
            stale = False
        except (ConflictError, NotFoundError):
            stale = True
        return {**accepted, "stale": stale, "stale_reasons": ["source_or_requirement_changed"] if stale else [],
                "latest_attempt": self.latest_job_attempt(accepted["job_id"]), "reused_action": True}

    async def refresh(
        self, job_id: str, *, expected_posting_revision: int, expected_revision: int,
        force: bool = False, cancelled: Callable[[], bool] = _never_cancelled,
        heartbeat: Callable[[dict], object] | None = None,
        operation_id: str | None = None, catalog_prompt_version: str | None = CITED_OCCURRENCE_PROMPT,
    ) -> dict:
        self._validate_versions(expected_posting_revision, expected_revision)
        if type(force) is not bool:
            raise RequirementError("invalid_force")
        self._validate_operation_id(operation_id)
        # Queued predecessor actions and preparation runs have no catalog transport pin.
        if catalog_prompt_version is None:
            catalog_prompt_version = NORMALIZATION_PROMPT_VERSION
        if catalog_prompt_version not in (NORMALIZATION_PROMPT_VERSION, REFRESH_CATALOG_PROMPT_VERSION, TABLE_CATALOG_PROMPT_VERSION,
                                          BACKGROUND_MANUAL_PROMPT, BACKGROUND_REFRESH_PROMPT, DEMAND_CHOICE_PROMPT, CITED_OCCURRENCE_PROMPT):
            raise RequirementError("requirements_citation_wire_changed")
        request = {
            "contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION, "normalization_prompt_version": catalog_prompt_version, "operation": "refresh", "job_id": job_id, "expected_posting_revision": expected_posting_revision,
            "expected_revision": expected_revision, "force": force,
        }
        # v5 refresh attempts predate an explicit extraction version in their fingerprint.
        legacy_fingerprint = fingerprint(request)
        v6_fingerprint = fingerprint({**request, "extraction_version": V6_EXTRACTION_VERSION})
        v7_fingerprint = fingerprint({**request, "extraction_version": V7_EXTRACTION_VERSION})
        v8_fingerprint = fingerprint({**request, "extraction_version": V8_EXTRACTION_VERSION})
        retained = self.store.attempt_fingerprint(operation_id) if operation_id else None
        if retained == legacy_fingerprint:
            version, action_fingerprint = LEGACY_EXTRACTION_VERSION, legacy_fingerprint
        elif retained == v6_fingerprint:
            version, action_fingerprint = V6_EXTRACTION_VERSION, v6_fingerprint
        elif retained == v7_fingerprint:
            version, action_fingerprint = V7_EXTRACTION_VERSION, v7_fingerprint
        elif retained == v8_fingerprint:
            version, action_fingerprint = V8_EXTRACTION_VERSION, v8_fingerprint
        else:
            version = EXTRACTION_VERSION
            action_fingerprint = fingerprint({**request, "extraction_version": version})
        schema, instruction = extraction_wire(version)
        replay = self._replay_snapshot(operation_id, action_fingerprint)
        if replay is not None:
            return replay
        posting = self.jobs.assert_posting_current(job_id, expected_posting_revision)
        previous = self.store.current_snapshot(job_id)
        if (previous["revision"] if previous else 0) != expected_revision:
            raise ConflictError("The accepted requirement snapshot changed.")
        if previous is not None and not force:
            current = self.get_job_requirements(job_id)
            if not current["stale"]:
                return current
        source_text = posting.get("text") or posting.get("description") or ""
        source_binding = self._content_source(source_text)
        source_id = source_binding["source_id"]
        attempt_id = operation_id or str(uuid.uuid4())
        # A force action deliberately asks for new authority, but retries of
        # that same durable action must reuse a successfully settled receipt.
        refresh_binding = {"operation_id": attempt_id} if force else None
        self.store.start_attempt({
            "attempt_id": attempt_id, "job_id": job_id, "posting_revision": posting["revision"],
            "expected_revision": expected_revision,
            "input_fingerprint": action_fingerprint,
        })
        try:
            if not isinstance(source_text, str) or not source_text.strip():
                raise RequirementError("posting_source_missing")
            if len(source_text.encode()) > MAX_POSTING_BYTES:
                raise RequirementError("posting_source_too_large")
            sources = [{"source_id": source_id, "text": source_text}]
            self._check_cancel(cancelled)
            budget = ModelCallBudget(fingerprint({"action": action_fingerprint, "posting": self._posting_identity(posting)}),
                                     MAX_NEW_MODEL_CALLS_PER_REFRESH)
            extraction_keys = [f"requirements.extract:{version}:{source_id}"] if not force else []
            async with AsyncExitStack() as stack:
                if extraction_keys and current_owner() is None:
                    stack.enter_context(model_call_scope(f"requirements.extract:{attempt_id}", allow_settled_replacement=True))
                await stack.enter_async_context(self.model.coordinate_work(extraction_keys, cancelled))
                work = stack.enter_context(self.model.share_receipt(extraction_keys))
                selection, extraction_receipt = await self.model.determine(
                    kind="requirements.extract", schema=schema, prompt_version=version,
                    instruction=instruction, sources=sources,
                    context={"contract_version": CONTRACT_VERSION, "posting_content": source_binding, "refresh_binding": refresh_binding}, entity_id=None,
                    validate=lambda result: validate_extraction_selection(result, source_id=source_id, text=source_text),
                    budget=budget, publication_posting=self._publication_identity(posting), source_binding=source_binding,
                )
                if work is not None:
                    work.used(extraction_receipt["receipt_id"])
            extraction = bind_extraction(selection, source_id=source_id, text=source_text)
            catalog_keys = ["requirements.catalog"] if extraction.requirements else []
            async with self.model.coordinate_work(catalog_keys, cancelled):
                await self._normalize_extraction(extraction, posting=posting, expected_revision=expected_revision,
                    extraction_receipt=extraction_receipt, source_binding=source_binding, operation_id=attempt_id,
                    action_fingerprint=action_fingerprint, budget=budget, cancelled=cancelled, heartbeat=heartbeat,
                    prompt_version=catalog_prompt_version)
            return self.get_job_requirements(job_id)
        except asyncio.CancelledError:
            self.store.finish_attempt(attempt_id, "cancelled", "cancelled")
            raise
        except Exception as failure:
            self._block_attempt(attempt_id, failure, "requirements_refresh_failed")
            raise

    @classmethod
    def _extraction_fields(cls, extraction, posting, receipt, source_binding):
        quotes = {quote.evidence_id: quote for quote in extraction.quotes}
        fields = {
            "status": extraction.status, "language": extraction.language.model_dump(),
            "quotes": [quote.model_dump() for quote in extraction.quotes], "unresolved": [],
            "extraction_provenance": receipt,
        }
        for field, category in (("education", "education"), ("languages", "language")):
            direct = []
            for index, item in enumerate(getattr(extraction, field)):
                value = item.model_dump()
                identity = fingerprint({
                    "contract_version": CONTRACT_VERSION, "posting": cls._publication_identity(posting),
                    "field": field, "index": index, "value": value,
                })
                direct.append({
                    "contract_version": CONTRACT_VERSION,
                    "requirement_id": f"{CONTRACT_VERSION}:direct:{identity}", "revision": 1,
                    "category": category, **value,
                    "job_id": posting["job_id"], "posting_revision": posting["revision"],
                    "source_id": posting["source_id"], "source_revision": posting["source_revision"],
                    "source_hash": posting["source_hash"], "model_source_id": source_binding["source_id"],
                    "spans": [{key: getattr(quotes[ident], key) for key in ("start", "end", "quote")}
                              for ident in item.evidence_refs],
                    "extraction_determination_id": receipt["receipt_id"],
                    "provenance": {"extraction": receipt, "field": field, "field_index": index},
                })
            fields[field] = direct
        return fields

    @staticmethod
    def _catalog_source(candidate):
        # The complete accepted meaning and its original source interpretation
        # enter matching. Recorded evidence is data, never another model call.
        provenance = candidate["provenance"]
        return {**{key: candidate[key] for key in MEANING_KEYS},
                "original": provenance["original"], "spans": provenance["spans"]}

    @staticmethod
    def _posting_identity(posting):
        return {**RequirementsService._publication_identity(posting),
                "model_source_id": RequirementsService._model_source_id(posting)}

    @staticmethod
    def _publication_identity(posting):
        return {key: posting[key] for key in ("job_id", "revision", "source_id", "source_revision", "source_hash")}

    @staticmethod
    def _model_source_id(posting):
        # Authored/provider source labels are data. They cannot alias a
        # canonical candidate or catalog inventory in a model request.
        return f"posting:{posting['job_id']}:{posting['revision']}:{posting['source_hash']}"

    @staticmethod
    def _content_source(text):
        # Exact full text is the entire semantic posting input to extraction.
        # No whitespace normalization, excerpting, or semantic matching occurs.
        text_fingerprint = fingerprint(text)
        return {"version": 2, "contract_version": CONTRACT_VERSION, "source_id": f"posting-content:requirements-v2:{text_fingerprint}",
                "text_fingerprint": text_fingerprint}

    @staticmethod
    def _check_cancel(cancelled):
        if cancelled():
            raise RequirementError("cancelled")
