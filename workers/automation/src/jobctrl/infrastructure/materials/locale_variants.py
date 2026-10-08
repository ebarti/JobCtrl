"""Versioned locale history in exact-v14 Materials metadata, with atomic fences."""

from __future__ import annotations

import hashlib
import html
import io
import json
import re
import uuid
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

from jobctrl.domain.determinations import DeterminationFailure, parse_model_result
from jobctrl.domain.ports.claim_verification import ClaimVerification
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.locale_variants import LocaleTranslation, translate_document
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, determination_dependencies
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository

KEY = "locale_variants_v1"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def profile_snapshot(connection, tenant):
    try:
        return SqliteProfileRepository(connection, publisher=get_default_publisher()).load_snapshot(TenantId(tenant))
    except Exception:
        raise DeterminationFailure("canonical_profile_unavailable") from None


def _rows(connection, tenant, job):
    return connection.execute(
        "SELECT generation,metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? ORDER BY generation",
        (tenant, job),
    ).fetchall()


def read_locale_state(connection, *, tenant_id: str, job_id: str) -> dict:
    job_id = str(canonical_job_id(job_id))
    variants, failures, revision = [], [], 0
    for row in _rows(connection, tenant_id, job_id):
        state = json.loads(row["metadata_json"] or "{}").get(KEY, {})
        if state and state.get("schema_version") != 1:
            raise DeterminationFailure("locale_schema_unavailable")
        revision += state.get("revision", 0)
        variants.extend(state.get("variants", []))
        failures.extend(state.get("failures", []))
    return {"revision": revision, "variants": variants, "failures": failures}


def _source(connection, tenant, job, kind, app_dir):
    artifact_type = "tailored_resume" if kind == "resume" else "cover_letter"
    row = connection.execute(
        "SELECT * FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_type=? AND status='approved' ORDER BY generation DESC LIMIT 1",
        (tenant, job, artifact_type),
    ).fetchone()
    if row is None:
        raise DeterminationFailure("accepted_source_unavailable")
    try:
        path = Path(row["path"]).resolve(strict=True)
    except (OSError, TypeError, ValueError):
        raise DeterminationFailure("source_unreadable") from None
    roots = [Path(app_dir).resolve() / name for name in ("tailored_resumes", "cover_letters")]
    if not any(path.is_relative_to(root) for root in roots) or row["render_format"] != "text":
        raise DeterminationFailure("source_path_invalid")
    try:
        data = path.read_bytes()
        text = data.decode("utf-8")
    except (OSError, UnicodeError):
        raise DeterminationFailure("source_unreadable") from None
    if not data or len(data) > 64000:
        raise DeterminationFailure("source_size_invalid")
    metadata = json.loads(row["metadata_json"] or "{}")
    verification_id = metadata.get("claim_verification_id")
    verification = SqliteDeterminationRepository(connection).find(tenant, verification_id) if verification_id else None
    if (
        verification is None
        or verification.kind != "claim_verification"
        or verification.result.get("verdict") != "pass"
    ):
        raise DeterminationFailure("source_semantic_binding_unavailable")
    verified = parse_model_result(ClaimVerification, verification.result)
    if any(line.verdict != "pass" for line in verified.lines):
        raise DeterminationFailure("source_semantic_binding_unavailable")
    if metadata.get("accepted_text_sha256") is None:
        raise DeterminationFailure("source_byte_binding_unavailable")
    if metadata["accepted_text_sha256"] != digest(data):
        raise DeterminationFailure("source_bytes_changed")
    bindings = connection.execute(
        "SELECT determination_id FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind='artifact' AND entity_id=? AND entity_version=? AND determination_kind='claim_verification'",
        (tenant, row["artifact_id"], str(row["generation"])),
    ).fetchone()
    if not bindings or bindings[0] != verification_id:
        raise DeterminationFailure("source_semantic_binding_unavailable")
    return {
        "artifact_id": row["artifact_id"],
        "artifact_type": artifact_type,
        "source_status": row["status"],
        "source_created_at": row["created_at"],
        "generation": row["generation"],
        "sha256": digest(data),
        "verification_id": verification_id,
        "text": text,
    }


def _fence(connection, tenant, job, binding, expected_revision, app_dir):
    current = _source(connection, tenant, job, binding["kind"], app_dir)
    if any(current[key] != binding[key] for key in ("artifact_id", "generation", "sha256", "verification_id")):
        raise DeterminationFailure("stale_source")
    snapshot = profile_snapshot(connection, tenant)
    serialized = json.dumps(snapshot.as_dict(), ensure_ascii=False, sort_keys=True)
    if snapshot.version != binding["profile_version"] or digest(serialized.encode()) != binding["profile_sha256"]:
        raise DeterminationFailure("stale_profile_version")
    if read_locale_state(connection, tenant_id=tenant, job_id=job)["revision"] != expected_revision:
        raise DeterminationFailure("stale_locale_revision")


def _write(connection, tenant, job, generation, operation):
    """Reload and merge one namespaced field under the writer lock."""
    connection.execute("SAVEPOINT locale_write")
    try:
        row = connection.execute(
            "SELECT metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? AND generation=?",
            (tenant, job, generation),
        ).fetchone()
        if row is None:
            raise DeterminationFailure("stale_source")
        metadata = json.loads(row[0] or "{}")
        state = metadata.setdefault(KEY, {"schema_version": 1, "revision": 0, "variants": [], "failures": []})
        operation(state)
        state["revision"] += 1
        cursor = connection.execute(
            "UPDATE job_materials SET metadata_json=? WHERE tenant_id=? AND job_id=? AND generation=? AND metadata_json IS ?",
            (json.dumps(metadata, ensure_ascii=False), tenant, job, generation, row[0]),
        )
        if cursor.rowcount != 1:
            raise DeterminationFailure("stale_locale_revision")
    except BaseException:
        connection.execute("ROLLBACK TO locale_write")
        raise
    finally:
        connection.execute("RELEASE locale_write")


def _failure(connection, tenant, job, generation, operation, code):
    _write(
        connection,
        tenant,
        job,
        generation,
        lambda state: state["failures"].append({"operation": operation, "code": code, "at": now()}),
    )


def generate_locale_variant(
    connection,
    *,
    tenant_id,
    job_id,
    app_dir,
    kind,
    source_locale,
    target_locale,
    expected_revision,
    request_id,
    dependencies=None,
):
    job_id = str(canonical_job_id(job_id))
    if (
        kind not in {"resume", "cover_letter"}
        or any(
            not re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", value) for value in (source_locale, target_locale)
        )
        or source_locale.lower() == target_locale.lower()
    ):
        raise DeterminationFailure("invalid_locale_request")
    try:
        uuid.UUID(request_id)
    except (ValueError, TypeError):
        raise DeterminationFailure("invalid_locale_request") from None
    state = read_locale_state(connection, tenant_id=tenant_id, job_id=job_id)
    duplicate = next((row for row in state["variants"] if row["request_id"] == request_id), None)
    if duplicate:
        if (duplicate["kind"], duplicate["source_locale"], duplicate["target_locale"]) != (
            kind,
            source_locale,
            target_locale,
        ):
            raise DeterminationFailure("request_id_conflict")
        return state
    source = _source(connection, tenant_id, job_id, kind, app_dir)
    snapshot = profile_snapshot(connection, tenant_id)
    profile_json = json.dumps(snapshot.as_dict(), ensure_ascii=False, sort_keys=True)
    binding = {
        **source,
        "tenant_id": tenant_id,
        "job_id": job_id,
        "kind": kind,
        "source_locale": source_locale,
        "target_locale": target_locale,
        "profile_version": snapshot.version,
        "profile_sha256": digest(profile_json.encode()),
        "profile_json": profile_json,
        "variant_id": str(uuid.uuid4()),
    }
    semantic_input = {key: value for key, value in binding.items() if key != "variant_id"}
    binding["semantic_entity_id"] = "material-locale:" + digest(
        json.dumps(semantic_input, sort_keys=True, ensure_ascii=False).encode()
    )

    def fence():
        return _fence(connection, tenant_id, job_id, binding, expected_revision, app_dir)

    fence()
    try:
        result = translate_document(
            binding=binding,
            profile=snapshot.as_dict(),
            dependencies=dependencies or determination_dependencies(connection, tenant_id=tenant_id, lane="tailoring"),
            fence=fence,
        )
        variant = {
            **binding,
            **result,
            "request_id": request_id,
            "locale_generation": 1
            + sum(row["kind"] == kind and row["target_locale"] == target_locale for row in state["variants"]),
            "revision": 1,
            "created_at": now(),
            "terminology_review": "pending",
            "formatting_review": "pending",
            "reviews": [],
            "exports": [],
        }

        def append(current):
            fence()
            current["variants"].append(variant)

        _write(connection, tenant_id, job_id, source["generation"], append)
    except Exception as error:
        code = error.code if isinstance(error, DeterminationFailure) else "locale_generation_failed"
        _failure(connection, tenant_id, job_id, source["generation"], "generate", code)
        raise DeterminationFailure(code) from None
    return read_locale_state(connection, tenant_id=tenant_id, job_id=job_id)


def _variant(connection, tenant, job, variant_id):
    state = read_locale_state(connection, tenant_id=tenant, job_id=job)
    variant = next((row for row in state["variants"] if row["variant_id"] == variant_id), None)
    if variant is None:
        raise DeterminationFailure("locale_variant_not_found")
    if variant["tenant_id"] != tenant or variant["job_id"] != job:
        raise DeterminationFailure("locale_binding_invalid")
    return variant


def _authority(connection, tenant, variant):
    """Join immutable recorded IDs again at human acceptance and export."""
    kinds = ["material_locale_translation", "material_locale_terminology", "claim_verification", "artifact_quality"]
    references = variant["determinations"]
    if [row["kind"] for row in references] != kinds:
        raise DeterminationFailure("locale_semantic_gate_failed")
    envelopes = []
    for reference in references:
        envelope = SqliteDeterminationRepository(connection).find(tenant, reference["determination_id"])
        if (
            envelope is None
            or envelope.entity_id != variant["semantic_entity_id"]
            or envelope.model_dump() != reference
        ):
            raise DeterminationFailure("locale_determination_binding_invalid")
        envelopes.append(envelope)
    translation = parse_model_result(LocaleTranslation, envelopes[0].result)
    if not translation.supported or [row.model_dump() for row in translation.lines] != variant["lines"]:
        raise DeterminationFailure("locale_document_binding_invalid")
    if not variant["gate_passed"] or any(envelope.result.get("verdict") != "pass" for envelope in envelopes[1:]):
        raise DeterminationFailure("locale_semantic_gate_failed")
    if variant["sha256"] != digest(variant["text"].encode()) or variant["profile_sha256"] != digest(
        variant["profile_json"].encode()
    ):
        raise DeterminationFailure("locale_document_binding_invalid")


def review_locale_variant(
    connection,
    *,
    tenant_id,
    job_id,
    app_dir,
    variant_id,
    expected_revision,
    expected_variant_revision,
    review_kind,
    decision,
):
    job_id = str(canonical_job_id(job_id))
    variant = _variant(connection, tenant_id, job_id, variant_id)
    if review_kind not in {"terminology", "formatting"} or decision not in {"accepted", "rejected"}:
        raise DeterminationFailure("invalid_locale_review")

    def review(state):
        _fence(connection, tenant_id, job_id, variant, expected_revision, app_dir)
        row = next(row for row in state["variants"] if row["variant_id"] == variant_id)
        if row["revision"] != expected_variant_revision or row["status"] in {"accepted", "refused"}:
            raise DeterminationFailure("stale_locale_review")
        if decision == "accepted" and not row["gate_passed"]:
            raise DeterminationFailure("locale_semantic_gate_failed")
        if decision == "accepted":
            _authority(connection, tenant_id, row)
        row[review_kind + "_review"] = decision
        row["revision"] += 1
        row["reviews"].append(
            {"review_kind": review_kind, "decision": decision, "revision": row["revision"], "at": now()}
        )
        if row["terminology_review"] == row["formatting_review"] == "accepted":
            row["status"] = "accepted"
            row["accepted_at"] = now()
            row["accepted_revision"] = row["revision"]
            row["document_sha256"] = digest(locale_text(row).encode())

    _write(connection, tenant_id, job_id, variant["generation"], review)
    return read_locale_state(connection, tenant_id=tenant_id, job_id=job_id)


def locale_text(variant):
    lines = variant["text"].splitlines()
    for row in variant["lines"]:
        lines[int(row["line_id"].split(":")[1])] = row["text"]
    return "\n".join(lines) + "\n"


def locale_html(variant):
    from jobctrl.infrastructure.materials.playwright_html_pdf import _build_letter_html

    content = _build_letter_html("")
    content = content.replace("<p></p>", "<p>" + html.escape(locale_text(variant)) + "</p>")
    return content.replace("<html>", f'<html lang="{html.escape(variant["target_locale"], quote=True)}">').replace(
        "white-space: normal", "white-space: pre-wrap; overflow-wrap: anywhere"
    )


class _HtmlClaims(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inside = False
        self.content = []

    def handle_starttag(self, tag, attrs):
        if tag == "p":
            self.inside = True

    def handle_endtag(self, tag):
        if tag == "p":
            self.inside = False

    def handle_data(self, data):
        if self.inside:
            self.content.append(data)


def validate_html_claims(content, expected):
    parser = _HtmlClaims()
    parser.feed(content)
    if "".join(parser.content) != expected:
        raise DeterminationFailure("locale_html_content_mismatch")


def locale_docx(variant):
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    ET.register_namespace("w", ns)
    document = ET.Element(f"{{{ns}}}document")
    body = ET.SubElement(document, f"{{{ns}}}body")
    for line in locale_text(variant).splitlines():
        paragraph = ET.SubElement(body, f"{{{ns}}}p")
        run = ET.SubElement(paragraph, f"{{{ns}}}r")
        text = ET.SubElement(run, f"{{{ns}}}t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"})
        text.text = line
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        archive.writestr("word/document.xml", ET.tostring(document, encoding="utf-8", xml_declaration=True))
    return stream.getvalue()


def export_locale_variant(
    connection,
    *,
    tenant_id,
    job_id,
    app_dir,
    variant_id,
    expected_revision,
    expected_variant_revision,
    export_format,
    renderer=None,
):
    job_id = str(canonical_job_id(job_id))
    variant = _variant(connection, tenant_id, job_id, variant_id)
    if export_format not in {"text", "html", "pdf", "docx"}:
        raise DeterminationFailure("invalid_locale_export")
    _fence(connection, tenant_id, job_id, variant, expected_revision, app_dir)
    _authority(connection, tenant_id, variant)
    if (
        variant["status"] != "accepted"
        or variant["revision"] != expected_variant_revision
        or variant["document_sha256"] != digest(locale_text(variant).encode())
    ):
        raise DeterminationFailure("locale_acceptance_required")
    export_id = str(uuid.uuid4())
    root = Path(app_dir).resolve() / "tailored_resumes" / "locale_variants"
    extension = "txt" if export_format == "text" else export_format
    path = root / f"{export_id}.{extension}"
    created = False
    try:
        root.mkdir(parents=True, exist_ok=True)
        if not root.resolve().is_relative_to(Path(app_dir).resolve() / "tailored_resumes"):
            raise DeterminationFailure("locale_export_path_invalid")
        # Reserve the path exclusively even for the renderer, which overwrites
        # its output path. A collision must never remove another accepted file.
        with path.open("xb"):
            pass
        created = True
        if export_format == "pdf":
            from jobctrl.infrastructure.materials.playwright_html_pdf import _render_pdf_playwright

            content = locale_html(variant)
            validate_html_claims(content, locale_text(variant))
            (renderer or _render_pdf_playwright)(content, str(path))
            # Validate actual PDF text/glyph extraction, rather than trusting renderer success.
            from pypdf import PdfReader

            document = PdfReader(path)
            extracted = "\n".join(page.extract_text() for page in document.pages)
            if not document.pages:
                raise DeterminationFailure("locale_pdf_invalid")
            expected = " ".join(locale_text(variant).split())
            if "\ufffd" in extracted or " ".join(extracted.split()) != expected:
                raise DeterminationFailure("locale_pdf_content_mismatch")
        else:
            data = (
                locale_docx(variant)
                if export_format == "docx"
                else (locale_html(variant) if export_format == "html" else locale_text(variant)).encode()
            )
            with path.open("wb") as output:
                output.write(data)
            if export_format == "html":
                validate_html_claims(path.read_text(), locale_text(variant))
            if export_format == "docx":
                with zipfile.ZipFile(path) as archive:
                    texts = ET.fromstring(archive.read("word/document.xml")).iter(
                        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
                    )
                    if [node.text or "" for node in texts] != locale_text(variant).splitlines():
                        raise DeterminationFailure("locale_docx_content_mismatch")
        record = {
            "export_id": export_id,
            "format": export_format,
            "path": str(path),
            "sha256": digest(path.read_bytes()),
            "document_sha256": variant["document_sha256"],
            "accepted_revision": variant["accepted_revision"],
            "created_at": now(),
        }

        def register(state):
            _fence(connection, tenant_id, job_id, variant, expected_revision, app_dir)
            _authority(connection, tenant_id, variant)
            row = next(row for row in state["variants"] if row["variant_id"] == variant_id)
            if row["revision"] != expected_variant_revision:
                raise DeterminationFailure("stale_locale_review")
            row["exports"].append(record)

        _write(connection, tenant_id, job_id, variant["generation"], register)
    except Exception as error:
        if created:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                # An unregistered orphan is never served through an export ID.
                pass
        code = error.code if isinstance(error, DeterminationFailure) else "locale_export_failed"
        _failure(connection, tenant_id, job_id, variant["generation"], "export", code)
        raise DeterminationFailure(code) from None
    return read_locale_state(connection, tenant_id=tenant_id, job_id=job_id)


def mutate_locale_variants(connection, *, tenant_id, job_id, app_dir, mutation, dependencies=None, renderer=None):
    """Shared strict dispatch for synchronous RPC and explicit CLI commands."""
    fields = {
        "generate": {"operation", "kind", "source_locale", "target_locale", "expected_revision", "request_id"},
        "review": {
            "operation",
            "variant_id",
            "expected_revision",
            "expected_variant_revision",
            "review_kind",
            "decision",
        },
        "export": {"operation", "variant_id", "expected_revision", "expected_variant_revision", "export_format"},
    }
    if (
        not isinstance(mutation, dict)
        or mutation.get("operation") not in fields
        or set(mutation) != fields[mutation["operation"]]
    ):
        raise DeterminationFailure("invalid_locale_request")
    for key, value in mutation.items():
        if key.startswith("expected_"):
            if type(value) is not int or value < (1 if key == "expected_variant_revision" else 0):
                raise DeterminationFailure("invalid_locale_revision")
        elif not isinstance(value, str):
            raise DeterminationFailure("invalid_locale_request")
    operation = mutation["operation"]
    kwargs = {key: value for key, value in mutation.items() if key != "operation"}
    base = dict(tenant_id=tenant_id, job_id=job_id, app_dir=app_dir, **kwargs)
    before = read_locale_state(connection, tenant_id=tenant_id, job_id=job_id)
    try:
        if operation == "generate":
            return generate_locale_variant(connection, **base, dependencies=dependencies)
        if operation == "review":
            return review_locale_variant(connection, **base)
        return export_locale_variant(connection, **base, renderer=renderer)
    except DeterminationFailure as error:
        # Preflight and stale review failures also have a durable, safe receipt.
        current = read_locale_state(connection, tenant_id=tenant_id, job_id=job_id)
        if len(current["failures"]) == len(before["failures"]):
            rows = _rows(connection, tenant_id, job_id)
            if rows:
                _failure(connection, tenant_id, job_id, rows[-1]["generation"], operation, error.code)
        raise
