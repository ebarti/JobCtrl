"""Export a frozen, approved material without mutating the Materials aggregate.

Exports append to the existing file registry. Source rows, approvals, application
state, profile data and the Tailor use-case layer are never written here.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.editable_export import CONTRACT, ExportFailure, parse_settings, project_text
from jobctrl.infrastructure.materials.docx_export import render_docx, validate_docx

MAX_SOURCE_BYTES = 200_000


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _owned_path(root: Path, value: str | Path) -> Path:
    path = Path(value)
    spelling = root.absolute()
    resolved_root = root.resolve(strict=True)
    if path.is_relative_to(spelling):
        relative = path.relative_to(spelling)
    elif path.is_relative_to(resolved_root):
        relative = path.relative_to(resolved_root)
    else:
        raise ExportFailure("artifact_path_outside_workspace")
    if ".." in relative.parts or not relative.parts:
        raise ExportFailure("artifact_path_outside_workspace")
    current = resolved_root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise ExportFailure("artifact_path_outside_workspace")
    return current


@dataclass(frozen=True)
class AcceptedSource:
    row: tuple
    text: str
    sha256: str
    metadata: dict


def _load_source(connection, *, tenant_id, job_id, artifact_id, generation, root) -> AcceptedSource:
    rows = connection.execute(
        "SELECT artifact_id,generation,artifact_type,status,path,render_format,metadata_json,created_at,superseded_at "
        "FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_id=?",
        (tenant_id, job_id, artifact_id),
    ).fetchall()
    if len(rows) != 1 or rows[0][3] != "approved" or rows[0][8] is not None:
        raise ExportFailure("accepted_source_unavailable")
    row = tuple(rows[0])
    if row[1] != generation:
        raise ExportFailure("stale_source_generation")
    if row[2] not in {"tailored_resume", "cover_letter"} or row[5] != "text":
        raise ExportFailure("unsupported_source_format")
    path = _owned_path(root, row[4])
    try:
        # Do not follow a replaced final symlink, or block on a FIFO/device.
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ExportFailure("unsupported_source_format")
            data = stream.read(MAX_SOURCE_BYTES + 1)
        if len(data) > MAX_SOURCE_BYTES:
            raise ExportFailure("source_too_large")
        text = data.decode("utf-8")
        metadata = json.loads(row[6]) if row[6] else {}
        if not isinstance(metadata, dict):
            raise ValueError()
    except (OSError, UnicodeError, ValueError) as error:
        if isinstance(error, ExportFailure):
            raise
        raise ExportFailure("source_bytes_or_metadata_unavailable") from None
    return AcceptedSource(row, text, _digest(data), metadata)


def _write_exclusive(path: Path, data: bytes) -> None:
    # On a collision open fails before cleanup ownership is acquired.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def export_accepted_material(
    connection: sqlite3.Connection, *, tenant_id: str, job_id: str,
    artifact_id: str, generation: int, root: Path, settings: dict | None = None,
) -> dict:
    options = parse_settings(settings or {})
    if connection.in_transaction:
        raise ExportFailure("export_requires_own_transaction")
    try:
        canonical_job_id(job_id)
    except (TypeError, ValueError):
        raise ExportFailure("invalid_job_id") from None
    if type(generation) is not int or generation < 1 or not artifact_id or not tenant_id:
        raise ExportFailure("invalid_source_identity")
    source_args = dict(tenant_id=tenant_id, job_id=job_id, artifact_id=artifact_id,
                       generation=generation, root=Path(root))
    source = _load_source(connection, **source_args)
    recorded_locale = source.metadata.get("locale")
    if recorded_locale is not None:
        if not isinstance(recorded_locale, str) or not recorded_locale:
            raise ExportFailure("unsupported_source_locale")
        try:
            parse_settings({"locale": recorded_locale})
        except ExportFailure:
            raise ExportFailure("unsupported_source_locale") from None
        if options.locale is not None and options.locale != recorded_locale:
            raise ExportFailure("source_locale_mismatch")
    locale = recorded_locale or options.locale or "und"
    document = project_text(source.text, kind=source.row[2], locale=locale)
    resolved_settings = options.model_copy(update={"locale": locale}).model_dump()
    binding = {
        "contract": CONTRACT,
        "tenantId": tenant_id,
        "jobId": job_id,
        "sourceArtifactId": artifact_id,
        "generation": generation,
        "kind": source.row[2],
        "sourceSha256": source.sha256,
        "sourceMetadataSha256": _digest((source.row[6] or "{}").encode()),
        "settings": resolved_settings,
        "settingsSha256": _digest(_json(resolved_settings).encode()),
    }
    data = render_docx(document, options, binding)
    # Validate independently of the render entry point, including injected failures.
    validate_docx(data, document, binding)
    directory = _owned_path(Path(root), Path(root).absolute() / "generated" / "material-exports")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = _owned_path(Path(root), directory / f"{uuid.uuid4().hex}.docx")
    created = False
    try:
        connection.execute("BEGIN IMMEDIATE")
        if _load_source(connection, **source_args) != source:
            raise ExportFailure("stale_export_source")
        _write_exclusive(path, data)
        created = True
        if path.read_bytes() != data:
            raise ExportFailure("export_validation_failed")
        # Cover source-file drift while staging; the SQLite writer fence also
        # prevents acceptance/status/metadata changes by another connection.
        if _load_source(connection, **source_args) != source:
            raise ExportFailure("stale_export_source")
        receipt = {**binding, "sha256": _digest(data), "warnings": list(document.warnings),
                   "createdAt": datetime.now(timezone.utc).isoformat()}
        cursor = connection.execute(
            "INSERT INTO job_artifacts(tenant_id,job_id,stage,artifact_type,status,path,created_at,size_bytes,metadata_json) "
            "VALUES(?,?,'export','material_docx','approved',?,?,?,?)",
            (tenant_id, job_id, str(path), receipt["createdAt"], len(data), _json(receipt)),
        )
        connection.commit()
    except BaseException:
        connection.rollback()
        if created:
            path.unlink(missing_ok=True)
        raise
    return {**receipt, "artifactId": str(cursor.lastrowid), "path": str(path)}
