"""Verify the exact cover material accepted by an Apply Review decision."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from jobctrl.domain.materials.cover_letter_settings import DEFAULT_SETTINGS, MAX_SOURCE_BYTES


def cover_letter_approval_current(conn, tenant_id: str, job_id: str, decision_id: str) -> bool:
    def artifact(types):
        row = conn.execute(
            "SELECT artifact_id,path,metadata_json,generation FROM job_materials_artifacts "
            f"WHERE tenant_id=? AND job_id=? AND artifact_type IN ({','.join('?' for _ in types)}) "
            "AND status='approved' AND superseded_at IS NULL ORDER BY generation DESC,created_at DESC,rowid DESC LIMIT 1",
            (tenant_id, job_id, *types),
        ).fetchone()
        return row

    try:
        text = artifact(("cover_letter", "cover_letter_txt"))
        event = conn.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? "
            "AND event_type='ApplyReviewDecisionRecorded' AND json_extract(payload_json,'$.decisionId')=? "
            "ORDER BY event_id DESC LIMIT 1", (tenant_id, job_id, decision_id),
        ).fetchone()
        binding = json.loads(event[0]).get("coverLetterBinding") if event else None
        if text is None:
            return binding is None
        if not isinstance(binding, dict):
            return False
        with Path(text[1]).open("rb") as file:
            raw = file.read(MAX_SOURCE_BYTES + 1)
        if not raw.strip() or len(raw) > MAX_SOURCE_BYTES:
            return False
        raw.decode("utf-8", errors="strict")
        source = binding["source"]
        original_generation = conn.execute(
            "SELECT min(generation) FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_id=?",
            (tenant_id, job_id, text[0]),
        ).fetchone()[0]
        if (source["tenantId"], source["jobId"], source["artifactId"], source["generation"], source["textSha256"]) != (
            tenant_id, job_id, text[0], original_generation, hashlib.sha256(raw).hexdigest(),
        ):
            return False
        pdf = artifact(("cover_letter_pdf",))
        if pdf is None:
            return False
        with Path(pdf[1]).open("rb") as file:
            pdf_raw = file.read(32_000_001)
        if len(pdf_raw) > 32_000_000 or not pdf_raw.startswith(b"%PDF-") or b"%%EOF" not in pdf_raw:
            return False
        pdf_metadata = json.loads(pdf[2] or "{}")
        printed = pdf_metadata.get("cover_letter_review", {})
        if (printed and printed["source"] != source) or (not printed and pdf[3] != text[3]):
            return False
        return (
            binding["pdfArtifactId"] == pdf[0]
            and binding["pdfSha256"] == hashlib.sha256(pdf_raw).hexdigest()
            and binding["settings"] == printed.get("settings", pdf_metadata.get("cover_letter_settings", DEFAULT_SETTINGS))
            and binding["rendererVersion"] == printed.get("rendererVersion", pdf_metadata.get("cover_letter_renderer_version"))
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False
