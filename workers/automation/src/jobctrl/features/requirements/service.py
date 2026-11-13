"""Requirement application actions shared by HTTP, CLI and durable workers."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .domain import (
    CATALOG_MATCHING_INSTRUCTION, COMPARISON_INSTRUCTION, CONTRACT_VERSION, EXTRACTION_INSTRUCTION, MEANING_KEYS,
    CatalogMatching, Comparison, ExtractedRequirement, ExtractionSelection, ModelCallBudget, RequirementError, RevisionDecision,
    bind_extraction, canonical_json, current_contract, fingerprint, meaning_data, now, validate_catalog_matching, validate_citations,
    validate_comparison, validate_extraction_selection,
)
from .ports import PostingReader, RequirementModel, RequirementStore


MAX_POSTING_BYTES = 192000
MAX_CONSOLIDATION_ATTEMPTS = 4
MAX_NEW_MODEL_CALLS_PER_REFRESH = 1 + MAX_CONSOLIDATION_ATTEMPTS


def _never_cancelled() -> bool:
    return False


class RequirementsService:
    def __init__(self, store: RequirementStore, jobs: PostingReader, model: RequirementModel):
        self.store = store
        self.jobs = jobs
        self.model = model

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
        return {**snapshot, "stale": stale, "stale_reasons": reasons, "latest_attempt": self.store.latest_attempt(job_id, connection)}

    def job_bindings(self, job_ids, connection=None, *, postings=None) -> dict:
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
                return self.job_bindings(identifiers, connection, postings=postings)
        if not identifiers:
            return {}
        if postings is None:
            postings = self.jobs.get_job_snapshots(identifiers, connection=connection)
        if not isinstance(postings, dict):
            raise AppError("invalid_posting_snapshots", "Requirement bindings need the public posting snapshot map.")
        bindings = self.store.job_bindings(identifiers, connection)
        for job_id, binding in bindings.items():
            posting = postings.get(job_id)
            if (
                not isinstance(posting, dict) or posting.get("job_id") != job_id or posting.get("deleted")
                or posting.get("revision") != binding["posting_revision"] or posting.get("source_hash") != binding["posting_hash"]
            ):
                binding["stale"] = True
                binding["stale_reasons"].append("posting_changed_or_unavailable")
        return bindings

    def assert_current(self, snapshot: dict, connection=None) -> None:
        if connection is None:
            with self.store.read_session() as connection:
                return self.assert_current(snapshot, connection)
        self.store.assert_snapshot_current(snapshot, connection)
        self.jobs.assert_posting_current(
            snapshot["job_id"], snapshot["posting_revision"], snapshot["posting_hash"], connection=connection,
        )

    def get_requirement(self, requirement_id, revision=None, connection=None):
        if connection is None:
            with self.store.read_session() as connection:
                return self.get_requirement(requirement_id, revision, connection)
        meaning = self.store.get_meaning(requirement_id, revision, connection)
        head = self.store.get_meaning(requirement_id, connection=connection)
        reasons = [] if current_contract(meaning) else ["contract_changed"]
        if meaning["revision"] != head["revision"]:
            reasons.append("requirement_revised")
        return {**meaning, "stale": bool(reasons), "stale_reasons": reasons}

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
        return self.store.catalog(limit=limit, offset=offset, query=query)

    def index_status(self):
        return self.store.index_status()

    def rebuild_index(self, *, expected_catalog_revision):
        if type(expected_catalog_revision) is not int or expected_catalog_revision < 0:
            raise RequirementError("invalid_revision")
        return self.store.rebuild_index(expected_catalog_revision)

    def delete_job_data(self, job_id, connection=None):
        self.store.delete_job_data(job_id, connection)

    def requirement_detail(self, requirement_id, *, revision=None, limit=100, offset=0):
        with self.store.read_session() as connection:
            meaning = self.get_requirement(requirement_id, revision, connection=connection)
            head = self.store.get_meaning(requirement_id, connection=connection)
            return {**meaning, "current_revision": head["revision"], "occurrences": self.store.occurrences(
                requirement_id, limit=limit, offset=offset, connection=connection,
            )}

    def requirement_history(self, requirement_id, *, kind="revisions", limit=50, offset=0):
        if kind not in {"revisions", "occurrences"}:
            raise AppError("invalid_history_kind", "Choose revisions or occurrences.")
        with self.store.read_session() as connection:
            head = self.store.get_meaning(requirement_id, connection=connection)
            page = self.store.history(requirement_id, kind=kind, limit=limit, offset=offset, connection=connection)
            postings = self.jobs.get_job_snapshots(list(dict.fromkeys(row["job_id"] for row in page["rows"])),
                                                   connection=connection) if kind == "occurrences" else {}
            for row in page["rows"]:
                reasons = [] if current_contract(row) else ["contract_changed"]
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
            return {"requirement_id": requirement_id, "current_revision": head["revision"],
                    "kind": kind, "limit": limit, "offset": offset, **page}

    async def correct_binding(
        self, job_id: str, occurrence_id: str, *, expected_revision: int,
        expected_posting_revision: int, requirement_id: str, requirement_revision: int,
        reason: str, cancelled: Callable[[], bool] = _never_cancelled,
        operation_id: str | None = None,
    ) -> dict:
        """Record an explicit, source-checked correction as a new snapshot.

        Existing occurrences and accepted snapshots remain immutable. The
        independent model checks the chosen target rather than trusting a UI ID
        as equivalence authority, and publication fences source/catalog versions.
        """
        self._validate_versions(expected_posting_revision, expected_revision)
        if not isinstance(reason, str) or not 0 < len(reason.strip()) <= 2000:
            raise RequirementError("correction_reason_required")
        if type(requirement_revision) is not int or requirement_revision < 1:
            raise RequirementError("invalid_revision")
        action_fingerprint = fingerprint({"contract_version": CONTRACT_VERSION, "operation": "correct_binding", "job_id": job_id,
                                          "posting_revision": expected_posting_revision, "expected_revision": expected_revision,
                                          "occurrence_id": occurrence_id, "target": [requirement_id, requirement_revision], "reason": reason})
        replay = self._replay_snapshot(operation_id, action_fingerprint)
        if replay is not None:
            return replay
        posting = self.jobs.assert_posting_current(job_id, expected_posting_revision)
        previous = self.get_job_requirements(job_id)
        if previous["revision"] != expected_revision or previous["stale"]:
            raise ConflictError("Refresh changed requirements before correcting their binding.")
        original = next((row for row in previous["requirements"] if row["occurrence_id"] == occurrence_id), None)
        if original is None:
            raise NotFoundError("The occurrence is not in the accepted job snapshot.")
        epoch, catalog = self.store.catalog_snapshot()
        target = next((row for row in catalog if row["requirement_id"] == requirement_id), None)
        if target is None or target["revision"] != requirement_revision:
            raise ConflictError("The selected requirement revision changed.")
        if target["category"] != original["category"]:
            raise RequirementError("requirement_category_mismatch")
        source_text = posting.get("text") or posting.get("description") or ""
        source_id = self._model_source_id(posting)
        canonical_id = f"requirement:{requirement_id}:{requirement_revision}"
        source_map = {source_id: source_text, canonical_id: canonical_json(self._catalog_source(target))}
        attempt_id = operation_id or str(uuid.uuid4())
        self.store.start_attempt({"attempt_id": attempt_id, "job_id": job_id,
                                  "posting_revision": posting["revision"], "expected_revision": expected_revision,
                                  "input_fingerprint": action_fingerprint})
        try:
            self._check_cancel(cancelled)
            comparison, receipt = await self.model.determine(
                kind="requirements.correct_binding", schema=Comparison,
                prompt_version="requirements-v2-binding-correction-v1", instruction=COMPARISON_INSTRUCTION,
                sources=[{"source_id": ident, "text": text} for ident, text in source_map.items()],
                context={"posting": self._posting_identity(posting), "incoming": {key: original[key] for key in (
                    "category", "name", "definition", "basis", "rationale", "source_note", "spans",
                )},
                         "catalog_revision": epoch,
                         "candidates": [{"requirement_id": requirement_id, "revision": requirement_revision}],
                         "user_correction": {"reason": reason, "from_requirement_id": original["requirement_id"]}},
                entity_id=job_id,
                validate=lambda result: validate_comparison(result, candidates=[target], sources=source_map, incoming=source_id),
            )
            if comparison.decisions[0].relation != "equivalent":
                raise RequirementError("binding_not_equivalent")
            occurrences = []
            for row in previous["requirements"]:
                revised = {**row, "occurrence_id": str(uuid.uuid4()), "previous_occurrence_id": row["occurrence_id"]}
                if row["occurrence_id"] == occurrence_id:
                    revised.update({
                        "requirement_id": requirement_id, "requirement_revision": requirement_revision,
                        "revision": requirement_revision,
                        "canonical": {key: target[key] for key in MEANING_KEYS},
                        "equivalence_determination_ids": [receipt["receipt_id"]],
                        "correction": {"reason": reason, "previous_requirement_id": original["requirement_id"],
                                       "previous_requirement_revision": original["requirement_revision"], "provenance": receipt},
                    })
                occurrences.append(revised)
            self.store.publish(
                posting=posting, expected_revision=expected_revision, catalog_revision=epoch,
                meanings=[], occurrences=occurrences, extraction_id=previous["extraction_determination_id"],
                attempt_id=attempt_id, posting_guard=self.jobs.assert_posting_current, cancelled=cancelled,
                extraction={key: previous[key] for key in ("status", "language", "quotes", "education", "languages", "unresolved", "extraction_provenance")},
                event_type="RequirementBindingCorrected",
            )
            return self.get_job_requirements(job_id)
        except asyncio.CancelledError:
            self.store.finish_attempt(attempt_id, "cancelled", "cancelled")
            raise
        except Exception as failure:
            code = getattr(failure, "code", "requirements_correction_failed")
            self.store.finish_attempt(attempt_id, "cancelled" if code == "cancelled" else "blocked", code)
            raise

    async def revise_requirement(
        self, requirement_id: str, *, expected_revision: int, job_id: str,
        expected_posting_revision: int, proposed: ExtractedRequirement, reason: str,
        cancelled: Callable[[], bool] = _never_cancelled,
        operation_id: str | None = None,
        heartbeat: Callable[[dict], object] | None = None,
    ) -> dict:
        """Correct a canonical meaning without rewriting its previous revision.

        A semantic correction invalidates consumers through the new canonical
        revision. Old accepted artifacts remain readable, with explicit stale
        status, until their owners successfully refresh them.
        """
        self._validate_versions(expected_posting_revision, expected_revision)
        if not reason.strip():
            raise RequirementError("correction_reason_required")
        action_fingerprint = fingerprint({"contract_version": CONTRACT_VERSION, "operation": "revise", "requirement_id": requirement_id,
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
            kind="requirements.revise", schema=RevisionDecision, prompt_version="requirements-v2-revision-v1",
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
        resolved, receipts, fresh = await self._resolve(
            proposed, posting=posting, source_text=source_text, catalog=catalog, epoch=epoch,
            extraction_receipt=correction_receipt, cancelled=cancelled, budget=budget, heartbeat=heartbeat,
        )
        if not fresh and resolved["requirement_id"] != requirement_id:
            raise RequirementError("equivalent_requirement_already_exists")
        revised = {
            "requirement_id": requirement_id, "revision": expected_revision + 1, **meaning_data(proposed),
            "created_at": now(), "provenance": {
                "posting": self._posting_identity(posting), "spans": [span.model_dump() for span in proposed.spans],
                "original": proposed.model_dump(exclude={"spans"}),
                "correction": correction_receipt, "resolution": receipts, "reason": reason,
                "previous_revision": expected_revision,
                "catalog_matching": resolved["provenance"].get("catalog_matching") if fresh else None,
            },
        }
        return self.store.revise_meaning(
            revised=revised, expected_revision=expected_revision, catalog_revision=epoch,
            posting=posting, posting_guard=self.jobs.assert_posting_current, cancelled=cancelled,
            operation_id=operation_id, input_fingerprint=action_fingerprint,
        )

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
                "latest_attempt": self.store.latest_attempt(accepted["job_id"]), "reused_action": True}

    async def refresh(
        self, job_id: str, *, expected_posting_revision: int, expected_revision: int,
        force: bool = False, cancelled: Callable[[], bool] = _never_cancelled,
        heartbeat: Callable[[dict], object] | None = None,
        operation_id: str | None = None,
    ) -> dict:
        self._validate_versions(expected_posting_revision, expected_revision)
        if type(force) is not bool:
            raise RequirementError("invalid_force")
        action_fingerprint = fingerprint({
            "contract_version": CONTRACT_VERSION, "operation": "refresh", "job_id": job_id, "expected_posting_revision": expected_posting_revision,
            "expected_revision": expected_revision, "force": force,
        })
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
            selection, extraction_receipt = await self.model.determine(
                kind="requirements.extract", schema=ExtractionSelection, prompt_version="requirements-v2-extract-v1-content-bound",
                instruction=EXTRACTION_INSTRUCTION, sources=sources,
                context={"contract_version": CONTRACT_VERSION, "posting_content": source_binding, "refresh_binding": refresh_binding}, entity_id=None,
                validate=lambda result: validate_extraction_selection(result, source_id=source_id, text=source_text),
                budget=budget, publication_posting=self._publication_identity(posting), source_binding=source_binding,
            )
            extraction = bind_extraction(selection, source_id=source_id, text=source_text)
            extraction_id = extraction_receipt["receipt_id"]
            for consolidation_attempt in range(MAX_CONSOLIDATION_ATTEMPTS):
                self._check_cancel(cancelled)
                epoch, catalog = self.store.catalog_snapshot()
                try:
                    new_meanings, occurrences = await self._resolve_inventory(
                        extraction, posting=posting, source_text=source_text, catalog=catalog, epoch=epoch,
                        extraction_receipt=extraction_receipt, budget=budget, cancelled=cancelled, heartbeat=heartbeat,
                        source_binding=source_binding, refresh_binding=refresh_binding,
                    )
                    self.store.publish(
                        posting=posting, expected_revision=expected_revision, catalog_revision=epoch,
                        meanings=new_meanings, occurrences=occurrences, extraction_id=extraction_id,
                        attempt_id=attempt_id, posting_guard=self.jobs.assert_posting_current, cancelled=cancelled,
                        extraction=self._extraction_fields(extraction, posting, extraction_receipt, source_binding),
                    )
                    return self.get_job_requirements(job_id)
                except RequirementError as failure:
                    if failure.code != "catalog_changed" or consolidation_attempt + 1 == MAX_CONSOLIDATION_ATTEMPTS:
                        raise
                    # An independent discovery won publication. Recheck its
                    # catalog with fresh model judgments before writing any ID.
                    self.jobs.assert_posting_current(job_id, posting["revision"], posting["source_hash"])
            raise RequirementError("catalog_changed")
        except asyncio.CancelledError:
            self.store.finish_attempt(attempt_id, "cancelled", "cancelled")
            raise
        except Exception as failure:
            code = getattr(failure, "code", "requirements_refresh_failed")
            state = "cancelled" if code == "cancelled" else "blocked"
            self.store.finish_attempt(attempt_id, state, code)
            raise

    async def _resolve_inventory(self, extraction, *, posting, source_text, catalog, epoch,
                                 extraction_receipt, budget, cancelled, heartbeat, source_binding=None, refresh_binding=None):
        if not extraction.requirements:
            return [], []
        matches, receipt, inventory = await self._match_catalog(
            extraction.requirements, posting=posting, source_text=source_text, catalog=catalog, epoch=epoch,
            cancelled=cancelled, budget=budget, heartbeat=heartbeat,
            source_binding=source_binding, refresh_binding=refresh_binding,
        )
        new_meanings = []
        occurrences = []
        resolved = {}
        candidates = {(row["requirement_id"], row["revision"]): row for row in catalog}
        decisions = {row.local_id: row for row in matches.decisions}
        for extracted in extraction.requirements:
            self._check_cancel(cancelled)
            decision = decisions[extracted.local_id]
            if decision.verdict == "new":
                meaning = self._new_meaning(extracted, posting, extraction_receipt, receipt, inventory)
                new_meanings.append(meaning)
            elif decision.equivalent_local_id is not None:
                meaning = resolved[decision.equivalent_local_id]
            else:
                meaning = candidates[(decision.requirement_id, decision.requirement_revision)]
            resolved[extracted.local_id] = meaning
            occurrences.append({
                "occurrence_id": str(uuid.uuid4()), "requirement_id": meaning["requirement_id"],
                "requirement_revision": meaning["revision"], "revision": meaning["revision"],
                "job_id": posting["job_id"], "posting_revision": posting["revision"],
                "contract_version": CONTRACT_VERSION,
                **extracted.model_dump(exclude={"spans"}),
                "canonical": {key: meaning[key] for key in MEANING_KEYS},
                "source_id": posting["source_id"], "model_source_id": source_binding["source_id"] if source_binding else self._model_source_id(posting),
                "source_revision": posting["source_revision"], "source_hash": posting["source_hash"],
                "spans": [span.model_dump() for span in extracted.spans],
                "extraction_determination_id": extraction_receipt["receipt_id"],
                "equivalence_determination_ids": [receipt["receipt_id"]],
                "provenance": {"extraction": extraction_receipt, "resolution": [receipt],
                               "catalog_matching": inventory, "matching_local_id": extracted.local_id},
            })
        return new_meanings, occurrences

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

    async def _match_catalog(self, incoming, *, posting, source_text, catalog, epoch, cancelled,
                             budget=None, heartbeat=None, source_binding=None, refresh_binding=None):
        self._check_cancel(cancelled)
        source_id = source_binding["source_id"] if source_binding else self._model_source_id(posting)
        candidate_keys = [(row["requirement_id"], row["revision"]) for row in catalog]
        if len(candidate_keys) != len(set(candidate_keys)):
            raise RequirementError("catalog_snapshot_invalid")
        inventory = {
            "contract_version": CONTRACT_VERSION, "catalog_revision": epoch, "candidate_count": len(catalog),
            "candidate_set_fingerprint": fingerprint(sorted(candidate_keys)),
            "meanings_fingerprint": fingerprint([{
                "requirement_id": row["requirement_id"], "revision": row["revision"],
                "meaning": self._catalog_source(row),
            } for row in catalog]),
        }
        inventory_id = f"catalog-inventory:{fingerprint(inventory)}"
        source_map = {source_id: source_text, inventory_id: canonical_json(inventory)}
        incoming_source_ids = {}
        incoming_binding = {"posting_content": source_binding,
                            "inventory": [row.model_dump() for row in incoming]} if source_binding else None
        for extracted in incoming:
            identity = ({"input": incoming_binding, "local_id": extracted.local_id} if source_binding
                        else {"posting": self._posting_identity(posting), "local_id": extracted.local_id})
            incoming_id = f"incoming:{fingerprint(identity)}"
            incoming_source_ids[extracted.local_id] = incoming_id
            source_map[incoming_id] = canonical_json(extracted.model_dump())
        for candidate in catalog:
            source_map[f"requirement:{candidate['requirement_id']}:{candidate['revision']}"] = canonical_json(
                self._catalog_source(candidate),
            )
        if heartbeat:
            heartbeat({"phase": "requirements", "catalog_revision": epoch, "candidate_count": len(catalog),
                       "incoming_count": len(incoming), **(budget.details() if budget is not None else {})})
        # This one request contains every canonical definition and every
        # incoming meaning. Admission or provider refusal cannot cause paging,
        # truncation, an extra novelty call or partial publication.
        matching, receipt = await self.model.determine(
            kind="requirements.match_catalog", schema=CatalogMatching,
            prompt_version="requirements-v2-catalog-match-v1-content-bound" if source_binding else "requirements-v2-catalog-match-v1", instruction=CATALOG_MATCHING_INSTRUCTION,
            sources=[{"source_id": ident, "text": text} for ident, text in source_map.items()],
            context={
                "contract_version": CONTRACT_VERSION,
                **({"posting_content": source_binding, "refresh_binding": refresh_binding} if source_binding
                   else {"posting": self._posting_identity(posting)}), "catalog_revision": epoch,
                "catalog_inventory_source_id": inventory_id,
                "incoming": [{**row.model_dump(), "model_source_id": incoming_source_ids[row.local_id]} for row in incoming],
                "candidates": [{"requirement_id": row["requirement_id"], "revision": row["revision"]} for row in catalog],
            },
            entity_id=None if source_binding else posting["job_id"],
            validate=lambda result: validate_catalog_matching(
                result, catalog=catalog, catalog_revision=epoch, incoming=incoming,
                incoming_source_ids=incoming_source_ids, sources=source_map,
                posting_source_id=source_id, inventory_source_id=inventory_id,
            ),
            budget=budget, publication_posting=self._publication_identity(posting) if source_binding else None,
            source_binding=source_binding,
        )
        self._check_cancel(cancelled)
        return matching, receipt, inventory

    async def _resolve(self, extracted, *, posting, source_text, catalog, epoch, extraction_receipt, cancelled,
                       budget=None, heartbeat=None):
        matching, receipt, inventory = await self._match_catalog(
            [extracted], posting=posting, source_text=source_text, catalog=catalog, epoch=epoch,
            cancelled=cancelled, budget=budget, heartbeat=heartbeat,
        )
        decision = matching.decisions[0]
        if decision.verdict == "equivalent":
            return next(row for row in catalog if (row["requirement_id"], row["revision"]) == (
                decision.requirement_id, decision.requirement_revision,
            )), [receipt], False
        return self._new_meaning(extracted, posting, extraction_receipt, receipt, inventory), [receipt], True

    @classmethod
    def _new_meaning(cls, extracted, posting, extraction_receipt, receipt, inventory):
        source_binding = extraction_receipt.get("source_binding")
        posting_binding = ({**cls._publication_identity(posting),
                            "model_source_id": source_binding["semantic_source"]["source_id"]}
                           if source_binding else cls._posting_identity(posting))
        return {
            "requirement_id": CONTRACT_VERSION + ":" + str(uuid.uuid5(uuid.NAMESPACE_URL, "jobctrl:requirement:" + fingerprint({
                "contract_version": CONTRACT_VERSION,
                "semantic_source": source_binding["semantic_source"] if source_binding else cls._content_source(posting.get("text") or posting.get("description") or ""),
                "local_id": extracted.local_id,
                "meaning": meaning_data(extracted),
            }))), "revision": 1, **meaning_data(extracted), "created_at": now(),
            "provenance": {
                "posting": posting_binding, "spans": [s.model_dump() for s in extracted.spans],
                "original": extracted.model_dump(exclude={"spans"}),
                "extraction": extraction_receipt, "resolution": [receipt],
                "catalog_matching": inventory, "matching_local_id": extracted.local_id,
            },
        }
