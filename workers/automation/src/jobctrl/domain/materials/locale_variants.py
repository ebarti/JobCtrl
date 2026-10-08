"""Source-bound locale documents; semantic authority is recorded, never inferred."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, Source, determine
from jobctrl.domain.exact_values import numeric_literals
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.ports.claim_verification import ArtifactLine


class LocaleLine(DeterminationModel):
    line_id: StrictStr = Field(min_length=1, max_length=240)
    text: StrictStr = Field(min_length=1, max_length=4000)
    source: Citation


class LocaleConcern(DeterminationModel):
    kind: Literal["missing_term", "ambiguous_credential", "unsupported_locale"]
    source: Citation
    explanation: StrictStr = Field(min_length=1, max_length=1500)


class LocaleTranslation(DeterminationModel):
    supported: bool
    lines: list[LocaleLine] = Field(max_length=1000)
    concerns: list[LocaleConcern] = Field(max_length=100)
    rationale: StrictStr = Field(min_length=1, max_length=1500)


class LocaleTerminologyReview(DeterminationModel):
    verdict: Literal["pass", "fail"]
    concerns: list[LocaleConcern] = Field(max_length=100)
    rationale: StrictStr = Field(min_length=1, max_length=1500)


_PROTECTED_FIELDS = {
    "full_name",
    "name",
    "title",
    "company",
    "institution",
    "degree",
    "date",
    "date_range",
    "start_date",
    "end_date",
    "credential",
    "certification",
}


def protected_literals(profile: dict) -> list[str]:
    """Copy literal canonical fields, without classifying or deciding equivalence."""
    values: set[str] = set()

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in _PROTECTED_FIELDS and isinstance(child, str) and child:
                    values.add(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(profile)
    return sorted(values)


def source_lines(text: str, profile: dict) -> list[dict]:
    protected = protected_literals(profile)
    return [
        {
            "line_id": f"source:{index}",
            "text": line,
            "protected": sorted(
                {*(value for value in protected if value in line), *(literal for literal, _ in numeric_literals(line))}
            ),
        }
        for index, line in enumerate(text.splitlines())
        if line.strip()
    ]


def translate_document(*, binding: dict, profile: dict, dependencies: dict, fence: Callable[[], object]) -> dict:
    inventory = source_lines(binding["text"], profile)
    if not inventory or len(inventory) > 1000:
        raise DeterminationFailure("invalid_line_inventory")
    originals = {row["line_id"]: row for row in inventory}
    sources = [Source(source_id=row["line_id"], text=row["text"]) for row in inventory]
    canonical = Source(source_id="canonical:profile", text=binding["profile_json"])
    entity = binding.get("semantic_entity_id", binding["variant_id"])
    context = {
        "binding": {key: value for key, value in binding.items() if key not in {"text", "profile_json", "variant_id"}},
        "lines": inventory,
    }

    def preflight():
        fence()
        dependencies["preflight"]()

    deps = {**dependencies, "preflight": preflight, "entity_id": entity}

    def validate_translation(result: LocaleTranslation):
        if not result.supported:
            if result.lines or not any(row.kind == "unsupported_locale" for row in result.concerns):
                raise DeterminationFailure("invalid_locale_refusal")
            return
        if any(row.kind == "unsupported_locale" for row in result.concerns):
            raise DeterminationFailure("invalid_locale_refusal")
        if [row.line_id for row in result.lines] != [row["line_id"] for row in inventory]:
            raise DeterminationFailure("foreign_or_missing_line_id")
        for row in result.lines:
            original = originals[row.line_id]
            if row.source.source_id != row.line_id or row.source.quote != original["text"]:
                raise DeterminationFailure("source_line_binding_invalid")
            if any(value not in row.text for value in original["protected"]):
                raise DeterminationFailure("protected_value_changed")
            # Compare literal values, never infer semantic support from their presence.
            if [literal for literal, _ in numeric_literals(row.text)] != [
                literal for literal, _ in numeric_literals(original["text"])
            ]:
                raise DeterminationFailure("mismatched_value")
            if "\n" in row.text or "\r" in row.text or any(ord(char) < 32 and char != "\t" for char in row.text):
                raise DeterminationFailure("invalid_locale_line")

    translation, translated = determine(
        kind="material_locale_translation",
        schema=LocaleTranslation,
        schema_version="1",
        prompt_version="material-locale-translation-v1",
        instruction="Translate every source line in order into the explicitly selected target locale. Translate descriptions only. Preserve historical names, titles, institutions, credentials, dates and achievement values verbatim, including protected literals. Never assert credential equivalence. Preserve original wording for missing terminology or ambiguous credentials and report explicit concerns with source citations. Refuse unsupported source or target languages with supported=false, no lines and an unsupported_locale concern. Cite each full original source line. Do not add, omit or rewrite claims. Canonical facts constrain translation; they do not authorize adding facts absent from the accepted source.",
        sources=[*sources, canonical],
        context=context,
        validate=validate_translation,
        **deps,
    )
    fence()
    if not translation.supported:
        return {
            "status": "refused",
            "lines": [],
            "concerns": [row.model_dump() for row in translation.concerns],
            "determinations": [translated.model_dump()],
            "gate_passed": False,
        }
    lines = [
        ArtifactLine(
            line_id=row.line_id,
            text=row.text,
            allowed_evidence_ids=[row.line_id, canonical.source_id],
            allowed_requirement_ids=[],
        )
        for row in translation.lines
    ]
    target_sources = [Source(source_id="line:" + row.line_id, text=row.text) for row in translation.lines]

    def validate_terms(result: LocaleTerminologyReview):
        if result.verdict == "pass" and any(row.kind == "unsupported_locale" for row in result.concerns):
            raise DeterminationFailure("inconsistent_verdict")
        # Ambiguous terms must preserve the cited original wording in the corresponding line.
        for concern in [*translation.concerns, *result.concerns]:
            if concern.source.source_id not in originals:
                raise DeterminationFailure("foreign_source_id")
            target = next(row.text for row in translation.lines if row.line_id == concern.source.source_id)
            if concern.source.quote not in target:
                raise DeterminationFailure("unresolved_term_rewritten")

    terms, terminology = determine(
        kind="material_locale_terminology",
        schema=LocaleTerminologyReview,
        schema_version="1",
        prompt_version="material-locale-terminology-v1",
        instruction="Independently review each source/target line for terminology, complete claim equivalence, historical names/titles/dates/achievement fidelity and credential ambiguity. Decide pass or fail semantically. Never silently assert credential equivalence. Report missing terms and ambiguous credentials using original-source citations, and require original wording to remain in the translated line. Preserved ambiguity may pass with explicit concerns. Added/omitted claims, unsupported locales or changed historical facts must fail. Review the supplied generator concerns independently.",
        sources=[*sources, *target_sources, canonical],
        context={**context, "concerns": [row.model_dump() for row in translation.concerns]},
        validate=validate_terms,
        **deps,
    )
    fence()
    reviewer_deps = {key: value for key, value in deps.items() if key != "entity_id"}
    claims, verified = ModelClaimVerifier(**reviewer_deps).verify(
        artifact_kind=binding["kind"],
        entity_id=entity,
        lines=lines,
        evidence=[*sources, canonical],
        requirements=[],
        rubric={
            "locale": "Verify translation only against its matching accepted source line and canonical facts. No new facts or credential equivalence."
        },
    )
    fence()
    quality, judged = ModelArtifactQualityJudge(**reviewer_deps).judge(
        artifact_kind=binding["kind"],
        entity_id=entity,
        lines=lines,
        sources=[*sources, canonical],
        rubric={
            "locale": "Independently review translated clarity, structure, formatting and completeness; keep historical titles and names unchanged."
        },
    )
    fence()
    return {
        "status": "candidate",
        "lines": [row.model_dump() for row in translation.lines],
        "concerns": [row.model_dump() for row in [*translation.concerns, *terms.concerns]],
        "determinations": [row.model_dump() for row in (translated, terminology, verified, judged)],
        "gate_passed": terms.verdict == claims.verdict == quality.verdict == "pass",
    }
