"""Mechanical editable export records, independent of removed material types."""

from dataclasses import dataclass
from typing import Literal


class ExportFailure(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ExportSettings:
    paper: Literal["A4", "Letter"] = "A4"
    locale: str | None = None


@dataclass(frozen=True)
class Paragraph:
    text: str
    style: Literal["Normal", "Title", "Heading1", "ListParagraph"] = "Normal"


@dataclass(frozen=True)
class EditableDocument:
    paragraphs: tuple[Paragraph, ...]
    locale: str
    warnings: tuple[str, ...]
