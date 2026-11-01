"""Explicit synthetic model decisions for workflow tests; no text classification."""

import json

from jobctrl.domain.enrichment.interpretation import JobInterpretation
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.materials.claim_grounding import bullet_id_for_claim_location
from tests.test_semantic_determinations import Repository


def job_interpretation(requirements=(), *, seniority="senior", scope=None):
    def field(value):
        return {
            "value": value,
            "citations": [{"source_id": "posting", "quote": "Synthetic source"}],
            "rationale": "Explicit synthetic decision",
        }

    result = JobInterpretation.model_validate(
        {
            "track": field("ic"),
            "seniority": field(seniority),
            "occupation_family": field("software_engineering"),
            "work_model": field("unknown"),
            "places": [],
            "constraints": [],
            "compensation": [],
            "requirements": [
                {
                    "requirement_id": row.id,
                    "scope": scope or row.coverage_scope or "resume",
                    "protected_class": False,
                    "citations": [{"source_id": row.id, "quote": row.evidence_span}],
                    "rationale": "Explicit synthetic decision",
                }
                for row in requirements
            ],
        }
    )
    result._determination_id = "1" * 64
    return result


class JobInterpreter:
    def interpret(self, *, job, employer_analysis):
        return job_interpretation(employer_analysis.canonical.requirements)


def persona_decision(data, verdict="pass"):
    source = data["sources"][0]
    return {
        "verdict": verdict,
        "score": 0.1,
        "rationale": "Explicit synthetic persona verdict",
        "personas": [
            {
                "persona": code,
                "verdict": verdict,
                "score": 0.1,
                "rationale": "Explicit synthetic persona verdict",
                "citations": [{"source_id": source["source_id"], "quote": source["text"][:1000], "exact_values": []}],
                "findings": [],
            }
            for code in data["context"]["personas"]
        ],
    }


class VerificationModel:
    def __init__(self, verdict="pass", quality_source=None):
        self.verdict, self.quality_source, self.calls = verdict, quality_source, []

    def chat_json(self, messages, *, response_schema, **kwargs):
        data = claim_verification_input(json.loads(messages[1].content))
        self.calls.append(data)
        verdict = (
            self.verdict[min(len(self.calls) - 1, len(self.verdict) - 1)]
            if isinstance(self.verdict, list)
            else self.verdict
        )
        sources = {source["source_id"]: source["text"] for source in data["sources"]}
        if response_schema["title"] == "ResumeAdversarialReview":
            return persona_decision(data)
        if response_schema["title"] == "ArtifactQuality":
            raw = {"verdict": "PASS", "score": 0.9}
            if self.quality_source is not None and (
                getattr(self.quality_source, "_responses", None) or hasattr(self.quality_source, "last_payload")
            ):
                raw = self.quality_source.chat_json(messages, response_schema=response_schema)
            return {
                "verdict": "pass" if raw["verdict"] == "PASS" else "fail",
                "score": float(raw.get("score", 0.9)),
                "findings": [],
                "evidence_corrections": [
                    {"source_id": ident, "quote": sources.get(ident, "Synthetic invalid source"), "exact_values": []}
                    for ident in raw.get("retry_evidence_ids", [])
                ],
                "rationale": "Explicit quality verdict",
            }

        def cite(source_id):
            return {"source_id": source_id, "quote": sources[source_id], "exact_values": []}

        result = {
            "verdict": verdict,
            "rationale": "Explicit support verdict",
            "lines": [
                {
                    "line_id": row["line_id"],
                    "verdict": verdict,
                    "source_evidence": [cite(ident) for ident in row["allowed_evidence_ids"]],
                    "served_requirements": [
                        {"requirement_id": ident, "citation": cite(ident), "rationale": "Explicit requirement decision"}
                        for ident in row["allowed_requirement_ids"]
                    ],
                    "claims": [],
                    "findings": []
                    if verdict == "pass"
                    else [
                        {
                            "kind": "unsupported_claim",
                            "rationale": "Explicit rejection",
                            "citation": cite("line:" + row["line_id"]),
                        }
                    ],
                }
                for row in data["context"]["lines"]
            ],
        }

        return claim_verification_response(data, result)


def review_ports(quality_source=None, verdict="pass", lane="tailoring"):
    deps = dict(
        repository=Repository(),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane=lane,
        preflight=lambda: None,
    )
    return (
        ModelClaimVerifier(llm=VerificationModel(verdict), **deps),
        ModelArtifactQualityJudge(llm=VerificationModel(quality_source=quality_source), **deps),
    )


def draft_anchor_fields(payload):
    for mapping in payload.get("generated_claim_mappings", []):
        mapping.setdefault("line_id", bullet_id_for_claim_location(mapping.get("location", "")) or "invalid")
        mapping.setdefault("reason", "Synthetic generator anchor")
        mapping.setdefault("transform_type", "rephrase")
    return payload


def tailor_dependencies(llm, *, verdict="pass"):
    verifier, quality = review_ports(quality_source=llm, verdict=verdict)
    return dict(
        claim_verifier=verifier, quality_judge=quality, job_interpreter=JobInterpreter(), preflight=lambda: None
    )


def recorded_job_interpretation(conn, job):
    from jobctrl.domain.determinations import Source
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.enrichment.interpretation import interpret_job
    from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
    from tests.compensation_fakes import ClassificationModel, dependencies

    analysis = SqliteEmployerAnalysisRepository(conn).load(LOCAL_TENANT, JobId(job["job_id"]))
    result, _ = interpret_job(
        conn, job, requirements=[Source(source_id=row.id, text=row.evidence_span)
                                for row in analysis.canonical.requirements] if analysis else [],
        dependencies=dependencies(conn, ClassificationModel(), "enrichment"),
    )
    return result


def scoring_case(conn, llm):
    from jobctrl.scoring.scorer import _build_use_case
    from jobctrl.infrastructure.scoring import SqliteScoreRepository
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from jobctrl.domain.determinations import Source

    return _build_use_case(
        repository=SqliteScoreRepository(conn),
        determination_dependencies=dict(
            llm=llm,
            repository=SqliteDeterminationRepository(conn),
            tenant_id="local",
            provider="synthetic",
            model="synthetic",
            lane="scoring",
            preflight=lambda: None,
        ),
        job_interpretation_reader=lambda job: recorded_job_interpretation(conn, job),
        confirmed_preferences_reader=lambda snapshot, criteria: [
            Source(source_id="target:roles:0", text="Synthetic saved target")
        ],
    )


def record_artifact_authority(conn):
    """Persist explicit model links for ID-join projection tests."""
    from jobctrl.domain.determinations import Source
    from jobctrl.domain.ports.claim_verification import ArtifactLine
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, save_artifact_anchors

    artifacts = conn.execute(
        "SELECT tenant_id,job_id,artifact_type,artifact_id,generation FROM job_materials_artifacts WHERE artifact_type IN ('tailored_resume','tailored_resume_txt','resume_pdf','tailored_resume_pdf')"
    ).fetchall()
    for tenant, job, kind, artifact_id, generation in artifacts:
        rows = conn.execute(
            "SELECT bullet_id,generated_text,evidence_ids_json,requirement_ids_json,transform_type,rationale FROM job_bullet_provenance WHERE tenant_id=? AND job_id=? AND generation=? ORDER BY position",
            (tenant, job, generation),
        ).fetchall()
        if not rows:
            continue
        evidence = {}
        requirements = {}
        lines = []
        anchors = []
        for line_id, text, evidence_json, requirements_json, transform, reason in rows:
            evidence_ids = json.loads(evidence_json)
            requirement_ids = json.loads(requirements_json)
            evidence.update({ident: Source(source_id=ident, text=text) for ident in evidence_ids})
            requirements.update({ident: Source(source_id=ident, text=ident) for ident in requirement_ids})
            lines.append(
                ArtifactLine(
                    line_id=line_id,
                    text=text,
                    allowed_evidence_ids=evidence_ids,
                    allowed_requirement_ids=requirement_ids,
                )
            )
            anchors.append(
                dict(
                    line_id=line_id,
                    evidence_ids=evidence_ids,
                    requirement_ids=requirement_ids,
                    transform_type=transform,
                    reason=reason,
                )
            )
        verifier = ModelClaimVerifier(
            llm=VerificationModel(),
            repository=SqliteDeterminationRepository(conn),
            tenant_id=tenant,
            provider="synthetic",
            model="synthetic",
            lane="tailoring",
            preflight=lambda: None,
        )
        _, receipt = verifier.verify(
            artifact_kind="resume",
            entity_id=job,
            lines=lines,
            evidence=list(evidence.values()),
            requirements=list(requirements.values()),
            rubric={},
        )
        save_artifact_anchors(
            conn,
            tenant_id=tenant,
            artifact_kind=kind,
            artifact_id=artifact_id,
            generation=generation,
            determination_id=receipt.determination_id,
            anchors=anchors,
            expected_entity_id=job,
        )



def claim_verification_input(data):
    """Decode structural request references for existing explicit fake decisions."""
    import copy

    refs = data["context"].get("citation_refs")
    if refs is None:
        return data
    data = copy.deepcopy(data)
    for line in data["context"]["lines"]:
        for name in ("allowed_evidence_ids", "allowed_requirement_ids"):
            line[name] = [refs.get(ident, {}).get("source_id", ident) for ident in line[name]]
    return data


def claim_verification_response(data, result, *, whole_sources=False):
    """Encode an explicit synthetic decision in the requested citation format."""
    import copy

    references = data["context"].get("citation_refs")
    if references is None:
        return result
    result = copy.deepcopy(result)
    by_id = {value["source_id"]: key for key, value in references.items()
             if "span_reference_quote" not in value}
    texts = {value["source_id"]: value["text"] for value in data["sources"]}

    def citation(value, *, supporting):
        if isinstance(value, str):
            return value
        ident = value["source_id"]
        ident = references.get(ident, {}).get("source_id", ident)
        ref = by_id.get(ident, ident)
        if (
            whole_sources and supporting and ref in references
            and references[ref]["whole_source_reference_allowed"]
            and value["quote"] == texts[ident] and not value.get("exact_values")
        ):
            return ref
        return {**value, "source_id": ref}

    for line in result.get("lines", []):
        line["source_evidence"] = [citation(value, supporting=True) for value in line["source_evidence"]]
        for served in line["served_requirements"]:
            served["citation"] = citation(served["citation"], supporting=True)
        for claim in line["claims"]:
            claim["text"] = citation(claim["text"], supporting=False)
            claim["evidence"] = [citation(value, supporting=True) for value in claim["evidence"]]
        for finding in line["findings"]:
            finding["citation"] = citation(finding["citation"], supporting=False)
    return result
