"""Mechanical projection of an accepted text artifact into editable paragraphs.

The saved artifact is authoritative. Never rebuild it from today's profile or
infer missing structure/locale from prose. Headings and bullets below are the
literal serialization emitted by ResumeAssembler, not semantic classifiers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

CONTRACT = "accepted-material-docx-v1"
SECTION_HEADINGS = ("EXECUTIVE PROFILE", "EXPERIENCE", "EDUCATION", "SKILLS")
LAYOUT_LIMITS = (
    "DOCX uses a single-column editable layout; PDF/HTML fonts, pagination, "
    "columns, images and custom styling are not reproduced.",
    "Contact text is preserved; automatic hyperlinks and inline rich formatting are not added.",
)


class ExportFailure(ValueError):
    """Stable, content-free failure safe to display at the CLI boundary."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class ExportSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    format: Literal["docx"] = "docx"
    layout: Literal["semantic-v1"] = "semantic-v1"
    paper: Literal["A4", "Letter"] = "A4"
    # A language tag labels existing text; it never requests a translation.
    # None inherits recorded metadata, otherwise unrecorded language stays und.
    locale: str | None = Field(default=None, pattern=r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")


def parse_settings(value: dict) -> ExportSettings:
    if value.get("format", "docx") != "docx":
        raise ExportFailure("unsupported_export_format")
    try:
        return ExportSettings.model_validate(value)
    except ValidationError:
        raise ExportFailure("unsupported_export_settings") from None


@dataclass(frozen=True)
class Paragraph:
    text: str
    style: Literal["Normal", "Title", "Heading1", "ListParagraph"] = "Normal"


@dataclass(frozen=True)
class EditableDocument:
    paragraphs: tuple[Paragraph, ...]
    locale: str
    warnings: tuple[str, ...]


def project_text(text: str, *, kind: str, locale: str) -> EditableDocument:
    """Preserve text order/whitespace; only line endings become paragraphs."""
    if kind not in {"tailored_resume", "cover_letter"}:
        raise ExportFailure("unsupported_source_kind")
    if not text.strip():
        raise ExportFailure("source_text_empty")
    if any(not (c in "\t\n\r" or 0x20 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD
                or 0x10000 <= ord(c) <= 0x10FFFF) for c in text):
        raise ExportFailure("unsupported_source_characters")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    # Require the complete, ordered and unambiguous serialized heading inventory.
    # Edited/legacy layouts remain literal paragraphs, without guessed sections.
    headings = [line for line in lines if line in SECTION_HEADINGS]
    structured = kind == "tailored_resume" and headings == list(SECTION_HEADINGS)
    warnings = list(LAYOUT_LIMITS)
    if kind == "tailored_resume" and not structured:
        warnings.append("Unrecognized resume structure: every source line is retained as a plain paragraph.")
    if locale == "und":
        warnings.append("Source language was not recorded; the document language is undetermined (und).")
    paragraphs = []
    for index, line in enumerate(lines):
        style = "Normal"
        if structured:
            if line in SECTION_HEADINGS:
                style = "Heading1"
            elif index == 0:
                style = "Title"
            elif line.startswith("- "):
                # Keep the literal marker so independent readers retain ALL text.
                style = "ListParagraph"
        paragraphs.append(Paragraph(line, style))
    return EditableDocument(tuple(paragraphs), locale, tuple(warnings))
