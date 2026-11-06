"""Independent source-bound translations of accepted resume revisions."""

from __future__ import annotations

from copy import deepcopy
from uuid import uuid4

from .domain import ResumeError, digest, document_lines
from .service import now, validate_model_result, review_schema

SUPPORTED_LOCALES = ("en", "es", "fr", "de", "it", "pt", "ca")


def translation_schema():
    citation = {"type": "object", "properties": {"source_id": {"type": "string"}, "quote": {"type": "string"}},
                "required": ["source_id", "quote"], "additionalProperties": False}
    line = {"type": "object", "properties": {"source_id": {"type": "string"}, "text": {"type": "string"},
            "citation": citation}, "required": ["source_id", "text", "citation"], "additionalProperties": False}
    return {"type": "object", "properties": {"lines": {"type": "array", "items": line},
            "findings": review_schema()["properties"]["findings"]},
            "required": ["lines", "findings"], "additionalProperties": False}


def translated_document(document, translations):
    """Literal field identity replacement, including all original fields and bullets."""
    result = deepcopy(document)
    values = {row["source_id"]: row["text"] for row in translations}
    result["section_labels"] = {key: values.get("heading:" + key, label)
                                for key, label in result.get("section_labels", {
                                    "summary": "Executive Profile", "experience": "Experience",
                                    "education": "Education", "skills": "Skills",
                                }).items()}
    for field in ("full_name", "address"):
        if f"personal:{field}" in values:
            result["personal"][field] = values[f"personal:{field}"]
    for index, item in enumerate(result["personal"].get("contact_items", [])):
        item["label"] = values.get(f"personal:contact:{index}", item["label"])
    if "summary" in values:
        result["summary"] = values["summary"]
    for role in result.get("experience", []):
        for field in ("title", "company", "location", "date_range", "summary"):
            identity = f"role:{role['id']}:{field}"
            if identity in values:
                role[field] = values[identity]
        for bullet in role.get("bullets", []):
            bullet["text"] = values[f"achievement:{bullet['achievement_id']}"]
    for index, row in enumerate(result.get("education", [])):
        for field in ("degree", "institution", "location", "date", "details"):
            identity = f"education:{row.get('id', str(index))}:{field}"
            if identity in values:
                row[field] = values[identity]
    for index, row in enumerate(result.get("skills", [])):
        identity = row.get("id", str(index))
        row["label"] = values.get(f"skills:{identity}:label", row["label"])
        row["items"] = [values.get(f"skills:{identity}:{item}", text) for item, text in enumerate(row["items"])]
    return result


def source(service, state, connection=None):
    accepted = service.accepted_snapshot(state["job_id"], connection=connection)
    if accepted is None or accepted["resume_id"] != state["resume_id"]:
        raise ResumeError("accepted_resume_required_for_locale")
    service.validate_attachment(accepted, connection=connection)
    revision = next(row for row in state["revisions"] if row["revision_id"] == accepted["revision_id"])
    return accepted, revision


async def generate(service, resume_id, *, expected_version, source_locale, target_locale):
    if (source_locale not in SUPPORTED_LOCALES or target_locale not in SUPPORTED_LOCALES
            or source_locale == target_locale):
        raise ResumeError("unsupported_resume_locale")
    state = service.get(resume_id)
    if state["version"] != expected_version:
        raise ResumeError("resume_version_conflict")
    accepted, revision = source(service, state)
    sources = document_lines(revision["document"])
    locale = {"locale_id": str(uuid4()), "source_revision_id": revision["revision_id"],
              "source_acceptance_id": accepted["acceptance_id"], "source_sha256": accepted["document_sha256"],
              "source_locale": source_locale, "target_locale": target_locale, "created_at": now(),
              "status": "failed", "findings": [], "review": {"status": "pending", "findings": []},
              "accepted_at": None, "renders": [], "document": None}
    try:
        if service.model is None:
            raise ResumeError("locale_model_unavailable")
        result = await service.model.determine(
            operation="resumes.locale_translate", instructions=(
                "Translate every supplied resume source line into the selected target locale. Preserve source order "
                "and every claim. Historical names, titles, companies, institutions, credentials, dates, locations, "
                "contact fields and achievement numeric values remain literally unchanged. Do not invent credential "
                "equivalence or omit content. Return each entire original line as its citation. Flag unsupported "
                "language, missing terminology or ambiguous credential meaning with source citations."),
            sources=sources, context={"resume_id": resume_id, "revision_id": revision["revision_id"],
                                     "source_locale": source_locale, "target_locale": target_locale},
            response_schema=translation_schema(), prompt_version="resume-locale-translation-v1", lane="resumes",
        )
        lines = result.value["lines"]
        if [row["source_id"] for row in lines] != [row["source_id"] for row in sources]:
            raise ResumeError("locale_source_inventory_invalid")
        from jobctrl.source_values import numeric_literals
        for original, translated in zip(sources, lines):
            citation = translated["citation"]
            if (citation != {"source_id": original["source_id"], "quote": original["text"]}
                    or not translated["text"].strip()):
                raise ResumeError("locale_source_binding_invalid")
            identity = original["source_id"]
            immutable = identity.startswith("personal:") or (
                identity.startswith("role:") and not identity.endswith(":summary")
            ) or (identity.startswith("education:") and not identity.endswith(":details"))
            if immutable and translated["text"] != original["text"]:
                raise ResumeError("locale_historical_field_changed")
            if [row[0] for row in numeric_literals(original["text"])] != [row[0] for row in numeric_literals(translated["text"])]:
                raise ResumeError("locale_literal_value_changed")
            for raw, _ in numeric_literals(original["text"]):
                for value in (raw + "%", *(symbol + raw for symbol in ("$", "€", "£", "¥"))):
                    if value in original["text"] and translated["text"].count(value) != original["text"].count(value):
                        raise ResumeError("locale_literal_value_changed")
        # Reuse source/provenance validation while preserving translation findings.
        class ReviewResult:
            value = {"verdict": "findings" if result.value["findings"] else "pass", "findings": result.value["findings"]}
            provenance = result.provenance
        validated = validate_model_result(ReviewResult(), sources)
        locale.update(status="generated", document=translated_document(revision["document"], lines),
                      translation_lines=lines, findings=result.value["findings"], provenance=validated["provenance"],
                      determination_id=validated["determination_id"])
    except Exception as exc:
        locale["failure_code"] = exc.code if isinstance(exc, ResumeError) else "locale_translation_unavailable"

    def mutate(latest, conn):
        latest_accepted, _ = source(service, latest, conn)
        if latest_accepted["acceptance_id"] != accepted["acceptance_id"]:
            raise ResumeError("accepted_resume_changed")
        latest["locales"].append(deepcopy(locale))
    return service.repository.change(resume_id, expected_version, mutate, event="ResumeLocaleUpdated")


async def review(service, resume_id, locale_id, *, expected_version):
    state = service.get(resume_id)
    if state["version"] != expected_version:
        raise ResumeError("resume_version_conflict")
    locale = next((row for row in state["locales"] if row["locale_id"] == locale_id), None)
    if locale is None or locale["status"] != "generated" or locale.get("review", {}).get("status") != "pending":
        raise ResumeError("locale_not_ready_for_review")
    accepted, revision = source(service, state)
    if accepted["acceptance_id"] != locale["source_acceptance_id"]:
        raise ResumeError("accepted_resume_changed")
    originals = document_lines(revision["document"])
    translations = [{"source_id": "translated:" + row["source_id"], "text": row["text"]}
                    for row in document_lines(locale["document"])]
    sources = originals + translations
    try:
        if service.model is None:
            raise ResumeError("locale_model_unavailable")
        result = await service.model.determine(
            operation="resumes.locale_verify", instructions=(
                "Independently verify every translated source line against the complete accepted original resume. "
                "Judge preservation of meaning, claims, historical facts and achievement values in the selected target "
                "language. Any omission, invented claim, mistranslation, missing terminology or ambiguous credential "
                "requires findings. Cite complete original and translated source lines for each finding. Do not rewrite."),
            sources=sources, context={"resume_id": resume_id, "locale_id": locale_id,
                                     "target_locale": locale["target_locale"], "source_sha256": locale["source_sha256"]},
            response_schema=review_schema(), prompt_version="resume-locale-verification-v1", lane="resumes",
        )
        outcome = validate_model_result(result, sources)
    except Exception as exc:
        outcome = {"status": "timeout" if isinstance(exc, TimeoutError) else "failed", "findings": [],
                   "failure_code": exc.code if isinstance(exc, ResumeError) else "locale_review_unavailable"}

    def mutate(latest, conn):
        latest_accepted, _ = source(service, latest, conn)
        if latest_accepted["acceptance_id"] != accepted["acceptance_id"]:
            raise ResumeError("accepted_resume_changed")
        target = next(row for row in latest["locales"] if row["locale_id"] == locale_id)
        target["review"] = {**outcome, "reviewed_at": now()}
    return service.repository.change(resume_id, expected_version, mutate, event="ResumeLocaleUpdated")


def accept(service, resume_id, locale_id, *, expected_version, user_confirmed=False):
    if user_confirmed is not True:
        raise ResumeError("explicit_locale_acceptance_required")
    state = service.get(resume_id)
    locale = next((row for row in state["locales"] if row["locale_id"] == locale_id), None)
    if locale is None or locale["review"]["status"] != "pass" or locale["findings"]:
        raise ResumeError("locale_independent_review_required")
    accepted, revision = source(service, state)
    if accepted["acceptance_id"] != locale["source_acceptance_id"]:
        raise ResumeError("accepted_resume_changed")
    artifact = service.renderer.render(locale["document"], revision["theme"],
                                       {"resume_id": resume_id, "revision_id": locale_id,
                                        "template_layout": (revision.get("template") or {}).get("layout")})
    if artifact["layout_conflicts"]:
        raise ResumeError("resume_layout_conflict")

    def mutate(latest, conn):
        latest_accepted, _ = source(service, latest, conn)
        if latest_accepted["acceptance_id"] != accepted["acceptance_id"]:
            raise ResumeError("accepted_resume_changed")
        target = next(row for row in latest["locales"] if row["locale_id"] == locale_id)
        target["accepted_at"] = now()
        target["status"] = "accepted"
        target["renders"].append(artifact)
        target["document_sha256"] = digest(target["document"])
    try:
        return service.repository.change(resume_id, expected_version, mutate, event="ResumeLocaleUpdated")
    except Exception:
        service.repository.abandon_file_intent(artifact["artifact_id"])
        raise


def export(service, resume_id, locale_id, *, format="pdf"):
    state = service.get(resume_id)
    locale = next((row for row in state["locales"] if row["locale_id"] == locale_id), None)
    if locale is None or locale["status"] != "accepted":
        raise ResumeError("accepted_locale_required")
    revision = next((row for row in state["revisions"] if row["revision_id"] == locale["source_revision_id"]), None)
    if revision is None:
        raise ResumeError("locale_source_revision_not_found")
    return service.renderer.export({**deepcopy(revision), "revision_id": locale_id, "document": locale["document"],
                                    "renders": locale["renders"], "locale": locale["target_locale"], "edit_draft": None}, format)
