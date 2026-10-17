"""Source-bound browser operations over the accepted-material DOCX service."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.editable_export import CONTRACT, ExportFailure, parse_settings
from jobctrl.infrastructure.materials.accepted_export import _digest, _load_source, export_accepted_material


class HistoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal["history"]


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal["export"]
    sourceArtifactId: str = Field(min_length=1, max_length=240)
    expectedGeneration: int = Field(gt=0)
    expectedSourceSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    expectedMetadataSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    paper: Literal["A4", "Letter"]


REQUEST = TypeAdapter(Annotated[HistoryRequest | ExportRequest, Field(discriminator="operation")])
RECEIPT_FIELDS = (
    "contract", "tenantId", "jobId", "sourceArtifactId", "generation", "kind", "sourceSha256",
    "sourceMetadataSha256", "settings", "settingsSha256", "sha256", "warnings", "createdAt",
)


def public_receipt(receipt, artifact_id):
    """Expose binding/format warnings, never paths or private source metadata."""
    try:
        return {**{key: receipt[key] for key in RECEIPT_FIELDS}, "artifactId": str(artifact_id)}
    except (KeyError, TypeError):
        raise ExportFailure("export_history_unavailable") from None


def history(connection, *, tenant_id, job_id, root):
    sources = []
    rows = connection.execute(
        "SELECT artifact_id,generation,artifact_type FROM job_materials_artifacts "
        "WHERE tenant_id=? AND job_id=? AND status='approved' AND superseded_at IS NULL "
        "AND artifact_type IN ('tailored_resume','cover_letter') AND render_format='text' "
        "ORDER BY generation DESC,artifact_id", (tenant_id, job_id),
    ).fetchall()
    for artifact_id, generation, kind in rows:
        entry = {"artifactId": artifact_id, "generation": generation, "kind": kind,
                 "locale": None, "sha256": None, "metadataSha256": None, "unavailableReason": None}
        try:
            source = _load_source(connection, tenant_id=tenant_id, job_id=job_id,
                                  artifact_id=artifact_id, generation=generation, root=Path(root))
            locale = source.metadata.get("locale")
            if locale is not None:
                try:
                    parse_settings({"locale": locale})
                except ExportFailure:
                    raise ExportFailure("unsupported_source_locale") from None
            entry.update(locale=locale, sha256=source.sha256,
                         metadataSha256=_digest((source.row[6] or "{}").encode()))
        except ExportFailure as error:
            entry["unavailableReason"] = error.code
        sources.append(entry)
    exports = []
    for artifact_id, raw in connection.execute(
        "SELECT artifact_id,metadata_json FROM job_artifacts WHERE tenant_id=? AND job_id=? "
        "AND stage='export' AND artifact_type='material_docx' AND status='approved' ORDER BY artifact_id DESC",
        (tenant_id, job_id),
    ):
        try:
            receipt = json.loads(raw)
            if (receipt["contract"] != CONTRACT or receipt["tenantId"] != tenant_id
                    or receipt["jobId"] != job_id):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise ExportFailure("export_history_unavailable") from None
        exports.append(public_receipt(receipt, artifact_id))
    return {"tenantId": tenant_id, "jobId": job_id, "sources": sources,
            "exports": exports, "exportedArtifactId": None}


def operation(connection, *, tenant_id, job_id, root, request):
    try:
        canonical_job_id(job_id)
        command = REQUEST.validate_python(request)
        if not isinstance(tenant_id, str) or not tenant_id:
            raise ValueError()
    except (ValidationError, TypeError, ValueError):
        raise ExportFailure("invalid_export_request") from None
    if not connection.execute("SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?", (tenant_id, job_id)).fetchone():
        raise ExportFailure("job_not_found")
    result = history(connection, tenant_id=tenant_id, job_id=job_id, root=root)
    if isinstance(command, ExportRequest):
        receipt = export_accepted_material(
            connection, tenant_id=tenant_id, job_id=job_id, root=Path(root),
            artifact_id=command.sourceArtifactId, generation=command.expectedGeneration,
            expected_source_sha256=command.expectedSourceSha256,
            expected_metadata_sha256=command.expectedMetadataSha256, settings={"paper": command.paper},
        )
        result["exports"].insert(0, public_receipt(receipt, receipt["artifactId"]))
        result["exportedArtifactId"] = receipt["artifactId"]
    return result
