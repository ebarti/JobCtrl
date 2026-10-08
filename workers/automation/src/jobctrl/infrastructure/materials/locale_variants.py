"""Exact-v14 locale history in Materials metadata; staged immutable export sets."""

from __future__ import annotations

import html
import io
import json
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.locale_variants import LOCALES, NAMESPACE, digest, translate_document
from jobctrl.domain.profile.canonical_sources import profile_sources
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, determination_dependencies
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository


def now():
    return datetime.now(timezone.utc).isoformat()


def contained(root, path):
    root, path = Path(root).resolve(), Path(path)
    if not path.is_absolute() or root not in path.parents:
        raise DeterminationFailure("unsafe_material_path")
    for item in [path, *path.parents]:
        if item == root:
            break
        if item.is_symlink():
            raise DeterminationFailure("unsafe_material_path")
    if root not in path.resolve().parents:
        raise DeterminationFailure("unsafe_material_path")
    return path


def historical_values(profile):
    values = [profile.get("personal", {}).get("full_name", "")]
    resume = profile.get("resume", {})
    for row in resume.get("experience_entries", []):
        values.extend(row.get(key, "") for key in ("title", "company", "location", "date_range"))
    for row in resume.get("education_entries", []):
        values.extend(row.get(key, "") for key in ("degree", "institution", "location", "date"))
    return list(dict.fromkeys(value for value in values if isinstance(value, str) and value))


class LocaleVariants:
    def __init__(self, connection, *, app_dir, tenant_id="local", dependencies=None, renderer=None):
        self.conn = connection
        self.root = Path(app_dir).resolve()
        self.tenant = tenant_id
        self.dependencies = dependencies
        self.renderer = renderer or render_pdf

    def history(self, job_id):
        job_id = str(canonical_job_id(job_id))
        from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader

        if SqlitePreparationTargetReader(self.conn).load(TenantId(self.tenant), canonical_job_id(job_id)) is None:
            raise DeterminationFailure("unknown_job")
        variants, revision = [], 0
        for generation, metadata in self.conn.execute(
            "SELECT generation,metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? ORDER BY generation",
            (self.tenant, job_id),
        ):
            namespace = json.loads(metadata or "{}").get(NAMESPACE)
            if namespace is None:
                continue
            if namespace.get("version") != 1:
                raise DeterminationFailure("locale_history_version")
            revision += namespace["revision"]
            for variant in namespace["variants"]:
                self._validate_authority(variant, job_id=job_id, generation=generation)
            variants.extend(namespace["variants"])
        sources = []
        for row in self.conn.execute(
            "SELECT artifact_id,generation,artifact_type,path FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND status='approved' AND artifact_type IN ('tailored_resume','cover_letter') ORDER BY generation DESC",
            (self.tenant, job_id),
        ):
            sources.append(
                dict(
                    artifactId=row[0],
                    generation=row[1],
                    kind="resume" if row[2] == "tailored_resume" else "cover_letter",
                )
            )
        return dict(ok=True, revision=revision, locales=list(LOCALES), sources=sources, variants=variants)

    def _validate_authority(self, variant, *, job_id, generation):
        binding = dict(variant["binding"])
        identity = binding.pop("identity")
        if (
            identity != "locale:" + digest(binding)
            or variant["variantId"] != identity
            or binding["jobId"] != job_id
            or binding["generation"] != generation
        ):
            raise DeterminationFailure("locale_binding_invalid")
        repository = SqliteDeterminationRepository(self.conn)
        kinds = ["material_locale_translation", "material_locale_review", "claim_verification", "artifact_quality"]
        if [row["kind"] for row in variant["determinations"]] != kinds:
            raise DeterminationFailure("locale_binding_invalid")
        for recorded in variant["determinations"]:
            envelope = repository.find(self.tenant, recorded["determination_id"])
            if (
                envelope is None
                or envelope.model_dump() != recorded
                or envelope.entity_id != identity
                or envelope.lane != "tailoring"
            ):
                raise DeterminationFailure("locale_binding_invalid")
        translation, review, claims, quality = [row["result"] for row in variant["determinations"]]
        if (
            variant["lines"] != translation["lines"]
            or variant["semanticReview"] != review
            or variant["issues"] != translation["issues"] + review["issues"]
        ):
            raise DeterminationFailure("locale_binding_invalid")
        eligible = (
            review["verdict"] == "pass"
            and claims["verdict"] == "pass"
            and all(row["verdict"] == "pass" for row in claims["lines"])
            and quality["verdict"] == "pass"
            and all(issue["kind"] == "ambiguous_credential" for issue in variant["issues"])
        )
        if eligible != variant["eligible"] or (variant["status"] == "accepted" and not eligible):
            raise DeterminationFailure("locale_binding_invalid")
        document_hash = digest(variant["lines"])
        reviews = variant["reviews"]
        if any(row["sourceHash"] != binding["sourceHash"] or row["documentHash"] != document_hash for row in reviews):
            raise DeterminationFailure("locale_acceptance_invalid")
        if variant["status"] == "candidate":
            if reviews or variant["exports"]:
                raise DeterminationFailure("locale_acceptance_invalid")
        elif variant["status"] == "accepted":
            if [(row["kind"], row["decision"]) for row in reviews] != [
                ("terminology", "confirmed"),
                ("formatting", "confirmed"),
                ("acceptance", "accepted"),
            ] or set(variant["exports"]) != {"text", "html", "pdf", "docx"}:
                raise DeterminationFailure("locale_acceptance_invalid")
            if any(
                manifest["documentHash"] != document_hash
                or manifest["lineIds"] != [row["line_id"] for row in variant["lines"]]
                for manifest in variant["exports"].values()
            ):
                raise DeterminationFailure("locale_acceptance_invalid")
        elif (
            variant["status"] != "rejected"
            or variant["exports"]
            or not reviews
            or (reviews[-1]["kind"], reviews[-1]["decision"]) != ("acceptance", "rejected")
        ):
            raise DeterminationFailure("locale_acceptance_invalid")

    def binding(self, job_id, artifact_id, source_locale, target_locale):
        row = self.conn.execute(
            "SELECT generation,artifact_type,path,metadata_json,created_at FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_id=? AND status='approved' AND artifact_type IN ('tailored_resume','cover_letter')",
            (self.tenant, job_id, artifact_id),
        ).fetchone()
        if row is None:
            raise DeterminationFailure("accepted_source_unavailable")
        path = contained(self.root, Path(row[2]))
        try:
            data = path.read_bytes()
            text = data.decode("utf-8")
        except (OSError, UnicodeError):
            raise DeterminationFailure("source_file_unavailable") from None
        if not data or len(data) > 128000:
            raise DeterminationFailure("source_size_invalid")
        snapshot = SqliteProfileRepository(self.conn, publisher=get_default_publisher()).load_snapshot(
            TenantId(self.tenant)
        )
        profile = snapshot.as_dict()
        values = historical_values(profile)
        lines = [
            dict(line_id=f"source:{index}", text=line, protected=[value for value in values if value in line])
            for index, line in enumerate(text.splitlines())
            if line
        ]
        if not lines or len(lines) > 1000:
            raise DeterminationFailure("invalid_line_inventory")
        result = dict(
            artifactId=artifact_id,
            jobId=job_id,
            generation=row[0],
            kind="resume" if row[1] == "tailored_resume" else "cover_letter",
            sourceHash=digest(data),
            sourceMetadataHash=digest(json.loads(row[3] or "{}")),
            sourceAcceptance={"status": "approved", "artifactCreatedAt": row[4]},
            profileVersion=snapshot.version,
            profileHash=digest(profile),
            sourceLocale=source_locale,
            targetLocale=target_locale,
            facts=[source.model_dump() for source in profile_sources(profile)],
            lines=lines,
        )
        result["identity"] = "locale:" + digest(result)
        return result

    def assert_binding(self, binding):
        current = self.binding(
            binding["jobId"], binding["artifactId"], binding["sourceLocale"], binding["targetLocale"]
        )
        if current != binding:
            raise DeterminationFailure("stale_source_or_profile")

    def generate(self, command):
        if command.sourceLocale not in LOCALES or command.targetLocale not in LOCALES:
            raise DeterminationFailure("unsupported_locale")
        job_id = str(canonical_job_id(command.jobId))
        history = self.history(job_id)
        if history["revision"] != command.expectedRevision:
            raise DeterminationFailure("stale_locale_revision")
        binding = self.binding(job_id, command.artifactId, command.sourceLocale, command.targetLocale)
        # Repeat requests return the exact persisted variant, including acceptance.
        prior = next((row for row in history["variants"] if row["binding"] == binding), None)
        if prior:
            return history
        deps = dict(self.dependencies or determination_dependencies(self.conn, tenant_id=self.tenant, lane="tailoring"))
        preflight = deps["preflight"]

        def fenced_preflight():
            self.assert_binding(binding)
            if self.history(job_id)["revision"] != command.expectedRevision:
                raise DeterminationFailure("stale_locale_revision")
            preflight()

        deps["preflight"] = fenced_preflight
        result = translate_document(binding=binding, dependencies=deps)
        variant = dict(
            variantId=binding["identity"],
            revision=command.expectedRevision + 1,
            binding=binding,
            **result,
            status="candidate",
            reviews=[],
            exports={},
            createdAt=now(),
        )
        self._publish(
            job_id, binding["generation"], command.expectedRevision, binding, lambda rows: rows.append(variant)
        )
        return self.history(job_id)

    def _publish(self, job_id, generation, revision, binding, change):
        if self.conn.in_transaction:
            raise DeterminationFailure("unexpected_locale_transaction")
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            if self.history(job_id)["revision"] != revision:
                raise DeterminationFailure("stale_locale_revision")
            self.assert_binding(binding)
            row = self.conn.execute(
                "SELECT metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? AND generation=?",
                (self.tenant, job_id, generation),
            ).fetchone()
            if row is None:
                raise DeterminationFailure("accepted_source_unavailable")
            metadata = json.loads(row[0] or "{}")
            namespace = metadata.setdefault(NAMESPACE, dict(version=1, revision=0, variants=[]))
            change(namespace["variants"])
            namespace["revision"] += 1
            repository = SqliteDeterminationRepository(self.conn)
            for variant in namespace["variants"]:
                for envelope in variant["determinations"]:
                    repository.bind(
                        tenant_id=self.tenant,
                        entity_kind="material_locale",
                        entity_id=variant["variantId"],
                        entity_version=variant["binding"]["sourceHash"],
                        determination_kind=envelope["kind"],
                        determination_id=envelope["determination_id"],
                    )
            self.conn.execute(
                "UPDATE job_materials SET metadata_json=? WHERE tenant_id=? AND job_id=? AND generation=?",
                (json.dumps(metadata, ensure_ascii=False), self.tenant, job_id, generation),
            )
            self.conn.commit()
        except BaseException:
            self.conn.rollback()
            raise

    def review(self, command):
        history = self.history(command.jobId)
        if history["revision"] != command.expectedRevision:
            raise DeterminationFailure("stale_locale_revision")
        variant = next((row for row in history["variants"] if row["variantId"] == command.variantId), None)
        if not variant or variant["status"] != "candidate":
            raise DeterminationFailure("locale_review_terminal_or_missing")
        if command.decision not in ("accepted", "rejected"):
            raise DeterminationFailure("review_decision_required")
        self.assert_binding(variant["binding"])
        if command.decision == "accepted" and (
            not variant["eligible"] or command.terminology != "confirmed" or command.formatting != "confirmed"
        ):
            raise DeterminationFailure("independent_reviews_required")
        destination = None
        manifest = {}
        if command.decision == "accepted":
            destination, manifest = self.stage_exports(variant)
        timestamp = now()

        def change(rows):
            current = next(row for row in rows if row["variantId"] == command.variantId)
            current.update(status=command.decision, exports=manifest)
            current["reviews"].extend(
                [
                    dict(
                        kind=kind,
                        decision=decision,
                        reviewedAt=timestamp,
                        sourceHash=variant["binding"]["sourceHash"],
                        documentHash=digest(variant["lines"]),
                    )
                    for kind, decision in [
                        ("terminology", command.terminology),
                        ("formatting", command.formatting),
                        ("acceptance", command.decision),
                    ]
                    if decision is not None
                ]
            )

        try:
            self._publish(
                command.jobId, variant["binding"]["generation"], command.expectedRevision, variant["binding"], change
            )
        except BaseException:
            if destination:
                shutil.rmtree(destination)
            raise
        return self.history(command.jobId)

    def stage_exports(self, variant):
        export_root = contained(self.root, self.root / "locale-variants")
        export_root.mkdir(mode=0o700, exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix="accepted-", dir=export_root))
        try:
            texts = [row["text"] for row in variant["lines"]]
            text = "\n".join(texts) + "\n"
            markup = (
                '<!doctype html><html lang="'
                + variant["binding"]["targetLocale"]
                + '"><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:11pt sans-serif}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>'
                + "".join(
                    '<p data-line="'
                    + html.escape(row["line_id"], quote=True)
                    + '">'
                    + html.escape(row["text"])
                    + "</p>"
                    for row in variant["lines"]
                )
                + "</body></html>"
            )
            (destination / "document.txt").write_text(text, encoding="utf-8")
            (destination / "document.html").write_text(markup, encoding="utf-8")
            (destination / "document.docx").write_bytes(docx(texts))
            self.renderer(markup, destination / "document.pdf")
            validate_exports(destination, texts)
            return destination, {
                fmt: dict(
                    path=str(destination / ("document." + ext)),
                    hash=digest((destination / ("document." + ext)).read_bytes()),
                    documentHash=digest(variant["lines"]),
                    lineIds=[row["line_id"] for row in variant["lines"]],
                )
                for fmt, ext in [("text", "txt"), ("html", "html"), ("pdf", "pdf"), ("docx", "docx")]
            }
        except BaseException:
            shutil.rmtree(destination)
            raise

    def export(self, command):
        history = self.history(command.jobId)
        variant = next((row for row in history["variants"] if row["variantId"] == command.variantId), None)
        if not variant or variant["status"] != "accepted" or command.format not in variant["exports"]:
            raise DeterminationFailure("accepted_locale_export_required")
        manifest = variant["exports"][command.format]
        try:
            path = contained(self.root, Path(manifest["path"]))
            data = path.read_bytes()
        except OSError:
            raise DeterminationFailure("locale_export_unavailable") from None
        if digest(data) != manifest["hash"] or manifest["documentHash"] != digest(variant["lines"]):
            raise DeterminationFailure("locale_export_tampered")
        import base64

        return dict(ok=True, data=base64.b64encode(data).decode(), hash=manifest["hash"], format=command.format)

    def execute(self, command):
        if command.operation == "list":
            return self.history(command.jobId)
        return getattr(self, command.operation)(command)


def render_pdf(markup, destination):
    from jobctrl.infrastructure.materials.playwright_html_pdf import _render_pdf_playwright

    _render_pdf_playwright(markup, str(destination))


def docx(lines):
    output = io.BytesIO()
    document = (
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + "".join('<w:p><w:r><w:t xml:space="preserve">' + html.escape(line) + "</w:t></w:r></w:p>" for line in lines)
        + "<w:sectPr/></w:body></w:document>"
    )
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        archive.writestr("word/document.xml", document)
    return output.getvalue()


def validate_exports(directory, lines):
    from bs4 import BeautifulSoup
    from pypdf import PdfReader

    if (directory / "document.txt").read_text() != "\n".join(lines) + "\n":
        raise DeterminationFailure("export_parity_invalid")
    if [
        p.get_text() for p in BeautifulSoup((directory / "document.html").read_text(), "html.parser").find_all("p")
    ] != lines:
        raise DeterminationFailure("export_parity_invalid")
    with zipfile.ZipFile(directory / "document.docx") as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
        if [
            node.text or "" for node in document.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
        ] != lines:
            raise DeterminationFailure("export_parity_invalid")
    pdf = PdfReader(directory / "document.pdf")
    # PDF line wrapping is a representation transform; compare ordered glyphs,
    # ignoring only whitespace, against every accepted line, with no extra text.
    actual = "".join("".join(page.extract_text().split()) for page in pdf.pages)
    if not pdf.pages or actual != "".join("".join(line.split()) for line in lines):
        raise DeterminationFailure("export_parity_invalid")
