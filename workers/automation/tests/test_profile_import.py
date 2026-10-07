from jobctrl.profile_import import PdfTextResult, extract_pdf_text, style_from_pdf_metadata


def _simple_pdf(lines: list[str]) -> bytes:
    text_ops = []
    for line in lines:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        text_ops.append(f"({escaped}) Tj T*")
    content = "BT /F1 11 Tf 72 720 Td 14 TL\n" + "\n".join(text_ops) + "\nET\n"
    objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        (
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n"
        ),
        "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
        f"5 0 obj << /Length {len(content.encode('latin-1'))} >> stream\n{content}endstream endobj\n",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(output))
        output.extend(obj.encode("latin-1"))
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("latin-1"))
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("latin-1"))
    output.extend(f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("latin-1"))
    return bytes(output)


def test_extract_pdf_text_reads_resume_pdf_text_and_metadata():
    result = extract_pdf_text(
        _simple_pdf(["Alex Rivera", "alex@example.com", "Executive Profile", "Platform engineer."])
    )

    assert result.page_count == 1
    assert "Alex Rivera" in result.text
    assert "alex@example.com" in result.text
    assert result.page_sizes == [(612.0, 792.0)]
    assert "/Helvetica" in result.font_names


def test_style_from_pdf_metadata_infers_editable_style_controls():
    result = PdfTextResult(
        text="Resume text",
        page_count=1,
        page_sizes=[(612.0, 792.0)],
        font_names=["/TimesNewRomanPSMT"],
        font_sizes=[10.0, 10.5, 11.0],
    )

    style = style_from_pdf_metadata(result, base_style={"moderncv_color": "blue"})

    assert style["paper_size"] == "letterpaper"
    assert style["document_font_size"] == "11pt"
    assert style["font_family"] == "roman"
    assert style["body_alignment"] == "left"
    assert style["moderncv_color"] == "blue"
