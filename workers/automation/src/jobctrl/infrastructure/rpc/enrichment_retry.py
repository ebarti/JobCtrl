"""Synchronous, runtime-bound adapter to the enrichment retry service."""

from jobctrl.database import get_connection
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.rpc.server import invalid_params
from jobctrl.infrastructure.runtime_identity import assert_expected_runtime
from jobctrl.pipeline.retry import reset_retry_stages
from jobctrl.state import STAGE_ORDER


def reset_enrichment(params):
    required = {"tenantId", "expectedAppDir", "expectedDbPath", "targets"}
    if not required <= params.keys() or params.keys() - required - {"resetAttempts", "onlyFailed"}:
        raise invalid_params("invalid enrichment reset parameters")
    for name in ("tenantId", "expectedAppDir", "expectedDbPath"):
        if not isinstance(params[name], str) or not params[name].strip():
            raise invalid_params(f"{name} must be a nonempty string")
    for name in ("resetAttempts", "onlyFailed"):
        if name in params and not isinstance(params[name], bool):
            raise invalid_params(f"{name} must be boolean")
    targets = params["targets"]
    if not isinstance(targets, list) or not targets:
        raise invalid_params("targets must be a nonempty array")
    resolved = []
    for target in targets:
        if not isinstance(target, dict) or set(target) != {"jobId", "stage"}:
            raise invalid_params("each target requires jobId and stage")
        if target["stage"] not in STAGE_ORDER:
            raise invalid_params("unknown retry stage")
        try:
            job_id = canonical_job_id(target["jobId"])
        except (TypeError, ValueError) as error:
            raise invalid_params("jobId must be a canonical UUID") from error
        resolved.append((str(job_id), target["stage"]))
    assert_expected_runtime(
        expected_app_dir=params["expectedAppDir"], expected_db_path=params["expectedDbPath"],
    )
    try:
        return {"resets": reset_retry_stages(
            get_connection(), resolved, tenant_id=TenantId(params["tenantId"]),
            reset_attempts=params.get("resetAttempts", False),
            only_failed=params.get("onlyFailed", False),
        )}
    except ValueError as error:
        raise invalid_params(str(error)) from error
