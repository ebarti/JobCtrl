"""Retained measurements for real cover PDFs; invoke with the locked worker Python.

Requires Poppler on PATH. This inspects the supplied PDF, never renders a fake or
replayed PDF. Browser QA separately captures and inspects every viewer page.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

from pypdf import PdfReader


def measure(pdf: Path, source: Path, settings_path: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    settings = json.loads(settings_path.read_text())
    for name, input_path in (("displayed.pdf", pdf), ("source.txt", source), ("settings.json", settings_path)):
        target = output / name
        if input_path.resolve() != target.resolve():
            shutil.copyfile(input_path, target)

    def command(name, *args):
        executable = shutil.which(name)
        if not executable:
            raise RuntimeError(f"required PDF measurement tool missing: {name}")
        result = subprocess.run([executable, *map(str, args)], capture_output=True, check=False)
        (output / f"{name}.stdout").write_bytes(result.stdout)
        (output / f"{name}.stderr").write_bytes(result.stderr)
        if result.returncode:
            raise RuntimeError(f"{name} exited {result.returncode}")

    command("pdfinfo", pdf)
    command("pdffonts", pdf)
    command("pdftotext", "-bbox-layout", pdf, output / "layout.xhtml")
    command("pdftoppm", "-png", "-r", "96", pdf, output / "page")
    tree = ElementTree.parse(output / "layout.xhtml")
    ns = {"p": "http://www.w3.org/1999/xhtml"}
    reader = PdfReader(pdf, strict=True)
    expected_size = (595.28, 841.89) if settings["paper"] == "A4" else (612, 792)
    margin = settings["marginMm"] * 72 / 25.4
    expected_line = settings["fontSizePt"] * settings["lineHeight"]
    expected_paragraph = expected_line + settings["paragraphSpacingPx"] * 0.75
    violations = []

    def require(condition, detail):
        if not condition:
            violations.append(detail)

    pages = []
    all_text = []
    line_deltas = []
    layouts = tree.findall(".//p:page", ns)
    require(len(reader.pages) == len(layouts), "PDF and layout page counts differ")
    for index, (page, layout) in enumerate(zip(reader.pages, layouts), 1):
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        require(abs(width - expected_size[0]) < 0.8 and abs(height - expected_size[1]) < 0.8, f"page {index}: paper {width}x{height}")
        fragments = []

        def visitor(text, cm, tm, font, font_size):
            if text.strip():
                fragments.append({"text": text, "font": str((font or {}).get("/BaseFont")),
                                  "sizePt": font_size * math.hypot(cm[2], cm[3])})

        page.extract_text(visitor_text=visitor)
        require(bool(fragments), f"page {index} has no text")
        require(all(abs(fragment["sizePt"] - settings["fontSizePt"]) < 0.1 for fragment in fragments), f"page {index}: font size mismatch")
        words = layout.findall(".//p:word", ns)
        require(bool(words), f"page {index} has no measured words")
        all_text.extend(word.text or "" for word in words)
        boxes = [{key: float(word.attrib[key]) for key in ("xMin", "yMin", "xMax", "yMax")} for word in words]
        require(all(box["xMin"] >= margin - 1.5 and box["xMax"] <= width - margin + 1.5
                    and box["yMin"] >= margin - 1.5 and box["yMax"] <= height - margin + 1.5 for box in boxes), f"page {index}: margin bounds exceeded")
        if boxes:
            require(abs(min(box["xMin"] for box in boxes) - margin) < 1.5, f"page {index}: selected left margin differs")
        lines = layout.findall(".//p:line", ns)
        positions = sorted(set(round(float(line.attrib["yMin"]), 3) for line in lines))
        deltas = [round(b - a, 3) for a, b in zip(positions, positions[1:])]
        line_deltas.extend(deltas)
        pages.append({"page": index, "widthPt": width, "heightPt": height,
                      "wordBoxes": boxes, "lineDeltasPt": deltas, "fontFragments": fragments})
    # Literal whitespace normalization matches the renderer's paragraph/line
    # parsing. It does not judge prose meaning or use a similarity threshold.
    require("".join("".join(all_text).split()) == "".join(source.read_text().split()), "full PDF text differs from source")
    require(any(abs(delta - expected_line) < 1 for delta in line_deltas), "line spacing mismatch")
    require(any(abs(delta - expected_paragraph) < 1 for delta in line_deltas), "paragraph spacing mismatch")
    require(all(min(abs(delta - expected_line), abs(delta - expected_paragraph)) < 1 for delta in line_deltas), "unexpected line or paragraph gaps")
    images = sorted(output.glob("page-*.png"))
    require(len(images) == len(pages) > 0, "missing page images")
    root = Path(__file__).resolve().parents[3]
    provenance = {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest() for file in [
        Path(__file__).resolve(), root / "pnpm-lock.yaml", root / "workers/automation/uv.lock",
        root / "workers/automation/src/jobctrl/infrastructure/materials/playwright_html_pdf.py",
        root / "packages/contracts/src/cover-letter.ts",
    ]}
    report = {"observedAtUtc": datetime.now(timezone.utc).isoformat(), "settings": settings,
              "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "pdfSha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
              "expectedMarginPt": margin, "expectedLineDeltaPt": expected_line,
              "expectedParagraphDeltaPt": expected_paragraph, "pages": pages,
              "violations": violations, "sourceProvenanceSha256": provenance,
              "files": {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(output.iterdir()) if file.is_file()}}
    (output / "measurements.json").write_text(json.dumps(report, indent=2))
    if violations:
        raise AssertionError("; ".join(violations))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("pdf", "source", "settings", "output"):
        parser.add_argument(f"--{argument}", type=Path, required=True)
    args = parser.parse_args()
    measure(args.pdf, args.source, args.settings, args.output)
