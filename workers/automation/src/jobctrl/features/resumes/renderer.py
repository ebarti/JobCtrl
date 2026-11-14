"""Retained HTML/Chromium and editable DOCX renderers with immutable owned bytes."""

from __future__ import annotations

from hashlib import sha256
from collections import Counter
import ctypes
import errno
import html
import io
import math
import os
from pathlib import Path
import re
import tempfile
import stat
import sys
from uuid import uuid4

from .domain import ResumeError, digest, document_lines


def normalized(text):
    return " ".join(text.split())


class ResumeRenderer:
    def __init__(self, workspace: Path, *, browser_executable: str | None = None,
                 file_intent=None, file_abandon=None):
        self.root = Path(workspace) / "resumes-artifacts"
        self.browser_executable = browser_executable
        self.file_intent = file_intent
        self.file_abandon = file_abandon
        self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise ResumeError("unsafe_resume_artifact_root")
        descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            self.root_identity = {"device": info.st_dev, "inode": info.st_ino}
        finally:
            os.close(descriptor)

    def validate_theme(self, theme):
        if not isinstance(theme, dict):
            raise ResumeError("invalid_resume_theme")
        if not isinstance(theme.get("hiddenSections", []), list) or theme.get("hiddenSections"):
            raise ResumeError("full_baseline_sections_cannot_be_hidden")
        sections = theme.get("sectionOrder", ["summary", "experience", "education", "skills"])
        required = {"summary", "experience", "education", "skills"}
        if (not isinstance(sections, list) or any(not isinstance(section, str) for section in sections)
                or len(sections) != len(set(sections)) or not required.issubset(sections)
                or set(sections) - required - {"languages"}):
            raise ResumeError("full_baseline_sections_required")
        if theme.get("pageSize", "a4") not in {"a4", "letter"}:
            raise ResumeError("unsupported_resume_page_size")
        from .html_renderer import FONT_STACKS, DENSITY_SCALE, BULLET_SPACING
        choices = {"fontFamily": FONT_STACKS, "density": DENSITY_SCALE, "bulletSpacing": BULLET_SPACING,
                   "headerLayout": {"centered", "left", "split"}, "sectionHeadingStyle": {"rule", "plain", "boxed"},
                   "alignment": {"left", "justified"}}
        if any(key in theme and theme[key] not in allowed for key, allowed in choices.items()):
            raise ResumeError("invalid_resume_theme")
        if "accentColor" in theme and (not isinstance(theme["accentColor"], str)
                                       or not re.fullmatch(r"#[0-9a-fA-F]{6}", theme["accentColor"])):
            raise ResumeError("invalid_resume_theme")
        for key, minimum, maximum in (("fontScale", .85, 1.2),):
            if key in theme and (type(theme[key]) not in (int, float) or not math.isfinite(theme[key])
                                 or not minimum <= theme[key] <= maximum):
                raise ResumeError("invalid_resume_theme")
        margins = theme.get("marginMm", {})
        if not isinstance(margins, dict) or set(margins) - {"top", "right", "bottom", "left"} or any(type(value) not in (int, float) or not math.isfinite(value)
                                               or not 8 <= value <= 28 for value in margins.values()):
            raise ResumeError("invalid_resume_theme")
        if "maxPages" in theme and (type(theme["maxPages"]) is not int or theme["maxPages"] < 1):
            raise ResumeError("invalid_explicit_page_limit")

    def html(self, document, theme, plate_document=None, template_layout=None):
        from .html_renderer import build_resume_html, build_resume_html_document
        self.validate_theme(theme)
        source_html = build_resume_html(document, resume_theme=theme)
        if template_layout and template_layout.get("plateDocument"):
            source_html = apply_template_styles(source_html, template_layout["plateDocument"])
        if plate_document is None:
            return source_html
        from bs4 import BeautifulSoup
        body = "".join(plate_node_html(node) for node in plate_document)
        source = BeautifulSoup(source_html, "html.parser")
        edited = BeautifulSoup(body, "html.parser")

        def inventory(soup):
            return [(node.get("data-resume-layout-target"), normalized(node.get_text("", strip=False)))
                    for node in soup.select("[data-resume-layout-target]")]

        source_links = [(normalized(node.get_text("", strip=False)), node.get("href", "")) for node in source.body.find_all("a")]
        edited_links = [(normalized(node.get_text("", strip=False)), node.get("href", "")) for node in edited.find_all("a")]
        if (inventory(source) != inventory(edited) or source_links != edited_links or
                normalized(source.body.get_text("", strip=False)) != normalized(edited.get_text("", strip=False))):
            raise ResumeError("editor_source_binding_invalid")
        for original, target in zip(source.select("[data-resume-layout-target]"), edited.select("[data-resume-layout-target]")):
            if original.get("data-resume-line-number"):
                target["data-resume-line-number"] = original["data-resume-line-number"]
            else:
                target.attrs.pop("data-resume-line-number", None)
        return build_resume_html_document(str(edited), resume_theme=theme)

    def render(self, document, theme, binding):
        from .html_renderer import render_resume_html_to_pdf, normalize_resume_date_range
        from pypdf import PdfReader
        html_content = self.html(document, theme, binding.get("plate_document"), binding.get("template_layout"))
        # Temporary and final files are owned by this renderer, never accepted paths.
        with tempfile.TemporaryDirectory(prefix="resume-render-", dir=self.root) as temporary:
            output = Path(temporary) / "candidate.pdf"
            boxes = render_resume_html_to_pdf(html_content, str(output), executable_path=self.browser_executable)
            data = output.read_bytes()
        if not data.startswith(b"%PDF-"):
            raise ResumeError("resume_renderer_invalid_pdf")
        reader = PdfReader(io.BytesIO(data))
        page_texts = [normalized(page.extract_text() or "") for page in reader.pages]
        text = normalized(" ".join(page_texts))
        missing = []
        expected_counts = Counter()
        source_groups = {}
        for line in document_lines(document):
            expected = normalize_resume_date_range(line["text"]) if line["source_id"].endswith(":date_range") else line["text"]
            if line["source_id"].startswith("heading:"):
                expected = expected.upper()
            expected = normalized(expected)
            expected_counts[expected] += 1
            source_groups.setdefault(expected, []).append(line["source_id"])
            if expected not in text:
                missing.append(line["source_id"])
        shortfalls = [{"source_ids": source_groups[fragment], "expected_occurrences": count,
                       "observed_occurrences": text.count(fragment)}
                      for fragment, count in expected_counts.items() if text.count(fragment) < count]
        for group in shortfalls:
            missing.extend(group["source_ids"])
        if missing:
            raise ResumeError("resume_pdf_source_text_missing",
                              "The PDF did not preserve every source line; the accepted artifact is unchanged.",
                              details={"source_ids": sorted(set(missing)), "occurrence_shortfalls": shortfalls})
        for box in boxes:
            excerpt = normalized(box.get("text_excerpt", ""))
            pages = [index + 1 for index, page_text in enumerate(page_texts) if excerpt and excerpt in page_text]
            box.update(dom_page_number=box.get("page_number"),
                       page_number=pages[0] if len(pages) == 1 else None,
                       physical_page_numbers=pages, page_number_verified=len(pages) == 1,
                       coordinate_space="continuous_dom", geometry_physical_verified=False)
        conflicts = [{"kind": "horizontal_overflow", "source_id": row.get("semantic_id")}
                     for row in boxes if row.get("horizontal_overflow") or row.get("left_pct", 0) < 0 or
                     row.get("left_pct", 0) + row.get("width_pct", 0) > 100.1]
        if theme.get("maxPages") is not None:
            if type(theme["maxPages"]) is not int or theme["maxPages"] < 1:
                raise ResumeError("invalid_explicit_page_limit")
            if len(reader.pages) > theme["maxPages"]:
                conflicts.append({"kind": "explicit_page_limit", "requested": theme["maxPages"],
                                  "actual": len(reader.pages)})
        if binding.get("ephemeral") is True:
            return {"data": data, "page_count": len(reader.pages), "layout_conflicts": conflicts,
                    "text_verified": True}
        artifact_id = str(uuid4())
        filename = artifact_id + ".pdf"
        file_identity = self._write(filename, data, binding)
        return {"artifact_id": artifact_id, "path": str(self.root / filename), "filename": filename,
                "sha256": sha256(data).hexdigest(), "size_bytes": len(data), "format": "pdf",
                "file_identity": file_identity, "root_identity": dict(self.root_identity),
                "page_count": len(reader.pages), "layout_boxes": boxes, "layout_conflicts": conflicts,
                "layout_metadata": {"coordinate_space": "continuous_dom", "geometry_physical_verified": False,
                                    "physical_page_binding": "exact_literal_source_text"},
                "text_verified": True, "resume_id": binding["resume_id"], "revision_id": binding["revision_id"]}

    def _root_fd(self):
        try:
            descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(descriptor)
            if {"device": info.st_dev, "inode": info.st_ino} != self.root_identity:
                os.close(descriptor)
                raise ResumeError("resume_artifact_root_changed")
            return descriptor
        except OSError:
            raise ResumeError("unsafe_resume_artifact_root") from None

    def _write(self, filename, data, binding):
        root_fd = self._root_fd()
        authority = None
        recorded = False
        try:
            fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
            with os.fdopen(fd, "wb") as stream:
                info = os.fstat(stream.fileno())
                identity = {"device": info.st_dev, "inode": info.st_ino}
                authority = {"artifact_id": filename.removesuffix(".pdf"), "filename": filename,
                             "path": str(self.root / filename), "sha256": sha256(data).hexdigest(),
                             "size_bytes": len(data), "file_identity": identity, "root_identity": dict(self.root_identity),
                             "resume_id": binding["resume_id"], "revision_id": binding["revision_id"]}
                if self.file_intent is not None:
                    self.file_intent(authority, binding)
                    recorded = True
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            if recorded and self.file_abandon is not None:
                self.file_abandon(authority["artifact_id"])
            elif authority is not None:
                try:
                    self.retire_pdf(authority, f".retired-{authority['artifact_id']}-{uuid4().hex}.pdf", allow_partial=True)
                except Exception:
                    pass  # Unknown or replaced bytes are preserved, never guessed away.
            raise
        finally:
            os.close(root_fd)
        return identity

    def read_pdf(self, artifact):
        filename = artifact.get("filename", "")
        if not re.fullmatch(r"[0-9a-f-]{36}\.pdf", filename) or str(self.root / filename) != artifact.get("path"):
            raise ResumeError("unsafe_resume_artifact_path")
        root_fd = self._root_fd()
        try:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != artifact["size_bytes"]:
                    raise ResumeError("resume_artifact_bytes_changed")
                identity = artifact.get("file_identity")
                if identity is not None and identity != {"device": info.st_dev, "inode": info.st_ino}:
                    raise ResumeError("resume_artifact_identity_changed")
                if artifact.get("root_identity", self.root_identity) != self.root_identity:
                    raise ResumeError("resume_artifact_root_changed")
                data = stream.read(artifact["size_bytes"] + 1)
        except OSError:
            raise ResumeError("resume_artifact_unavailable") from None
        finally:
            os.close(root_fd)
        if sha256(data).hexdigest() != artifact["sha256"] or len(data) != artifact["size_bytes"]:
            raise ResumeError("resume_artifact_bytes_changed")
        return data

    def retire_pdf(self, artifact, claim_name, *, allow_partial=False):
        """Retire a committed journal's exact inode through an exclusive claim.

        The DB deletion has already committed. No active document points at the
        source. No-follow descriptor reads, recorded root/inode/hash and a
        no-overwrite rename preserve foreign replacements and unrelated files.
        A retained claim is retryable after process interruption.
        """
        filename = artifact.get("filename", "")
        if (not re.fullmatch(r"[0-9a-f-]{36}\.pdf", filename)
                or not re.fullmatch(r"\.retired-[0-9a-f-]{36}-[0-9a-f]{32}\.pdf", claim_name)
                or str(self.root / filename) != artifact.get("path")):
            raise ResumeError("unsafe_resume_artifact_path")
        if not artifact.get("file_identity") or artifact.get("root_identity") != self.root_identity:
            raise ResumeError("retirement_identity_unrecorded_or_changed")
        root_fd = self._root_fd()

        def present(name):
            try:
                os.stat(name, dir_fd=root_fd, follow_symlinks=False)
                return True
            except FileNotFoundError:
                return False

        def verify(name):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
            with os.fdopen(descriptor, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                        (not allow_partial and info.st_size != artifact["size_bytes"])
                        or {"device": info.st_dev, "inode": info.st_ino} != artifact["file_identity"]):
                    raise ResumeError("retirement_source_identity_changed")
                if allow_partial:
                    return
                digest_value = sha256()
                while chunk := stream.read(1024 * 1024):
                    digest_value.update(chunk)
                if not allow_partial and digest_value.hexdigest() != artifact["sha256"]:
                    raise ResumeError("retirement_source_bytes_changed")

        try:
            if not present(claim_name):
                if not present(filename):
                    return {"status": "already_absent"}
                verify(filename)
                try:
                    rename_exclusive(root_fd, filename, root_fd, claim_name)
                except FileNotFoundError:
                    if not present(claim_name) and not present(filename):
                        return {"status": "already_absent"}
                    raise
                try:
                    verify(claim_name)
                except Exception:
                    try:
                        rename_exclusive(root_fd, claim_name, root_fd, filename)
                    except OSError:
                        pass  # A foreign successor is never overwritten.
                    raise
            verify(claim_name)
            info = os.stat(claim_name, dir_fd=root_fd, follow_symlinks=False)
            if {"device": info.st_dev, "inode": info.st_ino} != artifact["file_identity"]:
                raise ResumeError("retirement_source_identity_changed")
            os.unlink(claim_name, dir_fd=root_fd)
            os.fsync(root_fd)
            return {"status": "retired", "foreign_successor_preserved": present(filename)}
        except OSError:
            raise ResumeError("resume_artifact_retirement_unavailable") from None
        finally:
            os.close(root_fd)

    def export(self, revision, format):
        plate = (revision.get("edit_draft") or {}).get("plate_document")
        if format == "pdf":
            if not revision["renders"]:
                raise ResumeError("resume_render_required")
            return self.read_pdf(revision["renders"][-1]), "application/pdf", ".pdf"
        if format == "html":
            return self.html(revision["document"], revision["theme"], plate,
                             (revision.get("template") or {}).get("layout")).encode(), "text/html; charset=utf-8", ".html"
        lines = document_lines(revision["document"])
        text = "\n".join(row["text"] for row in lines)
        if format == "txt":
            return text.encode(), "text/plain; charset=utf-8", ".txt"
        if format == "docx":
            from .export_document import EditableDocument, ExportSettings, Paragraph
            from .docx import render_docx, validate_docx
            paragraphs = []
            for row in lines:
                identity = row["source_id"]
                style = "Title" if identity == "personal:full_name" else (
                    "Heading1" if identity.startswith("heading:") else
                    "ListParagraph" if identity.startswith("achievement:") else "Normal")
                paragraphs.append(Paragraph("- " + row["text"] if style == "ListParagraph" else row["text"], style))
            document = EditableDocument(tuple(paragraphs), revision.get("locale", "und"), ())
            settings = ExportSettings(paper="Letter" if revision["theme"].get("pageSize") == "letter" else "A4")
            binding = {"sourceArtifactId": revision["revision_id"], "sourceSha256": digest(revision["document"]),
                       "revision_id": revision["revision_id"], "profile_revision": revision["profile_revision"]}
            data = render_docx(document, settings, binding)
            validate_docx(data, document, binding)
            return data, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"
        raise ResumeError("unsupported_resume_export")


TAGS = {"article", "div", "h1", "h2", "h3", "header", "li", "main", "p", "section", "ul",
        "a", "b", "em", "span", "strong", "u"}


def rename_exclusive(source_fd, source, destination_fd, destination):
    """Native atomic no-overwrite rename; unsupported platforms refuse cleanup."""
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        operation, flag = getattr(library, "renameatx_np", None), 0x00000004  # SDK sys/stdio.h RENAME_EXCL.
    elif sys.platform.startswith("linux"):
        operation, flag = getattr(library, "renameat2", None), 1  # Linux UAPI RENAME_NOREPLACE.
    else:
        operation, flag = None, 0
    if operation is None:
        raise ResumeError("resume_retirement_platform_unsupported")
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    operation.restype = ctypes.c_int
    if operation(source_fd, os.fsencode(source), destination_fd, os.fsencode(destination), flag):
        code = ctypes.get_errno()
        if code == errno.ENOENT:
            raise FileNotFoundError(code, "Owned retirement source is absent.")
        raise OSError(code, "Exclusive owned retirement claim failed.")


def plate_node_html(node):
    """Serialize the retained Plate schema with a literal allowlist, never raw HTML."""
    if not isinstance(node, dict):
        raise ResumeError("invalid_editor_document")
    if isinstance(node.get("text"), str):
        result = html.escape(node["text"])
        for flag, tag in (("underline", "u"), ("italic", "em"), ("bold", "strong")):
            if node.get(flag) is True:
                result = f"<{tag}>{result}</{tag}>"
        return result
    tag = node.get("tagName", "div")
    tag = tag.lower() if isinstance(tag, str) else "div"
    if tag not in TAGS:
        tag = "div"
    attributes = []
    classes = str(node.get("className", "")).split()
    if classes:
        attributes.append(("class", " ".join(value for value in classes if re.fullmatch(r"[a-zA-Z0-9_-]+", value))))
    for field, attr in (("semanticId", "data-resume-layout-target"), ("lineNumber", "data-resume-line-number"),
                        ("pageNumber", "data-resume-page")):
        if node.get(field) is not None:
            attributes.append((attr, str(node[field])))
    if tag == "a":
        href = node.get("href", "")
        if isinstance(href, str) and href.lower().startswith(("http:", "https:", "mailto:", "tel:")):
            attributes.append(("href", href))
        else:
            tag = "span"
    styles = []
    if node.get("textAlign") in {"left", "center", "right"}:
        styles.append("text-align:" + node["textAlign"])
    from .html_renderer import FONT_STACKS
    if node.get("fontFamily") in FONT_STACKS:
        styles.append("font-family:" + FONT_STACKS[node["fontFamily"]])
    size = node.get("fontSize")
    if type(size) in (int, float) and math.isfinite(size) and .5 < size < 3:
        styles.append(f"font-size:{size:.2f}em")
    elif size in ("heading", "large", "small"):
        styles.append("font-size:" + {"heading": "14pt", "large": "12pt", "small": "9pt"}[size])
    if styles:
        attributes.append(("style", ";".join(styles)))
    attrs = "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in attributes)
    children = node.get("children", [])
    if not isinstance(children, list):
        raise ResumeError("invalid_editor_document")
    return f"<{tag}{attrs}>" + "".join(plate_node_html(child) for child in children) + f"</{tag}>"


def apply_template_styles(source_html, nodes):
    """Transfer presentation by recorded field ID; never copy template claim text."""
    from bs4 import BeautifulSoup
    template = BeautifulSoup("".join(plate_node_html(node) for node in nodes), "html.parser")
    document = BeautifulSoup(source_html, "html.parser")
    styles = {}
    for node in template.select("[data-resume-layout-target]"):
        declarations = [node.get("style", "")]
        if node.find(["b", "strong"]):
            declarations.append("font-weight:700")
        if node.find(["em", "i"]):
            declarations.append("font-style:italic")
        if node.find("u"):
            declarations.append("text-decoration:underline")
        styles[node["data-resume-layout-target"]] = ";".join(value for value in declarations if value)
    for node in document.select("[data-resume-layout-target]"):
        style = styles.get(node["data-resume-layout-target"])
        if style:
            node["style"] = style
    return str(document)
