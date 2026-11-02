"""Synchronous, runtime-bound adapters to the stage retry service."""

from jobctrl.database import get_connection
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.rpc.server import invalid_params
from jobctrl.infrastructure.runtime_identity import assert_expected_runtime
from jobctrl.pipeline.retry import ApplyResetRefused, RetrySelectionChanged, reset_retry_stages
from jobctrl.state import STAGE_ORDER


def reset_enrichment(params):
    result = _reset_stages(params, require_enrichment=True)
    # Older API clients validate this compatibility response strictly.
    return {"resets": [
        {key: value for key, value in reset.items() if key in {"jobId", "jobUrl", "stage"}}
        for reset in result["resets"]
    ]}


def reset_stages(params):
    return _reset_stages(params, require_enrichment=False)


def _reset_stages(params, *, require_enrichment):
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
    expected_fingerprints = {}
    for target in targets:
        if not isinstance(target, dict) or not {"jobId", "stage"} <= target.keys() or (
            target.keys() - {"jobId", "stage", "expectedFingerprint"}
        ):
            raise invalid_params("each target requires jobId and stage")
        if target["stage"] not in STAGE_ORDER:
            raise invalid_params("unknown retry stage")
        try:
            job_id = canonical_job_id(target["jobId"])
        except (TypeError, ValueError) as error:
            raise invalid_params("jobId must be a canonical UUID") from error
        fingerprint = target.get("expectedFingerprint")
        if "expectedFingerprint" in target and (
            not isinstance(fingerprint, str) or len(fingerprint) != 64
            or any(char not in "0123456789abcdef" for char in fingerprint)
        ):
            raise invalid_params("expectedFingerprint must be a lowercase SHA-256 digest")
        if (params.get("onlyFailed", False) or not require_enrichment) and fingerprint is None:
            raise invalid_params("retry selection lacks an ownership snapshot; update the client, refresh and retry")
        if fingerprint is not None:
            key = (str(job_id), target["stage"])
            if key in expected_fingerprints and expected_fingerprints[key] != fingerprint:
                raise invalid_params("duplicate retry targets have conflicting identities")
            expected_fingerprints[key] = fingerprint
        resolved.append((str(job_id), target["stage"]))
    if expected_fingerprints and len(expected_fingerprints) != len(set(resolved)):
        raise invalid_params("each retry target requires an observed identity")
    if require_enrichment and not any(stage == "enrich" for _, stage in resolved):
        raise invalid_params("an enrichment target is required")
    assert_expected_runtime(
        expected_app_dir=params["expectedAppDir"], expected_db_path=params["expectedDbPath"],
    )
    try:
        return {"resets": reset_retry_stages(
            get_connection(), resolved, tenant_id=TenantId(params["tenantId"]),
            reset_attempts=params.get("resetAttempts", False),
            only_failed=params.get("onlyFailed", False),
            expected_fingerprints=expected_fingerprints or None,
            # The current bulk API selects one first retryable failure per job.
            # The legacy alias also supports explicitly bound multi-stage cohorts.
            require_selected_failed_stage=not require_enrichment,
        )}
    except RetrySelectionChanged as error:
        # Older adapters only understand INVALID_PARAMS and its message.
        data = None if require_enrichment else {"reason": "retry_selection_changed"}
        raise invalid_params(str(error), data=data) from error
    except ApplyResetRefused as error:
        data = None if require_enrichment else {"reason": "apply_reset_refused"}
        raise invalid_params(str(error), data=data) from error
    except ValueError as error:
        raise invalid_params(str(error)) from error
