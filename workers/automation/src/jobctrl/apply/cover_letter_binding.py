"""Verify the exact cover material accepted by an Apply Review decision."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from jobctrl.domain.materials.cover_letter_settings import MAX_SOURCE_BYTES, RENDERER_VERSION, validate_settings
from jobctrl.infrastructure.materials.cover_letter_files import read_owned_cover_file


def cover_letter_approval_current(conn, tenant_id: str, job_id: str, decision_id: str, *, app_dir: Path | None = None) -> bool:
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
        payload = json.loads(event[0]) if event else {}
        if not isinstance(payload, dict):
            return False
        binding = payload.get("coverLetterBinding")
        if text is None:
            return binding is None
        if not isinstance(binding, dict):
            return False
        if app_dir is None:
            database = next((row[2] for row in conn.execute("PRAGMA database_list") if row[1] == "main"), "")
            if not database:
                return False
            app_dir = Path(database).parent
        raw = read_owned_cover_file(app_dir, Path(text[1]), MAX_SOURCE_BYTES)
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
        pdf_raw = read_owned_cover_file(app_dir, Path(pdf[1]), 32_000_000)
        if len(pdf_raw) > 32_000_000 or not pdf_raw.startswith(b"%PDF-") or b"%%EOF" not in pdf_raw:
            return False
        pdf_metadata = json.loads(pdf[2] or "{}")
        if not isinstance(pdf_metadata, dict):
            return False
        printed = pdf_metadata.get("cover_letter_review")
        actual_pdf_hash = hashlib.sha256(pdf_raw).hexdigest()
        if "cover_letter_review" in pdf_metadata:
            if not isinstance(printed, dict) or printed.get("source") != source or printed.get("pdfSha256") != actual_pdf_hash:
                return False
            settings = printed["settings"]
            renderer = printed["rendererVersion"]
        else:
            # A generation number is not evidence that a PDF contains this text.
            # Default generation records both hashes and its source occurrence.
            source_generation = pdf_metadata.get("source_generation")
            if (pdf_metadata.get("cover_letter_pdf_sha256") != actual_pdf_hash
                    or pdf_metadata.get("source_artifact_id") != text[0]
                    or pdf_metadata.get("cover_letter_text_sha256") != source["textSha256"]
                    or type(source_generation) is not int
                    or not conn.execute("SELECT 1 FROM job_materials_artifacts "
                                        "WHERE tenant_id=? AND job_id=? AND artifact_id=? AND generation=?",
                                        (tenant_id, job_id, text[0], source_generation)).fetchone()):
                return False
            settings = pdf_metadata.get("cover_letter_settings")
            renderer = pdf_metadata.get("cover_letter_renderer_version")
        if renderer != RENDERER_VERSION:
            return False
        if not isinstance(settings, dict):
            return False
        settings = validate_settings(settings)
        return (
            binding["pdfArtifactId"] == pdf[0]
            and binding["pdfSha256"] == actual_pdf_hash
            and binding["settings"] == settings
            and binding["rendererVersion"] == renderer
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False
