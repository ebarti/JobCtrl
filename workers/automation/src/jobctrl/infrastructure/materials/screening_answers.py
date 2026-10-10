"""Private screening ledger on exact-v14; immutable revisions and fenced commits."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
import sqlite3

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.tenant import TenantId
from jobctrl.domain.profile.aggregate import InvalidProfileError
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository

QUESTION_KIND = "screening_question"
LIBRARY_KIND = "screening_library"
SENSITIVE_ROOTS = {
    "personal",
    "work_authorization",
    "compensation",
    "availability",
    "eeo_voluntary",
    "application_attestations",
    "application_preferences",
}


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def facts_from_profile(value, path=""):
    """JSON pointer identities are literal format parsing, never meaning judgments."""
    result = []
    if not path:
        # Only canonical authored Profile sections; derived compatibility views
        # and arbitrary extra JSON are not independent fact authorities.
        value = {
            key: child
            for key, child in value.items()
            if key in SENSITIVE_ROOTS | {"resume", "experience", "resume_constraints"}
        }
    if path == "/personal/password":
        # This canonical credential field is never screening evidence.
        return []
    if isinstance(value, dict):
        for key, child in value.items():
            result.extend(facts_from_profile(child, path + "/" + str(key).replace("~", "~0").replace("/", "~1")))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            result.extend(facts_from_profile(child, path + "/" + str(index)))
    elif value is not None and value != "":
        result.append(
            {
                "id": "profile:" + path,
                "text": json.dumps(value, ensure_ascii=False),
                "sensitive": path.split("/")[1] in SENSITIVE_ROOTS,
            }
        )
    return result


class ScreeningAnswerRepository:
    def __init__(self, connection):
        self.connection = connection

    @contextmanager
    def atomic(self):
        conn = self.connection
        outer = conn.in_transaction
        conn.execute("SAVEPOINT screening_commit" if outer else "BEGIN IMMEDIATE")
        try:
            yield
            conn.execute("RELEASE screening_commit" if outer else "COMMIT")
        except Exception:
            conn.execute("ROLLBACK TO screening_commit" if outer else "ROLLBACK")
            if outer:
                conn.execute("RELEASE screening_commit")
            raise

    def records(self, tenant, kind, entity=None):
        sql = "SELECT payload_json FROM job_events INDEXED BY idx_job_events_entity WHERE tenant_id=? AND entity_kind=?"
        args = [tenant, kind]
        if entity is not None:
            sql += " AND entity_ref=?"
            args.append(entity)
        sql += " ORDER BY event_id ASC"
        return [json.loads(row[0]) for row in self.connection.execute(sql, args).fetchall()]

    def current(self, tenant, question_id):
        rows = self.records(tenant, QUESTION_KIND, question_id)
        return rows[-1]["state"] if rows else None

    def library_entry(self, tenant, library_id):
        rows = self.records(tenant, LIBRARY_KIND, library_id) if library_id else []
        if not rows:
            return None
        entry = rows[-1]["entry"]
        self.check_library_origin(tenant, entry)
        return entry

    def repeated(self, tenant, job, command):
        row = self.connection.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id=? AND entity_kind=? AND idempotency_key=?",
            (tenant, QUESTION_KIND, "screening:" + digest({"tenant": tenant, "key": command.idempotencyKey})),
        ).fetchone()
        if row is None:
            return None
        payload = json.loads(row[0])
        if payload["requestHash"] != digest({"job": job, "command": command.model_dump()}):
            raise DeterminationFailure("screening_idempotency_conflict")
        return payload["state"]

    def _row(self, sql, params):
        cursor = self.connection.execute(sql, params)
        row = cursor.fetchone()
        return dict(zip([column[0] for column in cursor.description], row)) if row else None

    def sources(self, tenant, job, selected_ids, sensitive_ids):
        try:
            return self._sources(tenant, job, selected_ids, sensitive_ids)
        except sqlite3.Error:
            raise DeterminationFailure("screening_source_unavailable") from None

    def _sources(self, tenant, job, selected_ids, sensitive_ids):
        conn = self.connection
        conn.execute("SAVEPOINT screening_sources")
        try:
            job_row = self._row("SELECT * FROM jobs WHERE tenant_id=? AND job_id=?", (tenant, job))
            if job_row is None:
                raise DeterminationFailure("screening_job_not_found")
            posting = self._row("SELECT * FROM job_enrichments WHERE tenant_id=? AND job_id=?", (tenant, job))
            if not posting or not posting["application_url"] or not posting["full_description"]:
                raise DeterminationFailure("screening_posting_unavailable")
            try:
                profile = SqliteProfileRepository(conn, publisher=get_default_publisher()).load_snapshot(
                    TenantId(tenant)
                )
            except (FileNotFoundError, ValueError, InvalidProfileError):
                raise DeterminationFailure("screening_profile_unavailable") from None
            data = profile.as_dict()
            saved_profile = {}
            tables = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND (name='candidate_profiles' OR name LIKE 'candidate_profile_%') ORDER BY name"
                )
            ]
            for table in tables:
                # These names come from the admitted exact schema, never user input.
                cursor = conn.execute(
                    f'SELECT * FROM "{table}" WHERE tenant_id=? AND profile_id=?', (tenant, profile.profile_id)
                )
                saved_profile[table] = sorted(
                    [list(row) for row in cursor.fetchall()],
                    key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True),
                )
            facts = facts_from_profile(data)
            by_id = {fact["id"]: fact for fact in facts}
            if (
                len(set(selected_ids)) != len(selected_ids)
                or len(set(sensitive_ids)) != len(sensitive_ids)
                or set(selected_ids) - by_id.keys()
            ):
                raise DeterminationFailure("screening_foreign_fact")
            selected = [by_id[ident] for ident in sorted(selected_ids)]
            if set(sensitive_ids) != {fact["id"] for fact in selected if fact["sensitive"]}:
                raise DeterminationFailure("screening_sensitive_consent_required")
            materials = []
            cursor = conn.execute(
                "SELECT * FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND status='approved' ORDER BY generation,artifact_type",
                (tenant, job),
            )
            columns = [column[0] for column in cursor.description]
            for row in cursor.fetchall():
                artifact = dict(zip(columns, row))
                try:
                    artifact["contentHash"] = hashlib.sha256(Path(artifact["path"]).read_bytes()).hexdigest()
                except OSError:
                    raise DeterminationFailure("screening_material_unavailable") from None
                materials.append(artifact)
            return {
                "profileVersion": profile.version,
                "profileHash": digest({"profile": data, "saved": saved_profile}),
                "postingHash": digest({"job": job_row, "posting": posting}),
                "destination": posting["application_url"],
                "posting": posting["full_description"],
                "materials": materials,
                "facts": selected,
                "sensitiveFactIds": sorted(sensitive_ids),
            }, selected
        finally:
            conn.execute("RELEASE screening_sources")

    @staticmethod
    def model_context(binding):
        return json.dumps(
            {
                "questionContext": binding["context"],
                "destination": binding["destination"],
                "posting": binding["posting"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    def assert_sources(self, tenant, job, binding):
        current, _ = self.sources(tenant, job, [fact["id"] for fact in binding["facts"]], binding["sensitiveFactIds"])
        for key, value in current.items():
            if binding[key] != value:
                raise DeterminationFailure("screening_sources_changed")

    def assert_answer(self, tenant, job, state, answer):
        binding = answer["binding"]
        self.assert_sources(tenant, job, binding)
        if (binding["question"], binding["context"], binding["applicationId"]) != (
            state["question"],
            state["context"],
            state["applicationId"],
        ):
            raise DeterminationFailure("screening_context_changed")
        selection = state.get("selection")
        if selection and selection != {
            "factIds": sorted(fact["id"] for fact in binding["facts"]),
            "sensitiveFactIds": sorted(binding["sensitiveFactIds"]),
        }:
            raise DeterminationFailure("screening_selection_changed")
        self.assert_receipts(tenant, state, answer)

    def _append(self, tenant, job, kind, entity, payload, key=None):
        self.connection.execute(
            "INSERT INTO job_events(tenant_id,job_id,identity_version,stage,event_type,message,occurred_at,payload_json,entity_kind,entity_ref,idempotency_key) VALUES(?,?,1,'apply','ScreeningAnswerRecorded','Screening answer history updated',?,?,?,?,?)",
            (tenant, job, datetime.now(UTC).isoformat(), json.dumps(payload, ensure_ascii=False), kind, entity, key),
        )

    def save(self, tenant, job, command, state, library):
        try:
            with self.atomic():
                repeated = self.repeated(tenant, job, command)
                if repeated is not None:
                    return repeated
                current = self.current(tenant, state["questionId"])
                if (current["revision"] if current else 0) != command.expectedRevision:
                    raise DeterminationFailure("screening_revision_conflict")
                if command.action == "capture":
                    fresh, _ = self.sources(tenant, job, [], [])
                    if fresh != state["captureBinding"]:
                        raise DeterminationFailure("screening_sources_changed")
                else:
                    answer = (
                        state["draft"] if command.action in {"draft", "edit", "reuse", "review"} else state["accepted"]
                    )
                    if command.action != "review" or command.decision == "approved":
                        self.assert_answer(tenant, job, state, answer)
                state["recordedAt"] = datetime.now(UTC).isoformat()
                self._append(
                    tenant,
                    job,
                    QUESTION_KIND,
                    state["questionId"],
                    {"state": state, "requestHash": digest({"job": job, "command": command.model_dump()})},
                    "screening:" + digest({"tenant": tenant, "key": command.idempotencyKey}),
                )
                if library:
                    library.update(
                        snapshotId=state["snapshotId"], recordedAt=state["recordedAt"], originSnapshot=deepcopy(state)
                    )
                    self._append(tenant, None, LIBRARY_KIND, library["libraryId"], {"entry": library})
                self.connection.execute(
                    "INSERT INTO job_events(tenant_id,job_id,identity_version,stage,event_type,message,occurred_at,payload_json,entity_kind,entity_ref) VALUES(?,?,1,'apply','JobUpdated','Screening answer history updated',?,?, 'screening_notification',?)",
                    (
                        tenant,
                        job,
                        state["recordedAt"],
                        json.dumps(
                            {
                                "jobId": job,
                                "changedFields": {
                                    "screeningAnswer": {
                                        "questionId": state["questionId"],
                                        "snapshotId": state["snapshotId"],
                                        "revision": state["revision"],
                                    }
                                },
                            }
                        ),
                        state["questionId"],
                    ),
                )
            return state
        except sqlite3.Error:
            raise DeterminationFailure("screening_persistence_failed") from None

    def read(self, tenant, job):
        binding, facts, source_failure = None, [], None
        try:
            binding, _ = self.sources(tenant, job, [], [])
            profile = SqliteProfileRepository(self.connection, publisher=get_default_publisher()).load_snapshot(
                TenantId(tenant)
            )
            facts = facts_from_profile(profile.as_dict())
        except DeterminationFailure as failure:
            source_failure = failure.code
        states, history = {}, []
        for row in self.records(tenant, QUESTION_KIND):
            state = row["state"]
            if state["jobId"] == job:
                history.append(state)
                states[state["questionId"]] = deepcopy(state)
        for state in states.values():
            for key in ("accepted", "draft"):
                answer = state.get(key)
                if answer:
                    try:
                        self.assert_answer(tenant, job, state, answer)
                        answer["staleReason"] = None
                    except DeterminationFailure as failure:
                        answer["staleReason"] = failure.code
        library = [row["entry"] for row in self.records(tenant, LIBRARY_KIND)]
        # Resolve the actual recorded origin revision, never infer joins from prose.
        for entry in library:
            self.check_library_origin(tenant, entry)
        return {
            "ok": True,
            "jobId": job,
            "questions": list(states.values()),
            "history": history,
            "library": library,
            "facts": facts,
            "sourceBinding": binding,
            "sourceFailure": source_failure,
            "failures": [
                row["failure"] for row in self.records(tenant, "screening_failure") if row["failure"]["jobId"] == job
            ],
            "determinations": self.receipts(tenant, history, library),
        }

    def receipts(self, tenant, history, library):
        ids = {
            ident
            for state in history
            for key in ("draft", "accepted")
            if state.get(key)
            for ident in state[key]["determinationIds"]
        }
        ids |= {ident for entry in library for ident in entry["answer"]["determinationIds"]}
        repo = SqliteDeterminationRepository(self.connection)
        receipts = []
        for ident in sorted(ids):
            envelope = repo.find(tenant, ident)
            if envelope is None:
                raise DeterminationFailure("screening_authority_missing")
            receipts.append(envelope.model_dump())
        return receipts

    def check_library_origin(self, tenant, entry):
        origin = entry.get("originSnapshot")
        if (
            not origin
            or origin["snapshotId"] != entry["snapshotId"]
            or origin["questionId"] != entry["questionId"]
            or origin["jobId"] != entry["jobId"]
            or origin["applicationId"] != entry["applicationId"]
            or origin["action"] != "review"
            or origin.get("decision") != "approved"
            or origin.get("accepted") != entry["answer"]
        ):
            raise DeterminationFailure("screening_history_binding_invalid")
        originals = self.records(tenant, QUESTION_KIND, entry["questionId"])
        if originals and not any(row["state"] == origin for row in originals):
            raise DeterminationFailure("screening_history_binding_invalid")
        # A deleted Job may remove its events. The immutable library keeps its
        # recorded origin snapshot; no replacement origin is manufactured.
        self.assert_receipts(tenant, origin, entry["answer"])

    def assert_receipts(self, tenant, state, answer):
        repo = SqliteDeterminationRepository(self.connection)
        receipts = [repo.find(tenant, ident) for ident in answer["determinationIds"]]
        kinds = [receipt.kind if receipt else None for receipt in receipts]
        if kinds not in [
            ["screening_context", "screening_draft", "claim_verification", "artifact_quality"],
            ["screening_context", "claim_verification", "artifact_quality"],
        ]:
            raise DeterminationFailure("screening_authority_missing")
        from jobctrl.domain.materials.screening_answers import ScreeningInterpretation, ScreeningDraft
        from jobctrl.domain.ports.claim_verification import ClaimVerification
        from jobctrl.domain.ports.artifact_quality import ArtifactQuality

        schemas = {
            "screening_context": ScreeningInterpretation,
            "screening_draft": ScreeningDraft,
            "claim_verification": ClaimVerification,
            "artifact_quality": ArtifactQuality,
        }
        versions = {
            "screening_context": ("1", "screening-context-v1"),
            "screening_draft": ("1", "screening-draft-v1"),
            "claim_verification": ("2", "claim-verification-v2"),
            "artifact_quality": ("2", "artifact-quality-v2"),
        }
        for receipt in receipts:
            if (
                receipt.entity_id != state["questionId"]
                or receipt.lane != "apply"
                or (receipt.schema_version, receipt.prompt_version) != versions[receipt.kind]
            ):
                raise DeterminationFailure("screening_authority_missing")
            try:
                result = schemas[receipt.kind].model_validate(receipt.result)
            except ValueError:
                raise DeterminationFailure("screening_authority_invalid") from None
            if receipt.kind == "screening_draft":
                if result.text != answer["text"]:
                    raise DeterminationFailure("screening_authority_invalid")
            elif result.verdict != ("ready" if receipt.kind == "screening_context" else "pass"):
                raise DeterminationFailure("screening_authority_invalid")

    def record_failure(self, tenant, job, command, code):
        # Failure evidence does not advance a question or replace accepted text.
        payload = {
            "jobId": job,
            "questionId": command.questionId,
            "action": command.action,
            "expectedRevision": command.expectedRevision,
            "code": code,
            "requestHash": digest(command.model_dump()),
            "recordedAt": datetime.now(UTC).isoformat(),
        }
        try:
            if not self.connection.execute(
                "SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?", (tenant, job)
            ).fetchone():
                return
            with self.atomic():
                self._append(tenant, job, "screening_failure", command.questionId or job, {"failure": payload})
        except sqlite3.Error:
            # Unwritable storage cannot retain an attempted receipt; never alter
            # the accepted state to make failure logging succeed.
            pass
