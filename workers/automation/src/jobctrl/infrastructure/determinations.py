"""Durable determination envelopes; no semantic computation on the read side."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
import fcntl
import hashlib
import os
import stat
from pathlib import Path
import tempfile

from jobctrl.domain.determinations import DeterminationEnvelope, DeterminationFailure


class SqliteDeterminationRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @contextmanager
    def lock(self, tenant_id, determination_id):
        database = self._connection.execute("PRAGMA database_list").fetchone()[2]
        identity = str(Path(database).resolve()) if database else f"memory:{id(self._connection)}"
        key = hashlib.sha256(f"{identity}:{tenant_id}:{determination_id}".encode()).hexdigest()
        directory = Path(tempfile.gettempdir()) / f"jobctrl-determination-locks-{os.getuid()}"
        try:
            directory.mkdir(mode=0o700, exist_ok=True)
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise DeterminationFailure("cache_lock_unavailable")
            descriptor = os.open(directory / key, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        except OSError:
            raise DeterminationFailure("cache_lock_unavailable") from None
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_nlink != 1
                or info.st_mode & 0o077
            ):
                raise DeterminationFailure("cache_lock_unavailable")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def find(self, tenant_id: str, determination_id: str) -> DeterminationEnvelope | None:
        row = self._connection.execute(
            "SELECT envelope_json FROM semantic_determinations WHERE tenant_id = ? AND determination_id = ?",
            (tenant_id, determination_id),
        ).fetchone()
        if row is None:
            return None
        try:
            envelope = DeterminationEnvelope.model_validate_json(row[0])
        except ValueError:
            raise DeterminationFailure("schema_violation") from None
        if (
            envelope.tenant_id != tenant_id
            or envelope.determination_id != determination_id
            or envelope.input_fingerprint != determination_id
        ):
            raise DeterminationFailure("cache_binding_invalid")
        return envelope

    def save(self, envelope: DeterminationEnvelope) -> None:
        self._connection.execute("SAVEPOINT determination_save")
        try:
            self._save(envelope)
        except Exception:
            self._connection.execute("ROLLBACK TO determination_save")
            raise DeterminationFailure("persistence_error") from None
        finally:
            self._connection.execute("RELEASE determination_save")

    def _save(self, envelope: DeterminationEnvelope) -> None:
        self._connection.execute(
            "INSERT INTO semantic_determinations (tenant_id, determination_id, entity_id, kind, schema_version, prompt_version, provider, model, lane, input_fingerprint, created_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, determination_id) DO NOTHING",
            (
                envelope.tenant_id,
                envelope.determination_id,
                envelope.entity_id,
                envelope.kind,
                envelope.schema_version,
                envelope.prompt_version,
                envelope.provider,
                envelope.model,
                envelope.lane,
                envelope.input_fingerprint,
                envelope.created_at,
                json.dumps(envelope.model_dump(), ensure_ascii=False),
            ),
        )

    def record_state(self, *, tenant_id, entity_id, kind, fingerprint, state, failure_code=None, determination_id=None):
        from datetime import datetime, timezone

        # Record a failed attempt independently of the accepted artifact binding.
        self._connection.execute("SAVEPOINT semantic_stage_state")
        self._connection.execute(
            "INSERT INTO semantic_stage_states VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id,entity_id,kind,input_fingerprint) DO UPDATE SET state=excluded.state,failure_code=excluded.failure_code,determination_id=coalesce(excluded.determination_id,semantic_stage_states.determination_id),updated_at=excluded.updated_at",
            (
                tenant_id,
                entity_id,
                kind,
                fingerprint,
                state,
                failure_code,
                determination_id,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._connection.execute("RELEASE semantic_stage_state")

    def bound(self, *, tenant_id, entity_kind, entity_id, entity_version, determination_kind):
        row = self._connection.execute(
            "SELECT determination_id FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id=? AND entity_version=? AND determination_kind=?",
            (tenant_id, entity_kind, entity_id, entity_version, determination_kind),
        ).fetchone()
        envelope = self.find(tenant_id, row[0]) if row else None
        if envelope and (envelope.kind != determination_kind or envelope.entity_id != entity_id):
            raise DeterminationFailure("cache_binding_invalid")
        return envelope

    def bind(
        self,
        *,
        tenant_id: str,
        entity_kind: str,
        entity_id: str,
        entity_version: str,
        determination_kind: str,
        determination_id: str,
    ) -> None:
        self._connection.execute("SAVEPOINT semantic_binding")
        self._connection.execute(
            "INSERT INTO semantic_entity_bindings VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, entity_kind, entity_id, entity_version, determination_kind) DO UPDATE SET determination_id = excluded.determination_id",
            (tenant_id, entity_kind, entity_id, entity_version, determination_kind, determination_id),
        )

        self._connection.execute("RELEASE semantic_binding")


def determination_dependencies(connection, *, tenant_id, lane, model_spec=None, adapter=None):
    """Resolve the configured lane provider once; unavailability has no substitute."""
    from jobctrl.infrastructure.llm import LlmAdapter, get_llm_adapter
    from jobctrl.llm import enforce_spend_budget
    from jobctrl.llm_lanes import current_llm_lane

    from jobctrl.infrastructure.llm.llm_client import _effective_default_selection
    from jobctrl.infrastructure.analysis.claude_analysis_adapter import CLAUDE_ANALYSIS_MODEL
    from jobctrl.infrastructure.analysis.codex_analysis_adapter import CODEX_ANALYSIS_MODEL
    from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import ANTIGRAVITY_ANALYSIS_MODEL

    llm = adapter
    if adapter is not None:
        provider = str(getattr(adapter, "provider_id", "injected"))
        selected_model = str(getattr(adapter, "model", model_spec or "injected"))
    else:
        try:
            provider, selected_model = _effective_default_selection(model_spec)
            selected_model = selected_model or {
                "claude": CLAUDE_ANALYSIS_MODEL,
                "codex": CODEX_ANALYSIS_MODEL,
                "google": ANTIGRAVITY_ANALYSIS_MODEL,
            }.get(provider, "unavailable")
            llm = LlmAdapter(default_model=model_spec) if model_spec else get_llm_adapter()
        except Exception:
            provider, selected_model, llm = "unconfigured", "unavailable", None
    return dict(
        llm=llm,
        repository=SqliteDeterminationRepository(connection),
        tenant_id=str(tenant_id),
        provider=str(getattr(llm, "provider_id", provider)),
        model=str(getattr(llm, "model", selected_model)),
        lane=lane,
        preflight=lambda: enforce_spend_budget(lane=current_llm_lane()),
    )


def save_artifact_anchors(
    connection,
    *,
    tenant_id,
    artifact_kind,
    artifact_id,
    generation,
    determination_id,
    anchors,
    quality_determination_id=None,
    adversarial_determination_id=None,
    require_pass=True,
    expected_entity_id=None,
):
    repository = SqliteDeterminationRepository(connection)
    envelope = repository.find(str(tenant_id), determination_id)
    if (
        envelope is None
        or envelope.kind != "claim_verification"
        or (expected_entity_id is not None and envelope.entity_id != str(expected_entity_id))
    ):
        raise DeterminationFailure("artifact_binding_invalid")
    from jobctrl.domain.ports.claim_verification import ClaimVerification
    from pydantic import ValidationError

    try:
        verified = ClaimVerification.model_validate(envelope.result)
    except ValidationError:
        raise DeterminationFailure("schema_violation") from None
    if require_pass and (verified.verdict != "pass" or any(row.verdict != "pass" for row in verified.lines)):
        raise DeterminationFailure("artifact_binding_invalid")
    verified_ids = {row.line_id for row in verified.lines}
    anchor_ids = [row["line_id"] for row in anchors]
    if len(set(anchor_ids)) != len(anchor_ids) or set(anchor_ids) != verified_ids:
        raise DeterminationFailure("artifact_binding_invalid")
    for anchor in anchors:
        row = next(row for row in verified.lines if row.line_id == anchor["line_id"])
        supported_evidence = {citation.source_id for citation in row.source_evidence}
        if set(anchor["evidence_ids"]) - supported_evidence:
            raise DeterminationFailure("artifact_binding_invalid")
        if set(anchor["requirement_ids"]) - set(row.served_requirement_ids):
            raise DeterminationFailure("artifact_binding_invalid")
    if quality_determination_id is not None:
        quality = repository.find(str(tenant_id), quality_determination_id)
        if quality is None or quality.kind != "artifact_quality" or quality.entity_id != envelope.entity_id:
            raise DeterminationFailure("artifact_binding_invalid")
        from jobctrl.domain.ports.artifact_quality import ArtifactQuality

        try:
            judged = ArtifactQuality.model_validate(quality.result)
        except ValidationError:
            raise DeterminationFailure("schema_violation") from None
        if require_pass and judged.verdict != "pass":
            raise DeterminationFailure("artifact_binding_invalid")
    connection.execute(
        "DELETE FROM artifact_line_anchors WHERE tenant_id=? AND artifact_kind=? AND artifact_id=? AND generation=?",
        (str(tenant_id), artifact_kind, artifact_id, generation),
    )
    connection.executemany(
        "INSERT INTO artifact_line_anchors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                str(tenant_id),
                artifact_kind,
                artifact_id,
                generation,
                row["line_id"],
                json.dumps(row["evidence_ids"]),
                json.dumps(row["requirement_ids"]),
                row["transform_type"],
                row["reason"],
                determination_id,
            )
            for row in anchors
        ],
    )
    repository.bind(
        tenant_id=str(tenant_id),
        entity_kind="artifact",
        entity_id=artifact_id,
        entity_version=str(generation),
        determination_kind="claim_verification",
        determination_id=determination_id,
    )
    if quality_determination_id is not None:
        repository.bind(
            tenant_id=str(tenant_id),
            entity_kind="artifact",
            entity_id=artifact_id,
            entity_version=str(generation),
            determination_kind="artifact_quality",
            determination_id=quality_determination_id,
        )


    if adversarial_determination_id is not None:
        from jobctrl.domain.ports.resume_adversarial import ResumeAdversarialReview

        review = repository.find(str(tenant_id), adversarial_determination_id)
        if review is None or review.kind != "resume_adversarial" or review.entity_id != expected_entity_id:
            raise DeterminationFailure("artifact_binding_invalid")
        result = ResumeAdversarialReview.model_validate(review.result)
        if require_pass and result.verdict != "pass":
            raise DeterminationFailure("artifact_binding_invalid")
        repository.bind(
            tenant_id=str(tenant_id), entity_kind="artifact", entity_id=artifact_id,
            entity_version=str(generation), determination_kind="resume_adversarial",
            determination_id=adversarial_determination_id,
        )


def read_artifact_anchors(connection, *, tenant_id, artifact_id, generation, expected_job_id):
    """Read source links only after checking the owning verifier and line IDs."""
    from jobctrl.domain.ports.claim_verification import ClaimVerification
    from pydantic import TypeAdapter, ValidationError

    artifact = connection.execute(
        "SELECT artifact_type, metadata_json FROM job_materials_artifacts WHERE tenant_id=? AND artifact_id=? AND generation=? AND job_id=?",
        (tenant_id, artifact_id, generation, expected_job_id),
    ).fetchone()
    if artifact is None:
        return {}
    rows = connection.execute(
        "SELECT line_id,evidence_ids_json,requirement_ids_json,determination_id FROM artifact_line_anchors WHERE tenant_id=? AND artifact_kind=? AND artifact_id=? AND generation=?",
        (tenant_id, artifact[0], artifact_id, generation),
    ).fetchall()
    repository = SqliteDeterminationRepository(connection)
    result = {}
    for line_id, evidence_json, requirements_json, determination_id in rows:
        envelope = repository.find(tenant_id, determination_id)
        if (
            envelope is None
            or envelope.kind != "claim_verification"
            or envelope.schema_version != "2"
            or envelope.prompt_version != "claim-verification-v2"
        ):
            raise DeterminationFailure("artifact_binding_invalid")
        if envelope.entity_id != expected_job_id:
            try:
                revision_id = json.loads(artifact[1] or "{}").get("draft_revision_id")
            except (ValueError, AttributeError):
                raise DeterminationFailure("artifact_binding_invalid") from None
            if (
                envelope.entity_id != revision_id
                or not connection.execute(
                    "SELECT 1 FROM resume_review_draft_revisions WHERE tenant_id=? AND revision_id=? AND job_id=?",
                    (tenant_id, revision_id, expected_job_id),
                ).fetchone()
            ):
                raise DeterminationFailure("artifact_binding_invalid")
        try:
            verified = ClaimVerification.model_validate(envelope.result)
            evidence_ids = TypeAdapter(list[str]).validate_json(evidence_json, strict=True)
            requirement_ids = TypeAdapter(list[str]).validate_json(requirements_json, strict=True)
        except ValidationError:
            raise DeterminationFailure("artifact_binding_invalid") from None
        line = next((row for row in verified.lines if row.line_id == line_id), None)
        if (
            line is None
            or set(evidence_ids) - {cite.source_id for cite in line.source_evidence}
            or set(requirement_ids) - set(line.served_requirement_ids)
        ):
            raise DeterminationFailure("artifact_binding_invalid")
        result[line_id] = {"evidence_ids": evidence_ids, "requirement_ids": requirement_ids}
    return result


class ThreadLocalDeterminationRepository:
    """A durable repository that resolves a connection on the calling thread."""

    def __init__(self, path):
        self._path = path

    @property
    def connection(self):
        from jobctrl.database import get_connection

        return get_connection(self._path)

    def lock(self, *args):
        return SqliteDeterminationRepository(self.connection).lock(*args)

    def find(self, *args):
        return SqliteDeterminationRepository(self.connection).find(*args)

    def save(self, envelope):
        return SqliteDeterminationRepository(self.connection).save(envelope)

    def record_state(self, **kwargs):
        return SqliteDeterminationRepository(self.connection).record_state(**kwargs)

    def bind(self, **kwargs):
        return SqliteDeterminationRepository(self.connection).bind(**kwargs)
