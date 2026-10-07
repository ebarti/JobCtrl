"""Review a saved draft against version-fenced canonical sources in sync RPC."""

import hashlib
import json
from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.profile.canonical_sources import profile_sources
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.edit_intent import ModelEditIntent
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.determinations import determination_dependencies, SqliteDeterminationRepository
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.materials.employer_analysis_repository import SqliteEmployerAnalysisRepository
from jobctrl.domain.identifiers import canonical_job_id


def review_saved_edit_intent(connection, *, tenant_id, draft_id, revision_id, dependencies=None):
    revision = connection.execute(
        "SELECT r.edited_text FROM resume_review_draft_revisions r JOIN resume_review_drafts d ON d.tenant_id=r.tenant_id AND d.draft_id=r.draft_id WHERE r.tenant_id=? AND r.draft_id=? AND r.revision_id=? AND d.current_revision_id=r.revision_id",
        (tenant_id, draft_id, revision_id),
    ).fetchone()
    if revision is None:
        raise DeterminationFailure("stale_draft_revision")
    edits = connection.execute(
        "SELECT delta_id,before_text,after_text FROM resume_review_edit_deltas WHERE tenant_id=? AND revision_id=? ORDER BY delta_id",
        (tenant_id, revision_id),
    ).fetchall()
    text = revision["edited_text"].replace("\r\n", "\n")
    fingerprint = hashlib.sha256(text.encode()).hexdigest()
    intent = None
    if edits:
        deps = dependencies or determination_dependencies(connection, tenant_id=tenant_id, lane="tailoring")
        _, intent = ModelEditIntent(**deps).interpret(
            entity_id=revision_id,
            sources=[
                Source(
                    source_id=row["delta_id"],
                    text=json.dumps({"before": row["before_text"], "after": row["after_text"]}, ensure_ascii=False),
                )
                for row in edits
            ],
        )
    current = connection.execute(
        "SELECT current_revision_id FROM resume_review_drafts WHERE tenant_id=? AND draft_id=?", (tenant_id, draft_id)
    ).fetchone()
    if current is None or current[0] != revision_id:
        raise DeterminationFailure("stale_draft_revision")
    if intent:
        SqliteDeterminationRepository(connection).bind(
            tenant_id=tenant_id,
            entity_kind="resume_revision",
            entity_id=revision_id,
            entity_version=fingerprint,
            determination_kind="edit_intent",
            determination_id=intent.determination_id,
        )
    return {
        "revisionId": revision_id,
        "textFingerprint": fingerprint,
        "editIntentId": intent.determination_id if intent else None,
    }


def review_saved_resume_edit(connection, *, tenant_id, draft_id, revision_id, dependencies=None):
    draft = connection.execute(
        "SELECT * FROM resume_review_drafts WHERE tenant_id=? AND draft_id=?", (tenant_id, draft_id)
    ).fetchone()
    revision = connection.execute(
        "SELECT * FROM resume_review_draft_revisions WHERE tenant_id=? AND draft_id=? AND revision_id=?",
        (tenant_id, draft_id, revision_id),
    ).fetchone()
    if draft is None or revision is None or draft["current_revision_id"] != revision_id:
        raise DeterminationFailure("stale_draft_revision")
    profile = SqliteProfileRepository(connection, publisher=get_default_publisher()).load_snapshot(TenantId(tenant_id))
    analysis = SqliteEmployerAnalysisRepository(connection).load(TenantId(tenant_id), canonical_job_id(draft["job_id"]))
    if analysis is None:
        raise DeterminationFailure("job_interpretation_unavailable")
    sources = profile_sources(profile.as_dict())
    requirements = [Source(source_id=row.id, text=row.text) for row in analysis.canonical.requirements]
    text = revision["edited_text"].replace("\r\n", "\n")
    lines = [
        ArtifactLine(
            line_id=f"edited:line:{index + 1}",
            text=line,
            allowed_evidence_ids=[row.source_id for row in sources],
            allowed_requirement_ids=[row.source_id for row in requirements],
        )
        for index, line in enumerate(line.strip() for line in text.split("\n") if line.strip())
    ]
    deps = dependencies or determination_dependencies(connection, tenant_id=tenant_id, lane="tailoring")
    verification, claim = ModelClaimVerifier(**deps).verify(
        artifact_kind="user_edit",
        entity_id=revision_id,
        lines=lines,
        evidence=sources,
        requirements=requirements,
        rubric={
            "truthfulness": "User edits must have supported factual claims and no prohibited claims; judge voice semantically."
        },
    )
    quality, judge = ModelArtifactQualityJudge(**deps).judge(
        artifact_kind="user_edit",
        entity_id=revision_id,
        lines=lines,
        sources=sources + requirements,
        rubric={"quality": "An edited resume must be useful, readable and coherent for the role."},
    )
    intent_review = review_saved_edit_intent(
        connection, tenant_id=tenant_id, draft_id=draft_id, revision_id=revision_id, dependencies=deps
    )
    intent = (
        SqliteDeterminationRepository(connection).find(tenant_id, intent_review["editIntentId"])
        if intent_review["editIntentId"]
        else None
    )
    if (
        SqliteProfileRepository(connection, publisher=get_default_publisher())
        .load_snapshot(TenantId(tenant_id))
        .version
        != profile.version
    ):
        raise DeterminationFailure("stale_profile_version")
    current = connection.execute(
        "SELECT current_revision_id FROM resume_review_drafts WHERE tenant_id=? AND draft_id=?", (tenant_id, draft_id)
    ).fetchone()
    if current is None or current[0] != revision_id:
        raise DeterminationFailure("stale_draft_revision")
    repository = SqliteDeterminationRepository(connection)
    for kind, envelope in [("claim_verification", claim), ("artifact_quality", judge), ("edit_intent", intent)]:
        if envelope:
            repository.bind(
                tenant_id=tenant_id,
                entity_kind="resume_revision",
                entity_id=revision_id,
                entity_version=str(profile.version),
                determination_kind=kind,
                determination_id=envelope.determination_id,
            )
    anchors = []
    for row in verification.lines:
        evidence = sorted({citation.source_id for citation in row.source_evidence})
        anchors.append(
            dict(
                lineId=row.line_id,
                evidenceIds=evidence,
                requirementIds=row.served_requirement_ids,
                transformType="user_edit",
                reason=verification.rationale,
                determinationId=claim.determination_id,
            )
        )
    return dict(
        passed=verification.verdict == "pass" and quality.verdict == "pass",
        claimVerificationId=claim.determination_id,
        qualityDeterminationId=judge.determination_id,
        editIntentId=intent.determination_id if intent else None,
        revisionId=revision_id,
        textFingerprint=hashlib.sha256(text.encode()).hexdigest(),
        profileVersion=profile.version,
        analysisGeneration=analysis.generation,
        anchors=anchors,
        errors=[row.rationale for row in quality.findings]
        + [finding.rationale for row in verification.lines for finding in row.findings]
        + ([verification.rationale] if verification.verdict == "fail" else []),
    )
