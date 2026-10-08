"""Reviewed locale documents. Model authority decides meaning; code fences identity."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, Source, determine
from jobctrl.domain.exact_values import numeric_literals
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.ports.claim_verification import ArtifactLine

LOCALES = ("en", "es", "fr", "de", "it", "pt", "ca")
NAMESPACE = "__jobctrl_locale_variants_v1"


def digest(value):
    data = (
        value
        if isinstance(value, bytes)
        else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    )
    return hashlib.sha256(data).hexdigest()


class LocaleIssue(DeterminationModel):
    line_id: StrictStr
    kind: Literal["missing_term", "ambiguous_credential", "unsupported_language", "factual_uncertainty"]
    citation: Citation
    explanation: StrictStr = Field(min_length=1, max_length=1500)


class TranslatedLine(DeterminationModel):
    line_id: StrictStr
    text: StrictStr = Field(min_length=1, max_length=16000)
    source: Citation


class LocaleTranslation(DeterminationModel):
    lines: list[TranslatedLine] = Field(min_length=1, max_length=1000)
    issues: list[LocaleIssue] = Field(max_length=100)


class LocaleReview(DeterminationModel):
    verdict: Literal["pass", "fail"]
    terminology: Literal["pass", "fail"]
    formatting: Literal["pass", "fail"]
    issues: list[LocaleIssue] = Field(max_length=100)
    rationale: StrictStr = Field(min_length=1, max_length=1500)


class LocaleCommand(DeterminationModel):
    operation: Literal["generate", "list", "review", "export"]
    jobId: StrictStr
    artifactId: StrictStr | None = None
    sourceLocale: StrictStr | None = None
    targetLocale: StrictStr | None = None
    expectedRevision: int = Field(default=0, ge=0, strict=True)
    variantId: StrictStr | None = None
    terminology: Literal["confirmed", "rejected"] | None = None
    formatting: Literal["confirmed", "rejected"] | None = None
    decision: Literal["accepted", "rejected"] | None = None
    format: Literal["text", "html", "pdf", "docx"] | None = None


def translate_document(*, binding, dependencies):
    """Translate exact accepted source lines, then independently review final lines."""
    if binding["sourceLocale"] not in LOCALES or binding["targetLocale"] not in LOCALES:
        raise DeterminationFailure("unsupported_locale")
    if binding["sourceLocale"] == binding["targetLocale"]:
        raise DeterminationFailure("same_locale")
    original = binding["lines"]
    source_ids = {row["line_id"] for row in original}
    evidence = [Source(source_id=row["line_id"], text=row["text"]) for row in original]
    facts = [Source.model_validate(row) for row in binding["facts"]]

    def validate_translation(result):
        if [row.line_id for row in result.lines] != [row["line_id"] for row in original]:
            raise DeterminationFailure("foreign_or_missing_line_id")
        for row, source in zip(result.lines, original, strict=True):
            if row.source.source_id != source["line_id"] or row.source.quote != source["text"]:
                raise DeterminationFailure("source_line_binding_invalid")
            # Literal typed historical fields and number tokens are immutable.
            # This checks representation, never decides factual support or meaning.
            protected = source["protected"]
            for value in protected:
                if row.text.count(value) != source["text"].count(value):
                    raise DeterminationFailure("changed_historical_value")
            if [value for _, value in numeric_literals(row.text)] != [
                value for _, value in numeric_literals(source["text"])
            ]:
                raise DeterminationFailure("changed_exact_value")
        validate_issues(result.issues, source_ids)

    entity_id = binding["identity"]
    translation, translator = determine(
        kind="material_locale_translation",
        schema=LocaleTranslation,
        schema_version="1",
        prompt_version="material-locale-translation-v1",
        instruction="Translate each source line into the selected target locale, in the exact supplied order. Only descriptive wording may change. Preserve all historical names, titles, employers, institutions, credential designations, dates and achievement values literally. No invented credential equivalence or normalized degree. Preserve protected strings literally. Cite the complete original line. Report missing terminology, unsupported language, credential ambiguity and factual uncertainty explicitly. Never silently assert equivalence.",
        sources=[*evidence, *facts],
        context={"binding": binding},
        entity_id=entity_id,
        validate=validate_translation,
        **dependencies,
    )
    translated_sources = [Source(source_id="translated:" + row.line_id, text=row.text) for row in translation.lines]

    def validate_review(result):
        validate_issues(result.issues, source_ids | {row.source_id for row in translated_sources})
        if result.verdict == "pass" and (
            result.terminology != "pass"
            or result.formatting != "pass"
            or any(issue.kind != "ambiguous_credential" for issue in result.issues)
        ):
            raise DeterminationFailure("inconsistent_verdict")

    review, reviewer = determine(
        kind="material_locale_review",
        schema=LocaleReview,
        schema_version="1",
        prompt_version="material-locale-review-v1",
        instruction="Independently compare the original and translated document with the canonical facts. Judge translation completeness, terminology and formatting separately. Verify all claims, historical titles, achievements and credential designations preserve their original meaning without credential equivalence. Missing terms, unsupported languages and uncertainty fail. An ambiguous credential may remain in its original designation with an explicit warning; do not assert its equivalence. Cite actual original or translated line IDs. Review actual output, not translator assurances.",
        sources=[*evidence, *translated_sources, *facts],
        context={"binding": binding, "translation": translation.model_dump()},
        entity_id=entity_id,
        validate=validate_review,
        **dependencies,
    )
    lines = [
        ArtifactLine(
            line_id=row.line_id,
            text=row.text,
            allowed_evidence_ids=[row.line_id, *[s.source_id for s in facts]],
            allowed_requirement_ids=[],
        )
        for row in translation.lines
    ]
    rubric = {
        "locale": "Verify the actual translated wording preserves source claims exactly, with no credential equivalence, rewritten titles or achievements. Warnings may retain an original ambiguous credential. Descriptions alone are translated."
    }
    verified, verifier = ModelClaimVerifier(**dependencies).verify(
        artifact_kind=binding["kind"],
        entity_id=entity_id,
        lines=lines,
        evidence=[*evidence, *facts],
        requirements=[],
        rubric=rubric,
    )
    quality, judge = ModelArtifactQualityJudge(**dependencies).judge(
        artifact_kind=binding["kind"], entity_id=entity_id, lines=lines, sources=[*evidence, *facts], rubric=rubric
    )
    issues = [*translation.issues, *review.issues]
    eligible = (
        review.verdict == "pass"
        and verified.verdict == "pass"
        and all(row.verdict == "pass" for row in verified.lines)
        and quality.verdict == "pass"
        and all(issue.kind == "ambiguous_credential" for issue in issues)
    )
    return dict(
        lines=[row.model_dump() for row in translation.lines],
        issues=[row.model_dump() for row in issues],
        eligible=eligible,
        determinations=[envelope.model_dump() for envelope in (translator, reviewer, verifier, judge)],
        semanticReview=review.model_dump(),
    )


def validate_issues(issues, ids):
    for issue in issues:
        if issue.line_id not in ids or issue.citation.source_id != issue.line_id:
            raise DeterminationFailure("foreign_source_id")
