#!/usr/bin/env python3
"""Compile authored Markdown + explicit metadata into one public runtime asset.

Only the standard library is used. No plugin, provider, profile, or prototype is
needed. --check is the CI/admission mode: validate inputs and compare exact bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASSET = ROOT.parents[2] / "workers/automation/src/jobctrl/assets/interview/catalog.v1.json"
FIELDS = {"Variants": "variants", "Intent": "intent", "Strong answer target": "answer",
          "Profile inputs/adaptation": "adaptation", "Acceptable alternatives": "alternatives",
          "Probes": "probes", "Failure modes": "failures", "Provenance": "provenance"}
ROLES = {"ic", "senior_ic", "staff_principal", "first_time_manager", "engineering_manager", "director", "executive"}
FORMATS = {"historical", "situational", "principle", "negotiation", "narrative", "preference"}
ATTRIBUTIONS = {"direct_interview_guidance", "practice_extrapolation", "editorial_synthesis"}
COVERAGE = {"article", "selected_passage", "overview", "official_guidance", "research_update"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def unique(rows: list[dict], label: str) -> set[str]:
    ids = [row["id"] for row in rows]
    require(len(ids) == len(set(ids)), f"duplicate {label} IDs")
    return set(ids)


def build(root: Path = ROOT) -> dict:
    metadata = json.loads((root / "catalog-metadata.v1.json").read_text())
    require(metadata["schemaVersion"] == "1", "unsupported authored metadata schema")
    require(metadata["catalogRevision"] == "2026-10-01.1", "v1 revision is immutable; create a retained new asset")
    documents = {path.name: path.read_text() for path in sorted(root.glob("*.md")) if path.name != "catalog-contract.md"}
    source_files = [{"path": f"docs/research/interview-preparation/{name}", "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest()}
                    for name in documents]
    require(source_files == metadata["sourceFiles"], "research source bytes changed without a retained revision")
    questions = []
    topics = []
    for topic in metadata["topics"]:
        source = documents[topic["id"] + ".md"]
        chunks = re.split(r"(?m)^## ([A-Z]+\d{2}) — ([^\n]+)\n", source)
        question_ids = []
        for offset in range(1, len(chunks), 3):
            question_id, title, body = chunks[offset:offset + 3]
            require(question_id in metadata["questionMetadata"], f"missing explicit metadata: {question_id}")
            authored = metadata["questionMetadata"][question_id]
            require(set(authored) == {"cardRevision", "rubricRevision", "roleLenses", "responsibilityTags", "competencyTags",
                    "answerFormats", "defaultAnswerFormat", "attributionKind"}, f"unexpected metadata fields: {question_id}")
            require(all(re.fullmatch(r"[1-9]\d*", authored[key]) for key in ("cardRevision", "rubricRevision")), f"invalid revision: {question_id}")
            for key, vocabulary in (("roleLenses", ROLES), ("answerFormats", FORMATS)):
                values = authored[key]
                require(isinstance(values, list) and bool(values) and len(values) == len(set(values)) and set(values) <= vocabulary,
                        f"invalid {key}: {question_id}")
            for key in ("responsibilityTags", "competencyTags"):
                tags = authored[key]
                require(bool(tags) and len(tags) == len(set(tags)) and all(re.fullmatch(r"[a-z][a-z0-9_]*", tag) for tag in tags),
                        f"invalid {key}: {question_id}")
            require(authored["defaultAnswerFormat"] in authored["answerFormats"], f"default format absent: {question_id}")
            require(authored["attributionKind"] in ATTRIBUTIONS, f"invalid attribution: {question_id}")
            # This anchor matches the existing VitePress/GitHub heading; no research rewrite is needed.
            heading = f"{question_id} — {title}"
            anchor = re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
            card = {"id": question_id, "title": title, "topic": topic["id"], "status": "active", "maturity": "research_draft",
                    **authored, "sourceRef": f"docs/research/interview-preparation/{topic['id']}.md#{anchor}"}
            marks = list(re.finditer(r"\*\*([^*]+):\*\*", body))
            for index, mark in enumerate(marks):
                if mark[1] not in FIELDS:
                    continue
                end = marks[index + 1].start() if index + 1 < len(marks) else len(body)
                require(FIELDS[mark[1]] not in card, f"duplicate card field: {question_id} {mark[1]}")
                card[FIELDS[mark[1]]] = compact(body[mark.end():end].split("\n|", 1)[0])
            require(all(card.get(field) for field in FIELDS.values()), f"missing card field: {question_id}")
            rows = [line for line in body.splitlines() if line.startswith("|")]
            rubric = []
            for row in rows[2:]:
                cells = [cell.strip() for cell in row.split("|")[1:-1]]
                require(len(cells) == 3 and all(cells), f"malformed rubric: {question_id}")
                rubric.append(dict(zip(("dimension", "weak", "strong"), cells)))
            require(len(rubric) == 3, f"current source rubric must preserve 3 dimensions: {question_id}")
            card["rubric"] = rubric
            card["rubricDigest"] = digest(rubric)
            card["sources"] = list(dict.fromkeys(re.findall(r"\[([A-Z]+\d{2})\]\(sources.md#[^)]+\)", card["provenance"])))
            require(bool(card["sources"]), f"unattributed card: {question_id}")
            questions.append(card)
            question_ids.append(question_id)
        topics.append({**topic, "questionIds": question_ids})
    question_ids = unique(questions, "question")
    require(question_ids == set(metadata["questionMetadata"]), "unused/missing authored card metadata")
    retired = metadata["retiredQuestions"]
    retired_ids = unique(retired, "retired question")
    require(retired_ids == {"C08"} and not retired_ids & question_ids, "C08 must stay retired and unrecycled")
    require(all(row["replacementId"] is None and row["reason"] for row in retired), "retired record must explain reservation")

    ledger = documents["sources.md"]
    source_records = list(re.finditer(r"(?m)^- \*\*([A-Z]+\d{2}) — ", ledger))
    authors = metadata["authors"]
    source_owners = {source_id: author["id"] for author in authors for source_id in author["sourceIds"]}
    require(len(source_owners) == sum(len(author["sourceIds"]) for author in authors), "duplicate author/source ownership")
    sources = []
    for index, record in enumerate(source_records):
        source_id = record[1]
        end = source_records[index + 1].start() if index + 1 < len(source_records) else ledger.index("\n## Books")
        body = ledger[record.end():end].split("\n###", 1)[0].strip()
        link = re.search(r"\[([^\]]+)\]\((https?://[^)]+)\)", body)
        require(link is not None and source_id in source_owners, f"invalid source/author: {source_id}")
        title, url = link.groups()
        remainder = compact(body[body.index("**", link.end()) + 2:])
        reading = re.match(r"^\((.*?)\)\.", remainder)
        require(reading is not None, f"missing explicit reading coverage: {source_id}")
        require(metadata["sourceCoverageKinds"][source_id] in COVERAGE, f"invalid source coverage: {source_id}")
        sources.append({"id": source_id, "title": title, "url": url, "authorId": source_owners[source_id],
                        "readingCoverage": reading[1], "readingCoverageKind": metadata["sourceCoverageKinds"][source_id],
                        "note": remainder[reading.end():].strip(),
                        "questionIds": [card["id"] for card in questions if source_id in card["sources"]]})
    source_ids = unique(sources, "source")
    require(source_ids == set(source_owners) == set(metadata["sourceCoverageKinds"]), "source coverage/author inventory mismatch")
    require(all(set(card["sources"]) <= source_ids for card in questions), "dangling source citation")
    unique(authors, "author")
    unique(topics, "topic")

    examples = {}
    headers = list(re.finditer(r"(?m)^## ([A-Z]+\d{2}): ([^\n]+)\n", documents["examples.md"]))
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(documents["examples.md"])
        examples.setdefault(header[1], []).append({"title": header[2], "body": documents["examples.md"][header.end():end].strip()})
    require(set(examples) <= question_ids, "dangling worked example")
    relationships = []
    coverage = documents["coverage.md"].split("## Boundaries that prevent duplicate questions")[1].split("## Choose by")[0]
    for line in coverage.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.split("|")[1:-1]]
        if len(cells) != 2:
            continue
        for left, right in combinations(re.findall(r"\b[A-Z]+\d{2}\b", cells[0]), 2):
            require(left in question_ids and right in question_ids and left != right, "dangling editorial relationship")
            relationships.append({"fromQuestionId": left, "toQuestionId": right, "kind": "editorial_related", "reason": cells[1]})
    for card in questions:
        card["examples"] = examples.get(card["id"], [])
        card["cardDigest"] = digest(card)
    by_id = {card["id"]: card for card in questions}
    require(by_id["B11"]["defaultAnswerFormat"] == by_id["TS09"]["defaultAnswerFormat"] == "principle", "decision criteria must stay principle answers")
    require("budgeted range" in by_id["C07"]["answer"].lower() and "persist" in by_id["C07"]["answer"].lower(), "C07 must persistently seek the employer range first")
    counts = (len(questions), len(topics), len(sources), len(authors), sum(len(card["rubric"]) for card in questions), len(examples), len(relationships))
    require(counts == (121, 15, 57, 20, 363, 17, 31), f"source inventory changed: {counts}")
    catalog = {"schemaVersion": "1", "catalogRevision": metadata["catalogRevision"], "maturity": "research_draft",
               "reviewedAt": metadata["reviewedAt"], "sourcePacketDigest": metadata["sourcePacketDigest"],
               "sourceFiles": source_files, "topics": topics, "questions": questions, "retiredQuestions": retired,
               "sources": sources, "authors": authors, "relationships": relationships,
               "guidance": {key: documents[name] for key, name in (("overview", "README.md"), ("sourceLedger", "sources.md"),
                            ("evaluation", "evaluation.md"), ("coverage", "coverage.md"), ("review", "review.md"))}}
    catalog["catalogDigest"] = digest(catalog)
    locked = metadata.get("catalogDigest")
    require(locked is None or locked == catalog["catalogDigest"], "immutable v1 catalog digest changed; retain a new revision")
    return catalog


def catalog_bytes(catalog: dict) -> bytes:
    return (json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate and compare committed asset without writing")
    args = parser.parse_args()
    catalog = build()
    raw = catalog_bytes(catalog)
    if args.check:
        require(ASSET.is_file() and ASSET.read_bytes() == raw, "compiled catalog is absent or stale")
    else:
        ASSET.parent.mkdir(parents=True, exist_ok=True)
        ASSET.write_bytes(raw)
    print(json.dumps({"questions": len(catalog["questions"]), "catalogRevision": catalog["catalogRevision"],
                      "catalogDigest": catalog["catalogDigest"], "rawDigest": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}))


if __name__ == "__main__":
    main()
