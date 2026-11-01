"""Catalog authority, editorial boundaries, deterministic compilation and admission."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

import pytest

from jobctrl.domain.interview import catalog as catalog_module
from jobctrl.domain.interview.catalog import (
    InterviewSelectionError,
    canonical_json_digest,
    catalog_raw_digest,
    get_interview_question,
    load_interview_catalog,
    load_interview_catalog_bytes,
    parse_interview_catalog,
    validate_interview_selection,
)

REPO = Path(__file__).resolve().parents[3]
RESEARCH = REPO / "docs/research/interview-preparation"
ASSET = REPO / "workers/automation/src/jobctrl/assets/interview/catalog.v1.json"


def compiler():
    spec = importlib.util.spec_from_file_location("interview_catalog_compiler", RESEARCH / "compile_catalog.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_complete_inventory_attribution_and_named_editorial_invariants():
    catalog = load_interview_catalog()
    assert (len(catalog["questions"]), len(catalog["topics"]), len(catalog["sources"]), len(catalog["authors"])) == (121, 15, 57, 20)
    assert sum(len(card["rubric"]) for card in catalog["questions"]) == 363
    assert sum(bool(card["examples"]) for card in catalog["questions"]) == 17
    assert len(catalog["relationships"]) == 31
    assert catalog["retiredQuestions"][0]["id"] == "C08"
    for key in ("B11", "TS09"):
        card = get_interview_question(key, catalog=catalog)
        assert card["answerFormats"] == ["principle"]
        assert card["examples"] and card["alternatives"] and card["probes"]
    salary = get_interview_question("C07", catalog=catalog)
    assert salary["defaultAnswerFormat"] == "negotiation"
    assert "budgeted range" in salary["answer"] and "Persist in seeking the range" in salary["answer"]
    assert all(card["maturity"] == "research_draft" and card["provenance"] for card in catalog["questions"])
    assert all(source["readingCoverage"] and source["note"] for source in catalog["sources"])
    assert "full book not read" in catalog["guidance"]["sourceLedger"]
    assert "This track is thin" in catalog["guidance"]["review"]
    assert "incomplete" in catalog["guidance"]["review"]
    assert "Do not total" in catalog["guidance"]["evaluation"]


def test_compiler_matches_exact_resource_bytes_and_published_digests():
    compiled = compiler()
    first = compiled.catalog_bytes(compiled.build())
    second = compiled.catalog_bytes(compiled.build())
    assert first == second == ASSET.read_bytes() == load_interview_catalog_bytes()
    assert hashlib.sha256(first).hexdigest() == catalog_raw_digest()
    data = json.loads(first)
    assert canonical_json_digest({key: value for key, value in data.items() if key != "catalogDigest"}) == data["catalogDigest"]


@pytest.mark.parametrize(("ids", "code"), [
    (["C08"], "retired_question"), (["UNKNOWN99"], "unknown_question"),
    (["C01", "C01"], "duplicate_question"), ([], "invalid_selection"),
    (["C01"] * 17, "selection_over_budget"), ([True], "invalid_selection"),
])
def test_selection_rejects_invalid_ids_before_generation(ids, code):
    with pytest.raises(InterviewSelectionError) as caught:
        validate_interview_selection(ids)
    assert caught.value.code == code


def test_selection_preserves_order_and_rejects_stale_catalog_binding():
    catalog = load_interview_catalog()
    binding = {"catalogRevision": catalog["catalogRevision"], "catalogDigest": catalog["catalogDigest"]}
    assert [card["id"] for card in validate_interview_selection(["TS09", "C07", "B11"], catalog_binding=binding)] == ["TS09", "C07", "B11"]
    with pytest.raises(InterviewSelectionError, match="catalog_mismatch"):
        validate_interview_selection(["C01"], catalog_binding={**binding, "catalogRevision": "old"})
    catalog["questions"][0]["answer"] = "A local edit"
    assert load_interview_catalog()["questions"][0]["answer"] != "A local edit"


def test_package_resource_absence_fails_closed_without_docs_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog_module, "files", lambda package: tmp_path)
    with pytest.raises(FileNotFoundError):
        load_interview_catalog()


@pytest.mark.parametrize("change", ["tamper", "role", "retired", "source", "duplicate_key", "missing_card"])
def test_loader_rejects_corrupt_or_incomplete_catalog(change):
    catalog = load_interview_catalog()
    if change == "duplicate_key":
        raw = load_interview_catalog_bytes().replace(b'{"authors":', b'{"schemaVersion":"1","authors":', 1)
        with pytest.raises(ValueError, match="duplicate"):
            parse_interview_catalog(raw)
        return
    if change == "tamper":
        catalog["questions"][0]["answer"] = "tampered"
    elif change == "role":
        catalog["questions"][0]["roleLenses"] = []
    elif change == "retired":
        catalog["questions"][0]["id"] = "C08"
    elif change == "source":
        catalog["questions"][0]["sources"] = ["missing"]
    else:
        catalog["questions"].pop()
    if change != "tamper":
        catalog["catalogDigest"] = canonical_json_digest({key: value for key, value in catalog.items() if key != "catalogDigest"})
    with pytest.raises(ValueError):
        parse_interview_catalog(json.dumps(catalog).encode())


def test_compiler_rejects_mutated_source_and_unversioned_editorial_metadata(tmp_path):
    authored = tmp_path / "research"
    shutil.copytree(RESEARCH, authored)
    compiled = compiler()
    original = (authored / "common.md").read_bytes()
    (authored / "common.md").write_bytes(original + b"\nunauthorized source edit\n")
    with pytest.raises(ValueError, match="source bytes changed"):
        compiled.build(authored)
    (authored / "common.md").write_bytes(original)
    metadata = json.loads((authored / "catalog-metadata.v1.json").read_text())
    changed = copy.deepcopy(metadata)
    changed["questionMetadata"]["B11"]["defaultAnswerFormat"] = "historical"
    (authored / "catalog-metadata.v1.json").write_text(json.dumps(changed))
    with pytest.raises(ValueError, match="default format"):
        compiled.build(authored)
    changed = copy.deepcopy(metadata)
    changed["questionMetadata"]["C01"]["responsibilityTags"] = ["different_valid_tag"]
    (authored / "catalog-metadata.v1.json").write_text(json.dumps(changed))
    with pytest.raises(ValueError, match="immutable v1 catalog digest"):
        compiled.build(authored)


@pytest.mark.parametrize("seal", ["missing", None, "", "z" * 64, "a" * 63, "a" * 65, "0" * 64])
def test_compiler_requires_a_well_formed_matching_published_seal(tmp_path, seal):
    authored = tmp_path / "research"
    shutil.copytree(RESEARCH, authored)
    metadata = json.loads((authored / "catalog-metadata.v1.json").read_text())
    metadata["questionMetadata"]["C01"]["responsibilityTags"] = ["different_valid_tag"]
    if seal == "missing":
        del metadata["catalogDigest"]
    else:
        metadata["catalogDigest"] = seal
    (authored / "catalog-metadata.v1.json").write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="catalog digest"):
        compiler().build(authored)


def test_question_id_budget_rejects_before_lookup_and_bounds_authored_metadata(tmp_path, monkeypatch):
    oversized = "A" * 200_000 + "01"
    with pytest.raises(InterviewSelectionError, match="invalid_selection"):
        get_interview_question(oversized)
    with pytest.raises(InterviewSelectionError, match="unknown_question"):
        get_interview_question("A" * 10 + "01")
    monkeypatch.setattr(catalog_module, "get_interview_question", lambda *args, **kwargs: pytest.fail("oversized ID reached lookup"))
    with pytest.raises(InterviewSelectionError, match="invalid_selection"):
        validate_interview_selection([oversized])
    authored = tmp_path / "research"
    shutil.copytree(RESEARCH, authored)
    metadata = json.loads((authored / "catalog-metadata.v1.json").read_text())
    metadata["questionMetadata"][oversized] = metadata["questionMetadata"].pop("C01")
    (authored / "catalog-metadata.v1.json").write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="question ID"):
        compiler().build(authored)


def test_loader_bounds_question_ids_even_with_recomputed_digests():
    catalog = load_interview_catalog()
    card = catalog["questions"][0]
    card["id"] = "A" * 200_000 + "01"
    card["cardDigest"] = canonical_json_digest({key: value for key, value in card.items() if key != "cardDigest"})
    catalog["catalogDigest"] = canonical_json_digest({key: value for key, value in catalog.items() if key != "catalogDigest"})
    with pytest.raises(ValueError, match="question ID"):
        parse_interview_catalog(json.dumps(catalog).encode())
