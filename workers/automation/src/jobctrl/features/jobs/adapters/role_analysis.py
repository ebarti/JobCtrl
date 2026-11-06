"""Source-bound role analysis retains optional multi-model observations."""

from jobctrl.app.errors import AppError
from jobctrl.semantic import Source, validate_citations
from jobctrl.features.jobs.domain.analysis import RoleAnalysis
from jobctrl.features.jobs.domain.postings import digest


INSTRUCTIONS = (
    "Read this exact employer posting to explain the role's mission, ownership and ideal candidate capabilities. "
    "Infer seniority from explicit scope/responsibility, using unknown when insufficient. Every statement and keyword "
    "needs verbatim captured posting citations and explicit uncertainty. Keywords must name actual screening-relevant "
    "skills/tools/qualifications supported by evidence_span; never match by token counts or infer qualifications "
    "from applicant data. requirement_ref must be null unless an exact supplied qualified requirement ID supports it. "
    "Do not create or redefine canonical requirements. Keep model comparison process out of role narrative."
)


class SourceBoundRoleAnalysis:
    def __init__(self, model):
        self.model = model

    def request_fingerprint(self, posting, *, models=None, requirement_context=None):
        selected = models or [None]
        if (
            not isinstance(selected, list)
            or not 1 <= len(selected) <= 3
            or any(model is not None and not isinstance(model, str) for model in selected)
        ):
            raise AppError("invalid_analysis_models", "Choose one to three configured analysis models.")
        source = Source(source_id="posting:" + posting["source_hash"], text=posting["description"])
        return digest(
            [
                self.model.fingerprint(
                    operation="jobs.role_analysis",
                    instructions=INSTRUCTIONS,
                    sources=[source.model_dump()],
                    response_schema=RoleAnalysis.model_json_schema(),
                    context={
                        "job_id": posting["job_id"],
                        "posting_revision": posting["revision"],
                        "qualified_requirements": requirement_context or [],
                    },
                    model=model,
                    prompt_version="role-analysis-v1",
                    lane="analysis",
                )
                for model in selected
            ]
        )

    async def analyze(self, posting, *, models=None, requirement_context=None, cancelled=None):
        source = Source(source_id="posting:" + posting["source_hash"], text=posting["description"])
        known = requirement_context or []
        refs = {row.get("requirement_id") or row.get("id") for row in known}
        observations, failures = [], []
        selected = models or [None]
        if (
            not isinstance(selected, list)
            or not 1 <= len(selected) <= 3
            or any(m is not None and not isinstance(m, str) for m in selected)
        ):
            raise AppError("invalid_analysis_models", "Choose one to three configured analysis models.")
        for model in selected:
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Role analysis was cancelled.", 409)
            try:
                response = await self.model.determine(
                    operation="jobs.role_analysis",
                    instructions=INSTRUCTIONS,
                    sources=[source.model_dump()],
                    response_schema=RoleAnalysis.model_json_schema(),
                    context={
                        "job_id": posting["job_id"],
                        "posting_revision": posting["revision"],
                        "qualified_requirements": known,
                    },
                    model=model,
                    prompt_version="role-analysis-v1",
                    lane="analysis",
                )
                result = RoleAnalysis.model_validate(response.value)
                validate_citations(result, [source])
                for keyword in result.keywords:
                    if (
                        keyword.evidence_span not in source.text
                        or keyword.requirement_ref is not None
                        and keyword.requirement_ref not in refs
                    ):
                        raise AppError(
                            "analysis_source_binding_invalid",
                            "The role analysis referenced unsupported source evidence.",
                            409,
                        )
                observations.append({"analysis": result.model_dump(), "provenance": response.provenance})
            except Exception as error:
                failures.append({"model": model, "code": getattr(error, "code", "analysis_failed")})
        if not observations:
            raise AppError(
                "role_analysis_failed",
                "No source-bound role analysis completed; the last accepted analysis is retained.",
                503,
                {"failures": failures},
            )
        accepted = observations[0]
        if len(observations) > 1:
            response = await self.model.determine(
                operation="jobs.role_analysis_synthesis",
                instructions=INSTRUCTIONS
                + " Reconcile the supplied model observations against the original posting only. Retain disagreements as uncertainty; model agreement does not establish a fact.",
                sources=[source.model_dump()],
                response_schema=RoleAnalysis.model_json_schema(),
                context={"observations": observations, "qualified_requirements": known},
                prompt_version="role-analysis-synthesis-v1",
                lane="analysis",
            )
            result = RoleAnalysis.model_validate(response.value)
            validate_citations(result, [source])
            if any(
                k.evidence_span not in source.text or k.requirement_ref is not None and k.requirement_ref not in refs
                for k in result.keywords
            ):
                raise AppError(
                    "analysis_source_binding_invalid",
                    "The synthesized role analysis referenced unsupported evidence.",
                    409,
                )
            accepted = {"analysis": result.model_dump(), "provenance": response.provenance}
        return {
            **accepted,
            "observations": observations,
            "failures": failures,
            "models": selected,
            "prompt_version": "role-analysis-v1",
            "request_fingerprint": digest(
                [observation["provenance"]["input_fingerprint"] for observation in observations]
            ),
        }
