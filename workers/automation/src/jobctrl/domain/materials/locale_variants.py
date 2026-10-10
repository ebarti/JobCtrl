"""Source-bound locale variants. Models judge meaning; code fences identities/values."""
from __future__ import annotations

from typing import Literal
import hashlib
import json
from pydantic import Field, StrictStr

from jobctrl.domain.determinations import (
    Citation, DeterminationFailure, DeterminationModel, Source, determine,
)
from jobctrl.domain.exact_values import numeric_literals
from jobctrl.resume_profile import get_experience_entries, get_education_entries

SUPPORTED_LOCALES = ("en", "es", "fr", "de", "it", "pt", "ca")


class LocaleLine(DeterminationModel):
    line_id: StrictStr
    text: StrictStr = Field(min_length=1, max_length=8000)
    source: Citation
    fact_ids: list[StrictStr]


class LocaleFinding(DeterminationModel):
    kind: Literal["missing_term", "unsupported_language", "ambiguous_credential"]
    line_id: StrictStr
    source: Citation
    detail: StrictStr = Field(min_length=1, max_length=2000)


class LocaleTranslation(DeterminationModel):
    lines: list[LocaleLine] = Field(min_length=1, max_length=500)
    findings: list[LocaleFinding] = Field(max_length=100)


class LocaleVerdict(DeterminationModel):
    line_id: StrictStr
    verdict: Literal["pass", "fail"]
    original: Citation
    translated: Citation
    reason: StrictStr = Field(min_length=1, max_length=2000)


class LocaleVerification(DeterminationModel):
    verdict: Literal["pass", "fail"]
    lines: list[LocaleVerdict] = Field(min_length=1, max_length=500)
    findings: list[LocaleFinding] = Field(max_length=100)


def protected_values(profile, accepted_text=""):
    """Literal authored fields, never inferred credential equivalence or prose labels."""
    values = []
    personal = profile.get("personal") or {}
    for key in ("full_name", "preferred_name", "email", "phone", "address", "city", "country", "postal_code", "website_url", "portfolio_url", "linkedin_url", "github_url"):
        value = personal.get(key)
        if isinstance(value, str) and value:
            values.append(value)
    for row in get_experience_entries(profile):
        values.extend(str(row[key]) for key in ("title", "company", "date_range", "location") if row.get(key))
    for row in get_education_entries(profile):
        values.extend(str(row[key]) for key in ("institution", "degree", "date", "location") if row.get(key))
    # Preserve the exact display spellings produced by the accepted source owner.
    # This is mechanical renderer formatting, not a semantic equivalence rule.
    from jobctrl.domain.materials.services import sanitize_text
    from jobctrl.domain.materials.resume_document import normalize_resume_date_range
    values.extend(sanitize_text(value) for value in tuple(values))
    for row in get_experience_entries(profile):
        if row.get("date_range"):
            values.append(normalize_resume_date_range(sanitize_text(str(row["date_range"]))))
    # ResumeAssembler frames experience entries with blank lines between its
    # literal EXPERIENCE and EDUCATION markers. Current profile fields may have
    # changed since this artifact was accepted, so bind the recorded headers.
    lines = accepted_text.splitlines()
    try:
        start = lines.index("EXPERIENCE") + 1
        end = lines.index("EDUCATION", start)
    except ValueError:
        pass
    else:
        entry_start = True
        for line in lines[start:end]:
            if not line.strip():
                entry_start = True
            elif entry_start:
                title, separator, company = line.partition(" | ")
                if separator:
                    values.extend((line, title, company))
                entry_start = False
    return sorted({value for value in values if value})


def source_lines(text):
    result = [Source(source_id=f"source:{index}", text=line) for index, line in enumerate(text.splitlines()) if line.strip()]
    if not result or len(result) > 500 or any(len(row.text) > 4000 for row in result):
        raise DeterminationFailure("invalid_line_inventory")
    return result


def validate_translation(result, originals, facts, protected):
    if [line.line_id for line in result.lines] != [source.source_id for source in originals]:
        raise DeterminationFailure("foreign_or_missing_line_id")
    fact_ids = {source.source_id for source in facts}
    for line, original in zip(result.lines, originals):
        if line.source.source_id != original.source_id or line.source.quote != original.text:
            raise DeterminationFailure("locale_source_binding_invalid")
        if len(set(line.fact_ids)) != len(line.fact_ids) or set(line.fact_ids) - fact_ids:
            raise DeterminationFailure("foreign_source_id")
        if "\n" in line.text or "\r" in line.text:
            raise DeterminationFailure("invalid_line_inventory")
        if [raw for raw, _ in numeric_literals(original.text)] != [raw for raw, _ in numeric_literals(line.text)]:
            raise DeterminationFailure("mismatched_value")
        for raw, _ in numeric_literals(original.text):
            for value in (raw + "%", *(symbol + raw for symbol in ("$", "€", "£", "¥"))):
                if value in original.text and line.text.count(value) != original.text.count(value):
                    raise DeterminationFailure("mismatched_value")
        for value in protected:
            if value in original.text and line.text.count(value) != original.text.count(value):
                raise DeterminationFailure("protected_field_changed")
    validate_findings(result.findings, originals)


def validate_findings(findings, originals):
    by_id = {source.source_id: source.text for source in originals}
    for finding in findings:
        if finding.line_id not in by_id or finding.source.source_id != finding.line_id:
            raise DeterminationFailure("finding_line_binding_invalid")


def translate(*, originals, facts, protected, context, entity_id, dependencies):
    def validate(result):
        validate_translation(result, originals, facts, protected)
    return determine(
        kind="material_locale_translation", schema=LocaleTranslation, schema_version="1",
        prompt_version="material-locale-translation-v1",
        instruction="Translate only descriptions to the explicitly selected target locale. Preserve line order and all accepted claims. Historical names, titles, institutions, credentials, dates, locations and achievement values must remain literally unchanged. Do not assert credential equivalence. Return each whole original line as its source citation and the canonical fact IDs actually used. Explicitly flag missing terminology, unsupported language or ambiguous credentials; never guess. Protected values are literal immutable fields. Do not add claims.",
        sources=[*originals, *facts], context={**context, "protected_values": protected},
        entity_id=entity_id, validate=validate, **dependencies,
    )


def verify(*, translation, originals, facts, context, entity_id, dependencies):
    translated = [Source(source_id="translated:" + row.line_id, text=row.text) for row in translation.lines]
    def validate(result):
        validate_verification(result, originals, translated)
    return determine(
        kind="material_locale_verification", schema=LocaleVerification, schema_version="1",
        prompt_version="material-locale-verification-v1",
        instruction="Independently verify the translation against every accepted source line and canonical facts. Judge whether the target language preserves exactly the original meaning, claims, historical identities, titles, credentials and achievement values without invented equivalence or omissions. A mistranslation, unsupported factual claim or unresolved terminology/credential requires fail. Cite each complete original and translated line. Report explicit missing-term, unsupported-language and ambiguous-credential findings.",
        sources=[*originals, *translated, *facts], context=context, entity_id=entity_id,
        validate=validate, **dependencies,
    )


def validate_verification(result, originals, translated):
    if [row.line_id for row in result.lines] != [row.source_id for row in originals]:
        raise DeterminationFailure("foreign_or_missing_line_id")
    for row, original, target in zip(result.lines, originals, translated):
        if (row.original.source_id != original.source_id or row.original.quote != original.text
                or row.translated.source_id != target.source_id or row.translated.quote != target.text):
            raise DeterminationFailure("locale_source_binding_invalid")
    validate_findings(result.findings, originals)
    if result.verdict == "pass" and (result.findings or any(row.verdict != "pass" for row in result.lines)):
        raise DeterminationFailure("inconsistent_verdict")


class GenerateRequest(DeterminationModel):
    operation: Literal["generate"]
    sourceArtifactId: StrictStr = Field(min_length=1, max_length=240)
    sourceLocale: StrictStr = Field(min_length=2, max_length=35)
    targetLocale: StrictStr = Field(min_length=2, max_length=35)
    expectedGeneration: int = Field(gt=0)
    expectedProfileVersion: int = Field(gt=0)


class HistoryRequest(DeterminationModel):
    operation: Literal["history"]


class ReviewRequest(DeterminationModel):
    operation: Literal["review"]
    revisionId: StrictStr
    expectedVersion: int = Field(gt=0)
    dimension: Literal["terminology", "formatting"]
    decision: Literal["accepted", "rejected"]
    note: StrictStr = Field(max_length=2000)


class AcceptRequest(DeterminationModel):
    operation: Literal["accept", "reject"]
    revisionId: StrictStr
    expectedVersion: int = Field(gt=0)


class ExportRequest(DeterminationModel):
    operation: Literal["export"]
    revisionId: StrictStr
    expectedVersion: int = Field(gt=0)
    format: Literal["txt", "html", "pdf", "docx"]


def parse_request(value):
    from pydantic import TypeAdapter, ValidationError
    try:
        return TypeAdapter(GenerateRequest | HistoryRequest | ReviewRequest | AcceptRequest | ExportRequest).validate_python(value).model_dump()
    except ValidationError:
        raise DeterminationFailure("invalid_locale_request") from None


def locale_fingerprint(*, kind, schema, prompt_version, sources, context, envelope):
    """Reconstruct the native determination input identity without calling a model."""
    response_schema = schema.model_json_schema()
    response_schema["$defs"]["Citation"]["properties"]["source_id"]["enum"] = [source.source_id for source in sources]
    identity = {
        "kind": kind, "schema_version": "1", "prompt_version": prompt_version, "schema": response_schema,
        "provider": envelope.provider, "model": envelope.model, "lane": "tailoring", "tenant_id": envelope.tenant_id,
        "entity_id": envelope.entity_id, "input": {"sources": [source.model_dump() for source in sources], "context": context},
    }
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
