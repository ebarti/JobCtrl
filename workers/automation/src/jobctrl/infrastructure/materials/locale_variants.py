"""Immutable locale snapshots in the native artifact registry; no schema migration."""
from __future__ import annotations

import hashlib
import html
import io
import json
import os
from pathlib import Path
from datetime import datetime, timezone
import uuid
import zipfile
from xml.etree import ElementTree

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.locale_variants import (
    SUPPORTED_LOCALES, LocaleTranslation, LocaleVerification, protected_values,
    source_lines, translate, verify, validate_translation, validate_verification, parse_request, locale_fingerprint,
)
from jobctrl.domain.profile.canonical_sources import profile_sources
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.determinations import determination_dependencies, SqliteDeterminationRepository
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.infrastructure.events import get_default_publisher

CONTRACT = "material-locale-v1"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def profile_snapshot(connection, tenant_id):
    try:
        snapshot = SqliteProfileRepository(connection, publisher=get_default_publisher()).load_snapshot(TenantId(tenant_id))
    except FileNotFoundError:
        raise DeterminationFailure("profile_unavailable") from None
    except (TypeError, ValueError):
        raise DeterminationFailure("profile_source_invalid") from None
    facts = profile_sources(snapshot.as_dict())
    return snapshot, facts


def owned_path(root, value):
    spelling = Path(root).absolute()
    root = spelling.resolve(strict=True)
    path = Path(value)
    if not path.is_absolute() or root not in path.resolve().parents:
        raise DeterminationFailure("artifact_path_outside_workspace")
    if path.is_relative_to(spelling):
        relative = path.relative_to(spelling)
    elif path.is_relative_to(root):
        relative = path.relative_to(root)
    else:
        raise DeterminationFailure("artifact_path_outside_workspace")
    if ".." in relative.parts:
        raise DeterminationFailure("artifact_path_outside_workspace")
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise DeterminationFailure("artifact_path_outside_workspace")
    return root / relative


def load_source(connection, *, tenant_id, job_id, artifact_id, root):
    rows = connection.execute(
        "SELECT artifact_id,generation,artifact_type,status,path FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_id=?",
        (tenant_id, job_id, artifact_id),
    ).fetchall()
    if len(rows) != 1:
        raise DeterminationFailure("accepted_source_unavailable")
    row = rows[0]
    if row[2] not in {"tailored_resume", "cover_letter"} or row[3] != "approved":
        raise DeterminationFailure("accepted_source_unavailable")
    path = owned_path(root, row[4])
    try:
        data = path.read_bytes()
        text = data.decode("utf-8")
    except (OSError, UnicodeError):
        raise DeterminationFailure("source_bytes_unavailable") from None
    if not text.strip() or len(data) > 200000:
        raise DeterminationFailure("invalid_line_inventory")
    return {"artifactId": row[0], "generation": row[1], "kind": row[2], "sha256": digest(data), "text": text}


def fence(connection, snapshot, root):
    current = load_source(connection, tenant_id=snapshot["tenantId"], job_id=snapshot["jobId"],
                          artifact_id=snapshot["source"]["artifactId"], root=root)
    profile, facts = profile_snapshot(connection, snapshot["tenantId"])
    if (current != snapshot["source"] or profile.version != snapshot["profileVersion"]
            or [row.model_dump() for row in facts] != snapshot["facts"]
            or protected_values(profile.as_dict(), current["text"]) != snapshot["protectedValues"]):
        raise DeterminationFailure("stale_locale_source")


def history(connection, *, tenant_id, job_id):
    rows = connection.execute(
        "SELECT artifact_id,metadata_json FROM job_artifacts WHERE tenant_id=? AND job_id=? AND stage='locale' AND artifact_type='locale_revision' ORDER BY artifact_id",
        (tenant_id, job_id),
    ).fetchall()
    variants = []
    for row in rows:
        try:
            value = json.loads(row[1])
            if value["contract"] != CONTRACT:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise DeterminationFailure("locale_contract_invalid") from None
        # Reconstruct the complete persisted binding without a model call.
        # A recorded negative verdict is still inspectable authority.
        try:
            if value["tenantId"] != tenant_id or value["jobId"] != job_id:
                raise DeterminationFailure("locale_authority_invalid")
            authority(connection, value, require_pass=False)
            recorded = True
        except (DeterminationFailure, KeyError, TypeError, ValueError):
            # Invalid authority cannot erase the last accepted text.
            recorded = False
        value["authorityStatus"] = "recorded" if recorded else "unavailable"
        variants.append(value)
    profile = connection.execute("SELECT version FROM candidate_profiles WHERE tenant_id=? AND profile_id='default'", (tenant_id,)).fetchone()
    sources = connection.execute("SELECT artifact_id,generation,artifact_type FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND status='approved' AND artifact_type IN ('tailored_resume','cover_letter') ORDER BY generation DESC", (tenant_id, job_id)).fetchall()
    return {"supportedLocales": list(SUPPORTED_LOCALES), "variants": variants, "profileVersion": profile[0] if profile else None,
            "sources": [{"artifactId": row[0], "generation": row[1], "kind": row[2]} for row in sources]}


def current_revision(connection, tenant_id, job_id, revision_id):
    row = connection.execute(
        "SELECT artifact_id,metadata_json FROM job_artifacts WHERE tenant_id=? AND job_id=? AND stage='locale' AND artifact_type='locale_revision' AND json_extract(metadata_json,'$.revisionId')=?",
        (tenant_id, job_id, revision_id),
    ).fetchone()
    if row is None:
        raise DeterminationFailure("locale_revision_not_found")
    snapshot = json.loads(row[1])
    if snapshot.get("contract") != CONTRACT:
        raise DeterminationFailure("locale_contract_invalid")
    return row[0], snapshot


def save_revision(connection, snapshot, path):
    connection.execute(
        "INSERT INTO job_artifacts(tenant_id,job_id,stage,artifact_type,status,path,created_at,size_bytes,metadata_json) VALUES(?,?,'locale','locale_revision','candidate',?,?,?,?)",
        (snapshot["tenantId"], snapshot["jobId"], str(path), now(), path.stat().st_size, json.dumps(snapshot, ensure_ascii=False)),
    )


def update(connection, row_id, snapshot, expected_version):
    result = connection.execute(
        "UPDATE job_artifacts SET metadata_json=?,status=? WHERE artifact_id=? AND json_extract(metadata_json,'$.version')=?",
        (json.dumps(snapshot, ensure_ascii=False), "approved" if snapshot["accepted"] else "candidate", row_id, expected_version),
    )
    if result.rowcount != 1:
        raise DeterminationFailure("stale_locale_revision")


def operation(connection, *, tenant_id, job_id, root, request, dependencies=None, pdf_renderer=None):
    """One RPC/CLI owner, including read-only history and atomic reviewed mutations."""
    from jobctrl.domain.identifiers import canonical_job_id
    request = parse_request(request)
    try:
        canonical_job_id(job_id)
    except ValueError:
        raise DeterminationFailure("invalid_job_id") from None
    if not connection.execute("SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?", (tenant_id, job_id)).fetchone():
        raise DeterminationFailure("job_not_found")
    action = request["operation"]
    if action == "history":
        return history(connection, tenant_id=tenant_id, job_id=job_id)
    if action == "generate":
        try:
            return generate(connection, tenant_id=tenant_id, job_id=job_id, root=root, request=request, dependencies=dependencies)
        except DeterminationFailure:
            connection.commit()  # Persist blocked determination attempts, never replace accepted artifacts.
            raise
    row_id, snapshot = current_revision(connection, tenant_id, job_id, request["revisionId"])
    version = snapshot["version"]
    if request["expectedVersion"] != version:
        raise DeterminationFailure("stale_locale_revision")
    if action == "export":
        return export(connection, row_id, snapshot, root, request["format"], pdf_renderer)
    connection.execute("BEGIN IMMEDIATE")
    try:
        fence(connection, snapshot, root)
        _, current = current_revision(connection, tenant_id, job_id, request["revisionId"])
        if current["version"] != version:
            raise DeterminationFailure("stale_locale_revision")
        if action == "review":
            if snapshot["accepted"]:
                raise DeterminationFailure("accepted_locale_immutable")
            decision = {"dimension": request["dimension"], "decision": request["decision"], "revisionId": snapshot["revisionId"],
                        "textSha256": snapshot["textSha256"], "recordedAt": now(), "note": request["note"]}
            snapshot["reviews"].append(decision)
        elif action == "accept":
            authority(connection, snapshot)
            if not approved_reviews(snapshot):
                raise DeterminationFailure("independent_reviews_required")
            if snapshot["findings"]:
                raise DeterminationFailure("unresolved_locale_findings")
            if any(row["decision"] == "rejected" for row in snapshot["acceptanceHistory"]):
                raise DeterminationFailure("rejected_locale_revision")
            snapshot["accepted"] = True
            snapshot["acceptanceHistory"].append({"decision": "accepted", "recordedAt": now(), "revisionId": snapshot["revisionId"], "textSha256": snapshot["textSha256"]})
        elif action == "reject":
            if snapshot["accepted"]:
                raise DeterminationFailure("accepted_locale_immutable")
            snapshot["acceptanceHistory"].append({"decision": "rejected", "recordedAt": now(), "revisionId": snapshot["revisionId"], "textSha256": snapshot["textSha256"]})
        else:
            raise DeterminationFailure("invalid_locale_operation")
        snapshot["version"] += 1
        update(connection, row_id, snapshot, version)
        fence(connection, snapshot, root)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return history(connection, tenant_id=tenant_id, job_id=job_id)


def decision_bound(row, snapshot):
    return row.get("revisionId") == snapshot["revisionId"] and row.get("textSha256") == snapshot["textSha256"]


def approved_reviews(snapshot):
    latest = {row["dimension"]: row for row in snapshot["reviews"]}
    return all(latest.get(d, {}).get("decision") == "accepted" and decision_bound(latest[d], snapshot)
               for d in ("terminology", "formatting"))


def authority(connection, snapshot, *, require_pass=True):
    repository = SqliteDeterminationRepository(connection)
    entity = snapshot["entityId"]
    translation = repository.find(snapshot["tenantId"], snapshot["translationId"])
    verification = repository.find(snapshot["tenantId"], snapshot["verificationId"])
    for envelope, kind, prompt in ((translation, "material_locale_translation", "material-locale-translation-v1"),
                                   (verification, "material_locale_verification", "material-locale-verification-v1")):
        bound = repository.bound(tenant_id=snapshot["tenantId"], entity_kind="material_locale", entity_id=entity,
                                 entity_version=snapshot["revisionId"], determination_kind=kind)
        if (envelope is None or bound is None or bound.determination_id != envelope.determination_id
                or envelope.entity_id != entity or envelope.kind != kind or envelope.schema_version != "1" or envelope.prompt_version != prompt):
            raise DeterminationFailure("locale_authority_invalid")
    result = LocaleTranslation.model_validate(translation.result)
    from jobctrl.domain.determinations import Source, validate_citations
    originals = source_lines(snapshot["source"]["text"])
    facts = [Source.model_validate(row) for row in snapshot["facts"]]
    validate_citations(result, [*originals, *facts])
    validate_translation(result, originals, facts, snapshot["protectedValues"])
    if [row.model_dump() for row in result.lines] != snapshot["lines"]:
        raise DeterminationFailure("locale_authority_invalid")
    judged = LocaleVerification.model_validate(verification.result)
    targets = [Source(source_id="translated:" + row.line_id, text=row.text) for row in result.lines]
    context = {key: snapshot[key] for key in ("source", "profileVersion", "sourceLocale", "targetLocale")}
    expected_entity = digest(json.dumps({**context, "jobId": snapshot["jobId"]}, sort_keys=True, ensure_ascii=False).encode())
    if expected_entity != snapshot["entityId"]:
        raise DeterminationFailure("locale_authority_invalid")
    for envelope, schema, sources, bound_context in (
        (translation, LocaleTranslation, [*originals, *facts], {**context, "protected_values": snapshot["protectedValues"]}),
        (verification, LocaleVerification, [*originals, *targets, *facts], context),
    ):
        if (envelope.lane != "tailoring" or locale_fingerprint(kind=envelope.kind, schema=schema, prompt_version=envelope.prompt_version,
                sources=sources, context=bound_context, envelope=envelope) != envelope.determination_id):
            raise DeterminationFailure("locale_authority_invalid")
    validate_citations(judged, [*originals, *targets, *facts])
    validate_verification(judged, originals, targets)
    if ([row.model_dump() for row in judged.lines] != snapshot["verification"]
            or snapshot["provider"] != translation.provider or snapshot["model"] != translation.model
            or snapshot["promptVersion"] != translation.prompt_version or snapshot["schemaVersion"] != translation.schema_version
            or snapshot["verificationVerdict"] != judged.verdict
            or snapshot["findings"] != [row.model_dump() for row in [*result.findings, *judged.findings]]):
        raise DeterminationFailure("locale_authority_invalid")
    if digest(snapshot["text"].encode()) != snapshot["textSha256"]:
        raise DeterminationFailure("locale_authority_invalid")
    by_id = {row.line_id: row.text for row in result.lines}
    expected_text = "\n".join(by_id.get(f"source:{index}", line) for index, line in enumerate(snapshot["source"]["text"].splitlines()))
    if snapshot["text"] != expected_text:
        raise DeterminationFailure("locale_authority_invalid")
    if require_pass and (judged.verdict != "pass" or judged.findings or any(row.verdict != "pass" for row in judged.lines)):
        raise DeterminationFailure("locale_verification_failed")


def generate(connection, *, tenant_id, job_id, root, request, dependencies=None):
    source = load_source(connection, tenant_id=tenant_id, job_id=job_id, artifact_id=request["sourceArtifactId"], root=root)
    profile, facts = profile_snapshot(connection, tenant_id)
    if source["generation"] != request["expectedGeneration"] or profile.version != request["expectedProfileVersion"]:
        raise DeterminationFailure("stale_locale_source")
    context = {"source": source, "profileVersion": profile.version, "sourceLocale": request["sourceLocale"], "targetLocale": request["targetLocale"]}
    entity = digest(json.dumps({**context, "jobId": job_id}, sort_keys=True, ensure_ascii=False).encode())
    snapshot = {"contract": CONTRACT, "tenantId": tenant_id, "jobId": job_id, "entityId": entity,
                **context, "facts": [row.model_dump() for row in facts], "protectedValues": protected_values(profile.as_dict(), source["text"])}
    if request["sourceLocale"] not in SUPPORTED_LOCALES or request["targetLocale"] not in SUPPORTED_LOCALES:
        return record_unsupported(connection, snapshot, root)
    if request["sourceLocale"] == request["targetLocale"]:
        raise DeterminationFailure("identical_locales")
    originals = source_lines(source["text"])
    deps = dependencies or determination_dependencies(connection, tenant_id=tenant_id, lane="tailoring")
    translated, translator = translate(originals=originals, facts=facts, protected=snapshot["protectedValues"],
                                       context=context, entity_id=entity, dependencies=deps)
    verdict, verifier = verify(translation=translated, originals=originals, facts=facts, context=context,
                               entity_id=entity, dependencies=deps)
    connection.commit()  # Determinations are durable even when adoption is blocked.
    snapshot.update(revisionId=str(uuid.uuid4()), version=1, createdAt=now(), accepted=False, reviews=[], acceptanceHistory=[], exports=[],
                    translationId=translator.determination_id, verificationId=verifier.determination_id,
                    provider=translator.provider, model=translator.model, promptVersion=translator.prompt_version, schemaVersion=translator.schema_version,
                    lines=[row.model_dump() for row in translated.lines],
                    findings=[row.model_dump() for row in [*translated.findings, *verdict.findings]], verificationVerdict=verdict.verdict,
                    verification=[row.model_dump() for row in verdict.lines])
    by_id = {row.line_id: row.text for row in translated.lines}
    snapshot["text"] = "\n".join(by_id.get(f"source:{index}", line) for index, line in enumerate(source["text"].splitlines()))
    snapshot["textSha256"] = digest(snapshot["text"].encode())
    # Determination locks serialize duplicate calls; the DB writer fence serializes adoption.
    connection.execute("BEGIN IMMEDIATE")
    path = None
    try:
        fence(connection, snapshot, root)
        for prior in history(connection, tenant_id=tenant_id, job_id=job_id)["variants"]:
            if prior["translationId"] == translator.determination_id and prior["verificationId"] == verifier.determination_id and not any(row["decision"] == "rejected" for row in prior["acceptanceHistory"]):
                connection.commit()
                return history(connection, tenant_id=tenant_id, job_id=job_id)
        path = output_path(root, snapshot["revisionId"], "txt")
        write_exclusive(path, snapshot["text"].encode())
        save_revision(connection, snapshot, path)
        repository = SqliteDeterminationRepository(connection)
        for envelope in (translator, verifier):
            repository.bind(tenant_id=tenant_id, entity_kind="material_locale", entity_id=entity,
                            entity_version=snapshot["revisionId"], determination_kind=envelope.kind, determination_id=envelope.determination_id)
        fence(connection, snapshot, root)
        connection.commit()
    except Exception:
        connection.rollback()
        if path and path.exists():
            path.unlink()
        raise
    return history(connection, tenant_id=tenant_id, job_id=job_id)


def output_path(root, revision, suffix):
    directory = owned_path(root, Path(root).resolve() / "generated" / "locale-variants")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return owned_path(root, directory / f"{revision}-{uuid.uuid4()}.{suffix}")


def write_exclusive(path, data):
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def document_html(snapshot):
    paragraphs = "".join(f'<p data-line-id="source:{i}">{html.escape(line)}</p>' for i, line in enumerate(snapshot["text"].splitlines()))
    return ('<!doctype html><html lang="' + html.escape(snapshot["targetLocale"], quote=True) + '"><meta charset="utf-8"><title>Reviewed locale variant</title>'
            '<style>@page{size:A4;margin:18mm}body{font:11pt sans-serif}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 8pt}</style><body>' + paragraphs + '</body></html>')


def docx_bytes(text):
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    ElementTree.register_namespace("w", namespace)
    document = ElementTree.Element("{" + namespace + "}document")
    body = ElementTree.SubElement(document, "{" + namespace + "}body")
    for line in text.splitlines():
        paragraph = ElementTree.SubElement(body, "{" + namespace + "}p")
        run = ElementTree.SubElement(paragraph, "{" + namespace + "}r")
        node = ElementTree.SubElement(run, "{" + namespace + "}t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"})
        node.text = line
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", ElementTree.tostring(document, encoding="utf-8", xml_declaration=True))
    return buffer.getvalue()


def export(connection, row_id, snapshot, root, format, pdf_renderer):
    if not snapshot["accepted"]:
        raise DeterminationFailure("accepted_locale_required")
    if (not approved_reviews(snapshot) or not snapshot["acceptanceHistory"]
            or snapshot["acceptanceHistory"][-1].get("decision") != "accepted"
            or not decision_bound(snapshot["acceptanceHistory"][-1], snapshot)):
        raise DeterminationFailure("accepted_locale_required")
    if format not in {"txt", "html", "pdf", "docx"}:
        raise DeterminationFailure("unsupported_export_format")
    authority(connection, snapshot)
    fence(connection, snapshot, root)
    path = output_path(root, snapshot["revisionId"], format)
    try:
        if format == "pdf":
            from jobctrl.infrastructure.materials.playwright_html_pdf import _render_pdf_playwright
            try:
                (pdf_renderer or _render_pdf_playwright)(document_html(snapshot), str(path))
            except ImportError:
                raise DeterminationFailure("unsupported_pdf_renderer") from None
            except Exception:
                raise DeterminationFailure("pdf_render_failed") from None
            if not path.read_bytes().startswith(b"%PDF-"):
                raise DeterminationFailure("export_validation_failed")
            # Extract actual PDF text, retaining Unicode/order. A renderer cannot authorize different claims.
            from pypdf import PdfReader
            extracted = "\n".join(page.extract_text() for page in PdfReader(path).pages)
            if " ".join(extracted.split()) != " ".join(snapshot["text"].split()):
                raise DeterminationFailure("export_validation_failed")
            os.chmod(path, 0o600)
        else:
            data = (snapshot["text"].encode() if format == "txt" else document_html(snapshot).encode() if format == "html" else docx_bytes(snapshot["text"]))
            write_exclusive(path, data)
            if path.read_bytes() != data:
                raise DeterminationFailure("export_validation_failed")
            if format == "docx":
                with zipfile.ZipFile(path) as archive:
                    tree = ElementTree.fromstring(archive.read("word/document.xml"))
                    texts = [node.text or "" for node in tree.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")]
                    if texts != snapshot["text"].splitlines():
                        raise DeterminationFailure("export_validation_failed")
        connection.execute("BEGIN IMMEDIATE")
        fence(connection, snapshot, root)
        _, current = current_revision(connection, snapshot["tenantId"], snapshot["jobId"], snapshot["revisionId"])
        if current != snapshot:
            raise DeterminationFailure("stale_locale_revision")
        authority(connection, current)
        ref = {"format": format, "sha256": digest(path.read_bytes()), "textSha256": snapshot["textSha256"], "createdAt": now()}
        cursor = connection.execute("INSERT INTO job_artifacts(tenant_id,job_id,stage,artifact_type,status,path,created_at,size_bytes,metadata_json) VALUES(?,?,'locale',?,'approved',?,?,?,?)",
                                    (snapshot["tenantId"], snapshot["jobId"], "locale_" + format, str(path), now(), path.stat().st_size, json.dumps(ref)))
        snapshot["exports"].append({**ref, "artifactId": str(cursor.lastrowid)})
        snapshot["version"] += 1
        update(connection, row_id, snapshot, snapshot["version"] - 1)
        connection.commit()
    except Exception:
        connection.rollback()
        if path.exists():
            path.unlink()
        raise
    return history(connection, tenant_id=snapshot["tenantId"], job_id=snapshot["jobId"])


def record_unsupported(connection, snapshot, root):
    """Capability failure is structural and durable; it supplies no translation authority."""
    first = source_lines(snapshot["source"]["text"])[0]
    snapshot.update(revisionId=str(uuid.uuid4()), version=1, createdAt=now(), accepted=False, reviews=[], acceptanceHistory=[], exports=[],
                    translationId=None, verificationId=None, provider="unavailable", model="unavailable", promptVersion="material-locale-translation-v1", schemaVersion="1",
                    lines=[], verification=[], text="", textSha256=digest(b""), verificationVerdict="fail",
                    findings=[{"kind": "unsupported_language", "line_id": first.source_id,
                               "source": {"source_id": first.source_id, "quote": first.text, "exact_values": []},
                               "detail": "Unsupported locale pair: " + snapshot["sourceLocale"] + " to " + snapshot["targetLocale"]}])
    connection.execute("BEGIN IMMEDIATE")
    path = None
    try:
        fence(connection, snapshot, root)
        for prior in history(connection, tenant_id=snapshot["tenantId"], job_id=snapshot["jobId"])["variants"]:
            if prior["entityId"] == snapshot["entityId"] and prior["translationId"] is None:
                connection.commit()
                return history(connection, tenant_id=snapshot["tenantId"], job_id=snapshot["jobId"])
        path = output_path(root, snapshot["revisionId"], "txt")
        write_exclusive(path, b"")
        save_revision(connection, snapshot, path)
        connection.commit()
    except Exception:
        connection.rollback()
        if path and path.exists():
            path.unlink()
        raise
    return history(connection, tenant_id=snapshot["tenantId"], job_id=snapshot["jobId"])
