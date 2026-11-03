"""Synthetic parser-to-database authority for resume import attempts."""

import hashlib
import json
import sqlite3

import pytest

from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema
from jobctrl.infrastructure.profile.pdf_parser import PyPdfProfileParser
from jobctrl.profile_import import extract_pdf_text
from tests.test_profile_import import _simple_pdf


class SyntheticModel:
    def chat_json(self, messages, *, response_schema, **_kwargs):
        sources = json.loads(messages[1].content)["sources"]
        source = next(item for item in sources if "synthetic-import@example.invalid" in item["text"])
        citation = {"source_id": source["source_id"], "quote": "synthetic-import@example.invalid"}
        if response_schema["title"] == "ResumeExtraction":
            personal = dict.fromkeys(["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"])
            personal["email"] = {"value": "synthetic-import@example.invalid", "citations": [citation]}
            return {"personal": personal, "executive_profile": None, "experience": [], "education": [], "skills": []}
        assert response_schema["title"] == "CandidateInterpretation"
        field = {"value": "unknown", "citations": [citation], "rationale": "Synthetic determination"}
        return {"track": field, "seniority": field, "functions": [], "target_roles": [],
                "target_preferences": [], "experience_places": []}


def test_parser_binds_pdf_style_and_determination_to_each_attempt_and_rolls_back(tmp_path):
    connection = sqlite3.connect(tmp_path / "synthetic.db")
    connection.row_factory = sqlite3.Row
    create_exact_v15_schema(connection)
    connection.execute(
        "INSERT INTO candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) VALUES (?,?,?,?)",
        ("local", "default", "Synthetic existing", "synthetic-time"),
    )
    connection.commit()
    deps = {"llm": SyntheticModel(), "repository": SqliteDeterminationRepository(connection),
            "tenant_id": "local", "provider": "synthetic", "model": "synthetic", "lane": "profile",
            "preflight": lambda: None}
    parser = PyPdfProfileParser(connection=connection, dependencies=deps)
    pdf_a = _simple_pdf(["synthetic-import@example.invalid", "Synthetic resume content with enough source text"])
    pdf_b = pdf_a.replace(b"/MediaBox [0 0 612 792]", b"/MediaBox [0 0 595 842]")
    assert pdf_a != pdf_b
    assert extract_pdf_text(pdf_a).text == extract_pdf_text(pdf_b).text
    first_id = "00000000-0000-4000-8000-000000000001"
    second_id = "00000000-0000-4000-8000-000000000002"

    def parse(pdf, attempt_id):
        return parser.parse(pdf, filename="synthetic.pdf", base_profile=None, base_style=None, attempt_id=attempt_id)

    first, second = parse(pdf_a, first_id), parse(pdf_b, second_id)
    assert first["source"]["determinationId"] == second["source"]["determinationId"]
    rows = connection.execute(
        "SELECT entity_id,entity_version,determination_id FROM semantic_entity_bindings "
        "WHERE tenant_id='local' AND entity_kind='resume_import_attempt' ORDER BY entity_id"
    ).fetchall()
    assert len(rows) == 2
    a, b = [json.loads(row["entity_version"]) for row in rows]
    assert a["pdfSha256"] == hashlib.sha256(pdf_a).hexdigest()
    assert b["pdfSha256"] == hashlib.sha256(pdf_b).hexdigest()
    assert a["inferredStyle"]["paper_size"] == "letterpaper"
    assert b["inferredStyle"]["paper_size"] == "a4paper"
    assert "pdfBytes" not in a and "pdfBytes" not in b
    assert parse(pdf_a, first_id)["source"]["attemptId"] == first_id
    with pytest.raises(ValueError, match="already bound"):
        parse(pdf_b, first_id)
    before = [tuple(row) for row in connection.execute("SELECT * FROM semantic_entity_bindings ORDER BY tenant_id,entity_kind,entity_id,entity_version")]
    connection.execute("CREATE TEMP TRIGGER fail_attempt BEFORE INSERT ON semantic_entity_bindings "
                       "BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END")
    with pytest.raises(sqlite3.IntegrityError, match="synthetic binding failure"):
        parse(pdf_a, "00000000-0000-4000-8000-000000000003")
    after = [tuple(row) for row in connection.execute("SELECT * FROM semantic_entity_bindings ORDER BY tenant_id,entity_kind,entity_id,entity_version")]
    assert after == before
    assert connection.execute("SELECT personal_full_name FROM candidate_profiles").fetchone()[0] == "Synthetic existing"
    connection.close()
