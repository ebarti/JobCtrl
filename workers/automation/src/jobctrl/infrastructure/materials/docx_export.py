"""Small dependency-free WordprocessingML adapter for accepted material text."""

from __future__ import annotations

import io
import json
import zipfile
from xml.etree import ElementTree as ET

from jobctrl.domain.materials.editable_export import EditableDocument, ExportFailure, ExportSettings

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
CP = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
VT = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"


def _w(parent, tag, **attributes):
    return ET.SubElement(parent, f"{{{W}}}{tag}", {f"{{{W}}}{key}": str(value) for key, value in attributes.items()})


def _xml(node):
    return ET.tostring(node, encoding="utf-8", xml_declaration=True)


def _relationships(items):
    # Some office importers reject prefixed OPC metadata, even though a generic
    # namespace-aware XML reader accepts it. Use conventional default namespaces
    # without changing ElementTree's process-global namespace registry.
    root = ET.Element("Relationships", xmlns=R)
    for index, (kind, target) in enumerate(items, 1):
        ET.SubElement(root, "Relationship", Id=f"rId{index}", Type=kind, Target=target)
    return _xml(root)


def render_docx(document: EditableDocument, settings: ExportSettings, binding: dict) -> bytes:
    root = ET.Element(f"{{{W}}}document")
    body = _w(root, "body")
    for item in document.paragraphs:
        paragraph = _w(body, "p")
        properties = _w(paragraph, "pPr")
        _w(properties, "pStyle", val=item.style)
        run = _w(paragraph, "r")
        # Tabs are XML elements in Word, not literal characters inside w:t.
        for index, text in enumerate(item.text.split("\t")):
            if index:
                _w(run, "tab")
            node = _w(run, "t")
            node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            node.text = text
    section = _w(body, "sectPr")
    width, height = (11906, 16838) if settings.paper == "A4" else (12240, 15840)
    _w(section, "pgSz", w=width, h=height)
    _w(section, "pgMar", top=1020, right=1020, bottom=1020, left=1020, header=0, footer=0, gutter=0)

    styles = ET.Element(f"{{{W}}}styles")
    defaults = _w(styles, "docDefaults")
    run_defaults = _w(_w(defaults, "rPrDefault"), "rPr")
    _w(run_defaults, "rFonts", ascii="Calibri", hAnsi="Calibri", cs="Calibri")
    _w(run_defaults, "sz", val=22)
    _w(run_defaults, "lang", val=document.locale)
    for ident, name in (("Normal", "Normal"), ("Title", "Title"), ("Heading1", "heading 1"),
                        ("ListParagraph", "List Paragraph")):
        style = _w(styles, "style", type="paragraph", styleId=ident)
        if ident == "Normal":
            style.set(f"{{{W}}}default", "1")
        _w(style, "name", val=name)
        if ident != "Normal":
            _w(style, "basedOn", val="Normal")
        _w(style, "next", val="Normal")
        paragraph_properties = _w(style, "pPr")
        if ident in {"Title", "Heading1"}:
            _w(paragraph_properties, "keepNext")
            _w(paragraph_properties, "keepLines")
        _w(paragraph_properties, "spacing", after=20, line=240, lineRule="auto")
        if ident == "Heading1":
            _w(paragraph_properties, "outlineLvl", val=0)
        if ident == "ListParagraph":
            _w(paragraph_properties, "ind", left=240, hanging=240)
        if ident in {"Title", "Heading1"}:
            run_properties = _w(style, "rPr")
            _w(run_properties, "b")
            _w(run_properties, "sz", val=32 if ident == "Title" else 24)

    core_ns = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    dc = "http://purl.org/dc/elements/1.1/"
    core = ET.Element(f"{{{core_ns}}}coreProperties")
    ET.SubElement(core, f"{{{dc}}}language").text = document.locale
    ET.SubElement(core, f"{{{dc}}}identifier").text = binding["sourceArtifactId"]
    custom = ET.Element(f"{{{CP}}}Properties")
    prop = ET.SubElement(custom, f"{{{CP}}}property", fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}",
                         pid="2", name="JobCtrlExport")
    ET.SubElement(prop, f"{{{VT}}}lpwstr").text = json.dumps(binding, ensure_ascii=False, sort_keys=True)

    types_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    content_types = ET.Element("Types", xmlns=types_ns)
    ET.SubElement(content_types, "Default", Extension="rels",
                  ContentType="application/vnd.openxmlformats-package.relationships+xml")
    for path, content_type in (
        ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
        ("word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"),
        ("docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
        ("docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"),
    ):
        ET.SubElement(content_types, "Override", PartName="/" + path, ContentType=content_type)
    parts = {
        "[Content_Types].xml": _xml(content_types),
        "_rels/.rels": _relationships([
            (OFFICE + "officeDocument", "word/document.xml"),
            (R + "/metadata/core-properties", "docProps/core.xml"),
            (OFFICE + "custom-properties", "docProps/custom.xml"),
        ]),
        "word/document.xml": _xml(root),
        "word/styles.xml": _xml(styles),
        "word/_rels/document.xml.rels": _relationships([(OFFICE + "styles", "styles.xml")]),
        "docProps/core.xml": _xml(core),
        "docProps/custom.xml": _xml(custom),
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, data in parts.items():
            # Stable archive metadata binds identical accepted sources/settings to
            # identical bytes; export time belongs to the registry receipt.
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    result = buffer.getvalue()
    validate_docx(result, document, binding)
    return result


def validate_docx(data: bytes, document: EditableDocument, binding: dict) -> None:
    """Fail closed on corrupt packaging or changed text before publication.

    Independent python-docx reading/edit/save tests cover interoperability; this
    runtime check deliberately has no extra renderer or reader dependency.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
            actual = []
            for paragraph in root.findall(f"{{{W}}}body/{{{W}}}p"):
                actual.append("".join("\t" if node.tag == f"{{{W}}}tab" else node.text or ""
                                      for node in paragraph.iter() if node.tag in {f"{{{W}}}t", f"{{{W}}}tab"}))
            metadata = ET.fromstring(archive.read("docProps/custom.xml")).find(f"{{{CP}}}property/{{{VT}}}lpwstr")
            if actual != [item.text for item in document.paragraphs] or metadata is None or json.loads(metadata.text) != binding:
                raise ValueError()
    except (ValueError, KeyError, ET.ParseError, zipfile.BadZipFile):
        raise ExportFailure("export_validation_failed") from None
