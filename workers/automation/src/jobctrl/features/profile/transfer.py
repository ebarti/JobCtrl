"""One-off, read-only legacy export and lossless Profile-only fresh-state import.

The runtime owns explicit cutover authorization and creation of a fresh target.
These functions never reset a database or open a real user's workspace by
default. Legacy parsing is confined to this transfer adapter.
"""

from __future__ import annotations

import base64
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import struct

from jobctrl.app.errors import AppError, ConflictError
from .models import canonical, fingerprint, profile_identity, validate_transfer_bundle
from .repository import DEFAULT_STYLE, DEFAULT_TEMPLATE, now
from .service import ProfileService, normalize_style, validate_profile


FORMAT = "jobctrl.profile-transfer.v1"
BROWSER_FORMAT = "jobctrl.profile-browser-sources.v1"
TARGET_TABLES = (
    "profile_documents", "profile_versions", "profile_sources", "profile_source_versions",
    "profile_achievements", "profile_variants", "profile_decisions", "profile_authoring_requests",
    "profile_determinations", "profile_import_drafts", "profile_transfer_provenance",
)
LEGACY_TABLES = (
    "candidate_profiles", "candidate_profile_experience_bullets", "candidate_profile_achievement_evidence",
    "candidate_profile_experience_entries", "candidate_profile_education_entries", "candidate_profile_skill_items",
    "candidate_profile_skill_categories", "candidate_profile_required_experience_entries",
    "candidate_profile_required_education_entries", "candidate_profile_required_skill_categories",
    "candidate_profile_required_bullets", "candidate_profile_required_skills", "candidate_profile_resume_constraint_metrics",
    "candidate_interpretation_suggestions",
)
PROFILE_DETERMINATIONS = {"resume_extraction", "required_bullet_coaching", "candidate_interpretation"}


def _json_cell(value):
    return {"$bytes_base64": base64.b64encode(value).decode()} if isinstance(value, bytes) else value


def _rows(conn, table, *, where="", params=()):
    return [{key: _json_cell(row[key]) for key in row.keys()} for row in conn.execute(f'SELECT * FROM "{table}" {where} ORDER BY rowid', params)]


def _bundle(data):
    return {"format": FORMAT, "data": data, "sha256": fingerprint(data)}


def validate_bundle(bundle):
    try:
        return validate_transfer_bundle(bundle)
    except ValueError:
        raise AppError("invalid_profile_transfer", "The Profile transfer format or digest is invalid.")


def _valid_historic_confirmation(data, original, receipt, expected_status):
    """Rejoin historical IDs and exact reviewed cells at the import boundary."""
    if not isinstance(original, dict) or not isinstance(receipt, dict) or receipt.get("author") != "human_review":
        return False
    result = receipt.get("result", {})
    if result.get("status") != expected_status or type(result.get("previous_event_id")) is not int:
        return False
    events = {item.get("event_id"): item for item in data.get("legacy_profile_events", [])}
    current, previous = events.get(receipt.get("event_id")), events.get(result["previous_event_id"])
    if not current or not previous or previous["event_id"] >= current["event_id"]:
        return False
    try:
        recorded = json.loads(current["payload_json"])
        previous_payload = json.loads(previous["payload_json"])
        expected_payload = {key: value for key, value in receipt.items() if key != "event_id"}
        if recorded != expected_payload or previous_payload.get("result", {}).get("original") != result.get("original"):
            return False
        for key in ("tenant_id", "profile_id", "entry_id", "evidence_id"):
            if result.get("original", {}).get(key) != original.get(key) or receipt.get(key) != original.get(key):
                return False
        confidence = original.get("claim_confidence")
        if type(confidence) not in (float, int) or not 0 <= confidence <= 1:
            return False
        content = {key: "binary64:" + struct.pack(">d", float(value)).hex() if key == "claim_confidence" else value
                   for key, value in original.items() if key != "evidence_index"}
        return result.get("resulting_row_fingerprint") == fingerprint(content)
    except (ValueError, TypeError, KeyError, struct.error):
        return False


def _decode_legacy_profile(root, tables):
    """Decode only the old Profile schema; no retired runtime imports."""
    def rows(table, order):
        return sorted(tables.get(table, []), key=lambda item: (item.get(order, 0), canonical(item)))
    def ordered(table, value, order, **matches):
        return [item[value] for item in rows(table, order) if all(item.get(key) == expected for key, expected in matches.items())]
    def grouped(table, group, value, order):
        result = {}
        for item in rows(table, order):
            result.setdefault(item[group], []).append(item[value])
        return result
    def json_value(value, empty):
        try:
            result = json.loads(value)
        except (ValueError, TypeError):
            raise AppError("invalid_legacy_profile", "A legacy Profile JSON cell is damaged; the source was not changed.") from None
        if not isinstance(result, type(empty)):
            raise AppError("invalid_legacy_profile", "A legacy Profile JSON cell has an invalid structure.")
        return result
    document = {}
    direct = {
        "personal": ("personal_", ("full_name", "preferred_name", "email", "phone", "address", "city", "province_state", "country", "postal_code", "linkedin_url", "github_url", "portfolio_url", "website_url", "password")),
        "work_authorization": ("work_", ("legally_authorized_to_work", "require_sponsorship", "work_permit_type")),
        "experience": ("experience_", ("education_level", "current_job_title", "current_company", "target_role", "target_track", "target_seniority_floor", "target_functions", "target_specializations", "target_locations", "target_work_models")),
        "eeo_voluntary": ("eeo_", ("gender", "race_ethnicity", "veteran_status", "disability_status")),
    }
    for section, (prefix, keys) in direct.items():
        document[section] = {key: root.get(prefix + key, "") for key in keys}
    document["experience"]["years_of_experience_total"] = root.get("experience_years_total", "")
    document["compensation"] = {key: root.get("compensation_" + column, "") for key, column in (
        ("salary_expectation", "salary_expectation"), ("salary_currency", "salary_currency"),
        ("salary_range_min", "salary_range_min"), ("salary_range_max", "salary_range_max"), ("currency_conversion_note", "currency_note"))}
    document["availability"] = {key: root.get("availability_" + column, "") for key, column in (
        ("earliest_start_date", "earliest_start_date"), ("available_for_full_time", "full_time"), ("available_for_contract", "contract"))}
    document["application_attestations"] = {key: bool(root["application_attestation_" + key])
        if root.get("application_attestation_" + key) is not None else None for key in
        ("age_18_plus", "background_check_consent", "felony_conviction", "previously_worked_at_employer")}
    document["application_attestations"]["additional"] = json_value(root.get("application_attestation_additional_json", "{}"), {})
    document["application_preferences"] = {"how_heard": root.get("application_preference_how_heard", "")}
    roles = []
    for row in rows("candidate_profile_experience_entries", "position_index"):
        role = {"id": row["entry_id"], **{key: row.get(key, "") for key in ("date_range", "title", "company", "location", "summary")}}
        role["bullets"] = ordered("candidate_profile_experience_bullets", "bullet_text", "bullet_index", entry_id=row["entry_id"])
        role["achievement_evidence"] = []
        for evidence in rows("candidate_profile_achievement_evidence", "evidence_index"):
            if evidence["entry_id"] != row["entry_id"]:
                continue
            role["achievement_evidence"].append({"id": evidence["evidence_id"],
                **{key: evidence.get(key, "") for key in ("source_text", "scope", "action", "outcome", "evidence_strength")},
                **{key: json_value(evidence.get(key + "_json", "[]"), []) for key in ("tools", "metrics", "tags")},
                "claim_confidence": evidence.get("claim_confidence"), "user_confirmed": evidence.get("user_confirmed") == 1})
        roles.append(role)
    education = [{"id": row["entry_id"], **{key: row.get(key, "") for key in ("date", "degree", "institution", "location")}}
                 for row in rows("candidate_profile_education_entries", "position_index")]
    skills = [{"id": row["category_id"], "label": row["label"],
               "items": ordered("candidate_profile_skill_items", "item_text", "item_index", category_id=row["category_id"])}
              for row in rows("candidate_profile_skill_categories", "position_index")]
    rules = {
        "required_experience_entry_ids": ordered("candidate_profile_required_experience_entries", "entry_id", "position_index"),
        "required_education_entry_ids": ordered("candidate_profile_required_education_entries", "entry_id", "position_index"),
        "required_skill_category_ids": ordered("candidate_profile_required_skill_categories", "category_id", "position_index"),
        "required_bullets_by_experience_id": grouped("candidate_profile_required_bullets", "entry_id", "bullet_text", "bullet_index"),
        "required_skills_by_category_id": grouped("candidate_profile_required_skills", "category_id", "skill_text", "skill_index"),
        "max_experience_bullets": root.get("max_experience_bullets"), "custom_tailoring_prompt": root.get("custom_tailoring_prompt", ""),
        "writing_style": {key: root.get("writing_" + key) for key in ("tone", "bullet_style", "verbosity", "keyword_density")},
        "tailoring_policy": {key: root.get("tailoring_" + key) for key in ("mode", "claim_mode")},
        "revision_gates": {key: root.get("revision_" + column) for key, column in (
            ("min_fit_score", "min_fit_score"), ("must_have_coverage", "must_have_coverage"), ("max_revision_attempts", "max_attempts"))},
    }
    rules["writing_style"]["avoid_first_person"] = root.get("writing_avoid_first_person") == 1
    rules["tailoring_policy"].update({key: root.get("tailoring_" + key) == 1 for key in (
        "allow_title_reframing", "allow_achievement_rewriting", "allow_skill_reordering", "allow_summary_rewrite",
        "allow_minor_inference", "allow_adjacent_achievement_drafts")})
    rules["tailoring_policy"]["auto_approvable_claim_modes"] = json_value(root.get("tailoring_auto_approvable_claim_modes_json", "[]"), [])
    document["resume"] = {"executive_profile": {"baseline_text": root.get("resume_baseline_text", "")},
                          "experience_entries": roles, "education_entries": education, "skill_categories": skills, "tailoring_rules": rules}
    document["resume_constraints"] = {"real_metrics": ordered("candidate_profile_resume_constraint_metrics", "metric_text", "metric_index")}
    return document


def export_profile(service, profile_id="default") -> dict:
    with service.repository.reader() as conn:
        snapshot = service.snapshot(profile_id, conn)
        tables = {table: _rows(conn, table, where="WHERE profile_id=?", params=(profile_id,)) for table in TARGET_TABLES}
        return _bundle({"kind": "target", "profile_id": profile_id, "snapshot": snapshot.to_dict(), "tables": tables})


def browser_manifest(value: dict | None) -> dict:
    if value is None:
        return {"format": BROWSER_FORMAT, "complete": False, "sources": [], "known_attachment_ids": [],
                "unavailable_refs": [], "reason": "browser_source_export_required"}
    if (not isinstance(value, dict) or value.get("format") != BROWSER_FORMAT or type(value.get("complete")) is not bool
            or not isinstance(value.get("sources"), list) or not isinstance(value.get("known_attachment_ids"), list)
            or not isinstance(value.get("unavailable_refs", []), list)):
        raise AppError("invalid_browser_profile_export", "The browser Profile source manifest is invalid.")
    result = deepcopy(value)
    source_ids = set()
    for source in result["sources"]:
        if not isinstance(source, dict) or not isinstance(source.get("source_id"), str) or source["source_id"] in source_ids:
            raise AppError("invalid_browser_profile_export", "Browser sources require distinct original record IDs.")
        source_ids.add(source["source_id"])
        if not isinstance(source.get("text", ""), str):
            raise AppError("invalid_browser_profile_export", "Browser source text is invalid.")
        source.setdefault("text", "")
        ProfileService._validate_attachment(source.get("attachment"), maximum_bytes=None)
    known = result["known_attachment_ids"]
    if any(not isinstance(item, str) for item in known) or len(set(known)) != len(known):
        raise AppError("invalid_browser_profile_export", "Browser attachment inventory IDs are invalid.")
    available = {source["source_id"] for source in result["sources"] if source.get("attachment")}
    missing = set(known) - available
    if missing:
        result.update(complete=False, reason="known_browser_attachment_bytes_missing", missing_attachment_ids=sorted(missing))
    return result


def export_legacy_profile(source_workspace: Path, *, profile_id="default", browser_export: dict | None = None,
                          browser_sources: list[dict] | None = None) -> dict:
    """Read old SQLite only. Optional browser export supplies otherwise absent PDFs.

    Browser source records are explicit user-exported records, never discovered
    by walking browser profiles or unrelated filesystem paths. They retain their
    original provenance and are not upgraded to confirmed facts.
    """
    source = Path(source_workspace)
    path = source if source.suffix in {".db", ".sqlite", ".sqlite3"} else source / "jobctrl.db"
    if path.is_symlink() or not path.is_file():
        raise AppError("invalid_profile_source", "Choose an existing regular legacy Profile database.")
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        tables_present = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "candidate_profiles" not in tables_present:
            raise AppError("invalid_profile_source", "The source is not a legacy Profile database.")
        rows = conn.execute("SELECT * FROM candidate_profiles WHERE tenant_id='local' AND profile_id=?", (profile_id,)).fetchall()
        if len(rows) != 1:
            raise AppError("profile_transfer_missing", "The source must contain exactly one selected Profile.")
        root = dict(rows[0])
        tables = {table: _rows(conn, table, where="WHERE tenant_id='local' AND profile_id=?", params=(profile_id,))
                  for table in LEGACY_TABLES if table in tables_present}
        profile_events = []
        if "job_events" in tables_present:
            profile_events = _rows(conn, "job_events", where="WHERE tenant_id='local' AND event_type IN ('ProfileUpdated','ProfileImported','LegacyEvidenceReviewRecorded')")
        bindings = []
        if "semantic_entity_bindings" in tables_present:
            bindings = _rows(conn, "semantic_entity_bindings", where="WHERE tenant_id='local' AND entity_kind IN ('profile','profile_coaching','resume_import_attempt')")
        determination_ids = {item["determination_id"] for item in bindings}
        determinations = []
        if "semantic_determinations" in tables_present:
            determinations = [item for item in _rows(conn, "semantic_determinations", where="WHERE tenant_id='local' AND lane='profile'")
                              if item.get("kind") in PROFILE_DETERMINATIONS or item.get("determination_id") in determination_ids]
        document = validate_profile(_decode_legacy_profile(root, tables))
        confirmations = {}
        raw_data = {"legacy_profile_events": profile_events}
        originals = tables.get("candidate_profile_achievement_evidence", [])
        for role in document["resume"]["experience_entries"]:
            for evidence in role.get("achievement_evidence", []):
                key = profile_identity("evidence", profile_id, role["id"], evidence["id"])
                receipt = None
                for event in reversed(profile_events):
                    if event.get("event_type") != "LegacyEvidenceReviewRecorded":
                        continue
                    try:
                        payload = json.loads(event["payload_json"])
                    except (ValueError, TypeError):
                        continue
                    if all(payload.get(field) == value for field, value in (("profile_id", profile_id), ("entry_id", role["id"]), ("evidence_id", evidence["id"]))):
                        receipt = {**payload, "event_id": event["event_id"]}
                        break
                original = next((item for item in originals if item["entry_id"] == role["id"] and item["evidence_id"] == evidence["id"]), None)
                status = receipt.get("result", {}).get("status") if receipt else None
                valid = status in {"confirmed", "rejected"} and _valid_historic_confirmation(raw_data, original, receipt, status)
                authority = status if valid else "review_required" if evidence.get("user_confirmed") or (receipt and status != "unconfirmed") else "unconfirmed"
                confirmations[key] = {"status": authority, "receipt": receipt}
                if authority == "review_required":
                    evidence["confirmation_review_required"] = True
        style = {key: root.get("resume_style_" + key, value) for key, value in DEFAULT_STYLE.items()}
        if browser_sources is not None and browser_export is not None:
            raise AppError("invalid_browser_profile_export", "Supply one complete browser export manifest.")
        # A legacy list is retained only as an incomplete inventory. It cannot
        # establish that all browser-owned attachments were exported.
        if browser_sources is not None:
            browser_export = {"format": BROWSER_FORMAT, "complete": False, "sources": browser_sources,
                              "known_attachment_ids": [item.get("source_id") for item in browser_sources if item.get("attachment")],
                              "unavailable_refs": [], "reason": "browser_completeness_manifest_required"}
        manifest = browser_manifest(browser_export)
        browser = manifest["sources"]
        data = {"kind": "legacy", "profile_id": profile_id, "document": document, "style": style,
                "template_text": root.get("resume_template_text") or DEFAULT_TEMPLATE,
                "legacy_profile_version": root.get("version"), "legacy_tables": tables, "legacy_profile_events": profile_events,
                "legacy_semantic_bindings": bindings, "legacy_determinations": determinations,
                "confirmations": confirmations, "browser_sources": browser, "browser_export": manifest,
                "transfer_complete": manifest["complete"],
                "source_attachment_inventory": {"server_pdf_bytes": "not_stored_by_legacy_importer",
                    "browser_export_supplied": browser_export is not None, "unavailable_bytes_are_not_invented": True}}
        conn.rollback()
        return _bundle(data)


def import_profile(service, bundle: dict, *, expected_profile_version=None):
    """Import Profile only. Refuse an existing target Profile without changing it."""
    data = validate_bundle(bundle)
    profile_id = data.get("profile_id", "default")
    if expected_profile_version is not None:
        raise ConflictError("Profile transfer requires an empty target Profile.")
    if data.get("kind") == "target":
        tables = data.get("tables")
        if not isinstance(tables, dict) or set(tables) != set(TARGET_TABLES):
            raise AppError("invalid_profile_transfer", "The complete target Profile table manifest is required.")
        with service.repository.transaction() as conn:
            service.repository.check(conn, None, profile_id)
            if any(conn.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone() for table in TARGET_TABLES):
                raise ConflictError("The target Profile store is not empty.")
            for table in TARGET_TABLES:
                for row in tables[table]:
                    allowed = {item[1] for item in conn.execute(f'PRAGMA table_info("{table}")')}
                    if not isinstance(row, dict) or set(row) != allowed or row.get("profile_id") != profile_id:
                        raise AppError("invalid_profile_transfer", "A Profile table row or identity is invalid.")
                    columns = list(row)
                    conn.execute(f'INSERT INTO "{table}" ({",".join(columns)}) VALUES ({",".join("?" for _ in columns)})', tuple(row[key] for key in columns))
            snapshot = service.snapshot(profile_id, conn)
            if snapshot.to_dict() != data.get("snapshot"):
                raise AppError("invalid_profile_transfer", "The imported Profile does not match its exact source snapshot.")
            for source in snapshot.evidence_sources:
                service._validate_attachment(source.get("attachment"), maximum_bytes=None)
            service.repository.event(conn, "ProfileUpdated", profile_id)
            return snapshot
    if data.get("kind") != "legacy":
        raise AppError("invalid_profile_transfer", "The Profile transfer source kind is unsupported.")
    manifest = browser_manifest(data.get("browser_export"))
    if not manifest["complete"] or data.get("transfer_complete") is not True:
        raise AppError("profile_transfer_incomplete", "Complete the read-only browser Profile export before importing. Known attachment bytes cannot be omitted.",
                       409, {"reason": manifest.get("reason", "browser_source_export_incomplete"),
                             "missingAttachmentIds": manifest.get("missing_attachment_ids", [])})
    document = validate_profile(data.get("document"))
    style = normalize_style(data.get("style", {}))
    template = data.get("template_text")
    if not isinstance(template, str) or not template.strip():
        raise AppError("invalid_profile_transfer", "The authored baseline template is missing.")
    with service.repository.transaction() as conn:
        service.repository.check(conn, None, profile_id)
        if conn.execute("SELECT 1 FROM profile_sources LIMIT 1").fetchone():
            raise ConflictError("The target Profile store contains source records.")
        conn.execute("INSERT INTO profile_documents VALUES(?,1,1,1,?,?,?,?,?)",
                     (profile_id, canonical(document), canonical(style), template,
                      canonical({"kind": "legacy_transfer", "source_version": data.get("legacy_profile_version"),
                                 "historic_confirmation_is_not_assumed": True}), now()))
        service.repository.sync_authored_sources(conn, document, {}, profile_id=profile_id, imported=True)
        originals = data.get("legacy_tables", {}).get("candidate_profile_achievement_evidence", [])
        for source_id, confirmation in data.get("confirmations", {}).items():
            row = conn.execute("SELECT * FROM profile_sources WHERE profile_id=? AND source_id=?", (profile_id, source_id)).fetchone()
            if not row:
                raise AppError("invalid_profile_transfer", "A confirmation points to missing Profile evidence.")
            content = json.loads(row["content_json"])
            original = next((item for item in originals if item.get("entry_id") == content.get("role_id") and item.get("evidence_id") == content.get("evidence_id")), None)
            content["legacy_original"] = original
            content["legacy_review_receipt"] = confirmation.get("receipt")
            status = confirmation.get("status")
            if status not in {"confirmed", "rejected", "review_required", "unconfirmed"}:
                raise AppError("invalid_profile_transfer", "A historic confirmation status is invalid.")
            # Historic human authority is retained with its receipt. The source
            # exporter validated it against exact old cells; bare old flags do
            # not become confirmation in the target.
            if status in {"confirmed", "rejected"} and not _valid_historic_confirmation(data, original, confirmation.get("receipt"), status):
                status = "review_required"
            conn.execute("UPDATE profile_sources SET content_json=?,confirmation=? WHERE profile_id=? AND source_id=?",
                         (canonical(content), status, profile_id, source_id))
            conn.execute("UPDATE profile_source_versions SET record_json=? WHERE profile_id=? AND source_id=? AND revision=1",
                         (canonical({**content, "source_id": source_id, "revision": 1, "confirmation": status}), profile_id, source_id))
        for index, source in enumerate(manifest["sources"]):
            service._validate_attachment(source.get("attachment"), maximum_bytes=None)
            service.repository.upsert_source(conn, profile_id, profile_identity("browser-source", profile_id, source["source_id"]),
                                             {**source, "origin": "attached", "kind": source.get("kind", "legacy_browser_source")},
                                             confirmation="review_required")
        conn.execute("INSERT INTO profile_transfer_provenance VALUES(?,?)", (profile_id, canonical(bundle)))
        service.repository.retain_version(conn, profile_id)
        service.repository.event(conn, "ProfileUpdated", profile_id)
        return service.snapshot(profile_id, conn)
