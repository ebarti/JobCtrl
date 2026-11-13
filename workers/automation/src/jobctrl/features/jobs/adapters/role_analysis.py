"""Source-bound role analysis retains optional multi-model observations."""

from pydantic import ValidationError

from jobctrl.app.errors import AppError
from jobctrl.semantic import DeterminationFailure, Source, validate_citations
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

    @staticmethod
    def _source(posting):
        return Source(source_id="posting-content:v1:" + digest(posting["description"]), text=posting["description"])

    def _requests(self, posting, models, requirement_context):
        selected = models or [None]
        if (not isinstance(selected, list) or not 1 <= len(selected) <= 3
                or any(model is not None and not isinstance(model, str) for model in selected)):
            raise AppError("invalid_analysis_models", "Choose one to three configured analysis models.")
        source = self._source(posting)
        requests = [dict(
            operation="jobs.role_analysis", instructions=INSTRUCTIONS, sources=[source.model_dump()],
            response_schema=RoleAnalysis.model_json_schema(),
            context={"qualified_requirements": requirement_context or []}, model=model,
            execution=self.model.freeze_execution(model), prompt_version="role-analysis-v2-content-bound", lane="analysis",
        ) for model in selected]
        synthesis = dict(
            operation="jobs.role_analysis_synthesis",
            instructions=INSTRUCTIONS + " Reconcile the supplied model observations against the original posting only. Retain disagreements as uncertainty; model agreement does not establish a fact.",
            sources=[source.model_dump()], response_schema=RoleAnalysis.model_json_schema(),
            context={"qualified_requirements": requirement_context or []}, execution=self.model.freeze_execution(),
            prompt_version="role-analysis-synthesis-v2-content-bound", lane="analysis",
        ) if len(selected) > 1 else None
        return selected, source, requests, synthesis

    def request_fingerprint(self, posting, *, models=None, requirement_context=None):
        _, _, requests, synthesis = self._requests(posting, models, requirement_context)
        return self._request_key([self.model.fingerprint(**request) for request in requests], synthesis)

    def _request_key(self, observations, synthesis):
        return digest({"observations": observations,
                       "synthesis": self.model.fingerprint(**synthesis) if synthesis is not None else None})

    @staticmethod
    def _validate(value, source, refs):
        result = RoleAnalysis.model_validate(value)
        validate_citations(result, [source])
        if any(keyword.evidence_span not in source.text
               or keyword.requirement_ref is not None and keyword.requirement_ref not in refs
               for keyword in result.keywords):
            raise AppError("analysis_source_binding_invalid", "The role analysis referenced unsupported source evidence.", 409)
        return result

    async def _observation(self, request, source, refs):
        expected = self.model.fingerprint(**request)
        receipt = self.model.find_succeeded(expected)
        if receipt is not None:
            self._check_receipt(receipt, request, expected)
            try:
                result = self._validate(receipt["value"], source, refs)
            except (AppError, DeterminationFailure, ValidationError):
                # A structurally completed call that the owner cannot accept
                # is not reusable authority. This action still gets only its
                # original planned determination, with no repair loop.
                receipt = None
        if receipt is None:
            response = await self.model.determine(**request)
            # Join canonical authority even for a newly returned determination.
            receipt = self.model.receipt(response.provenance["receipt_id"])
            self._check_receipt(receipt, request, expected)
            result = self._validate(receipt["value"], source, refs)
        provenance = {key: receipt[key] for key in (
            "receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at",
        )}
        return {"analysis": result.model_dump(), "provenance": provenance}

    @staticmethod
    def _check_receipt(receipt, request, expected):
        if (receipt.get("status") != "succeeded" or receipt.get("input_fingerprint") != expected
                or receipt.get("operation") != request["operation"]
                or receipt.get("prompt_version") != request["prompt_version"]
                or receipt.get("provider") != request["execution"].provider
                or receipt.get("model") != request["execution"].model
                or receipt.get("lane") != request["lane"]):
            raise AppError("analysis_receipt_invalid", "The role analysis receipt does not match its exact input.", 409)

    async def analyze(self, posting, *, models=None, requirement_context=None, cancelled=None, refresh_identity=None):
        known = requirement_context or []
        refs = {row.get("requirement_id") or row.get("id") for row in known}
        selected, source, requests, synthesis = self._requests(posting, models, known)
        observations, failures, accepted_requests = [], [], []
        for model, base_request in zip(selected, requests, strict=True):
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Role analysis was cancelled.", 409)
            request = {**base_request, "context": {**base_request["context"],
                       **({"refresh_identity": refresh_identity} if refresh_identity is not None else {})}}
            try:
                observation = await self._observation(request, source, refs)
                observations.append(observation)
                # Compatibility with ordinary current-input reads is separate
                # from an explicit force action's unique provider receipt.
                accepted_requests.append(self.model.fingerprint(**base_request))
            except Exception as error:
                failures.append({"model": model, "code": getattr(error, "code", "analysis_failed")})
        if not observations:
            raise AppError("role_analysis_failed", "No source-bound role analysis completed; the last accepted analysis is retained.",
                           503, {"failures": failures})
        accepted = observations[0]
        if len(observations) > 1:
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Role analysis was cancelled.", 409)
            request = {**synthesis, "context": {**synthesis["context"], "observations": observations,
                       **({"refresh_identity": refresh_identity} if refresh_identity is not None else {})}}
            accepted = await self._observation(request, source, refs)
        return {
            **accepted, "observations": observations, "failures": failures, "models": selected,
            "prompt_version": "role-analysis-v2-content-bound",
            "request_fingerprint": self._request_key(accepted_requests, synthesis if len(observations) > 1 else None),
            "source_binding": {"version": 1,
                "semantic_source": {"source_id": source.source_id, "text_fingerprint": digest(source.text)},
                "destination_posting": {key: posting[key] for key in ("job_id", "revision", "source_hash")}},
        }
