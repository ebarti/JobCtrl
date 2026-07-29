"""Apply Automation domain services.

See ddd-target.md §4.6 (Domain Services). Two services live here:

  ``ApplyEligibilityChecker`` — pure function: validates that a job is
                                 ready to apply (URL present, materials
                                 approved, not already applied, within
                                 attempt limits).
  ``ApplyPromptBuilder``      — service that assembles the inspection-agent
                                 prompt + bounded MCP config into an
                                 ``ApplyPrompt`` value object. Wraps the
                                 legacy ``apply/prompt.py`` string-building
                                 logic so the use case can swap it in tests.

The third apply domain service is the ``ApplySaga`` (the apply
process manager from §8.3) — that lives in
``jobctrl.domain.apply.process_manager`` so the lifecycle wiring
stays separable from the eligibility/prompt logic.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Any, Mapping
from urllib.parse import urlparse

from publicsuffix2 import PublicSuffixList

from jobctrl.apply.origins import canonical_http_origin
from jobctrl.domain.apply.value_objects import ApplyPrompt
from jobctrl.domain.profile.snapshot import ProfileSnapshot

log = logging.getLogger(__name__)
_PUBLIC_SUFFIX_LIST = PublicSuffixList()
_TRUSTED_CREDENTIAL_ORIGINS_ENV = (
    "JOBCTRL_TRUSTED_JOB_SITE_CREDENTIAL_ORIGINS"
)


# ---------------------------------------------------------------------------
# ApplyEligibilityChecker
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EligibilityResult:
    """Outcome of one eligibility check.

    ``ok=True`` means the job clears every gate. ``reason`` is set
    only when ``ok=False`` and identifies which invariant was
    violated; the saga uses it to decide between the
    ``Manual`` / ``Failed`` / ``Expired`` terminal variants.
    """

    ok: bool
    reason: str = ""

    @property
    def is_eligible(self) -> bool:
        return self.ok


class ApplyEligibilityChecker:
    """Pure-function service: is this job ready to apply?

    Inputs are the job dict (as returned by
    ``database.get_jobs_by_stage``-style queries with the §7 effective
    column joins applied) plus the prior attempt count. The checker
    enforces:

      * an apply target URL is set (direct application URL, or posting URL),
      * tailored_resume is set (the materials side already wrote a
        ``MaterialsSet`` aggregate),
      * the job has not been ``applied`` already (``apply_status`` /
        ``applied_at`` legacy columns OR a ``succeeded`` ``ApplyRun``
        in the repository — the use case enforces the second clause
        because it has the repository handle),
      * attempts < ``max_attempts``.

    All checks are pure data inspections — no I/O, no DB calls.
    """

    def __init__(self, *, max_attempts: int) -> None:
        if not isinstance(max_attempts, int) or max_attempts <= 0:
            raise ValueError("ApplyEligibilityChecker.max_attempts must be a positive int")
        self._max_attempts = max_attempts

    @property
    def max_attempts(self) -> int:
        return self._max_attempts

    def check(
        self,
        *,
        job: Mapping[str, Any],
        attempts: int = 0,
    ) -> EligibilityResult:
        apply_target_url = (job.get("application_url") or "").strip() or (job.get("url") or "").strip()
        if not apply_target_url:
            return EligibilityResult(ok=False, reason="missing_apply_target_url")

        tailored = (job.get("tailored_resume_path") or "").strip()
        if not tailored:
            return EligibilityResult(ok=False, reason="missing_tailored_resume")

        # Canonical materials rows are only apply-ready after the selected
        # tailored resume also has an approved rendered PDF. Legacy callers
        # may still pass a bare jobs-row dict without these joined fields.
        has_canonical_materials = job.get("materials_generation") is not None
        resume_pdf = (job.get("resume_pdf_path") or "").strip()
        if has_canonical_materials and not resume_pdf:
            return EligibilityResult(ok=False, reason="missing_resume_pdf")

        # Already applied — read both the legacy column AND the
        # canonical ``apply_status`` (so this still works after the
        # legacy column drop).
        if (job.get("applied_at") or "").strip():
            return EligibilityResult(ok=False, reason="already_applied")
        if (job.get("apply_status") or "").strip() == "applied":
            return EligibilityResult(ok=False, reason="already_applied")

        if attempts >= self._max_attempts:
            return EligibilityResult(ok=False, reason="max_attempts_reached")

        return EligibilityResult(ok=True)


# ---------------------------------------------------------------------------
# ApplyPromptBuilder
# ---------------------------------------------------------------------------


class ApplyPromptBuilder:
    """Assemble the ``ApplyPrompt`` value object for one apply run.

    The builder delegates the actual prompt string assembly to the
    legacy ``jobctrl.apply.prompt.build_prompt`` function (kept
    intact under ``apply/prompt.py`` as an adapter helper) and the
    MCP config dict to a small inline factory. Wrapping these in a
    domain service gives the use case one collaborator to swap in
    tests rather than three module-level functions.
    """

    def __init__(self, *, mcp_config_factory: Any | None = None) -> None:
        # Default to the launcher's _make_mcp_config behaviour; tests
        # can pass a fake factory to inspect the rendered config.
        self._mcp_config_factory = mcp_config_factory or _default_mcp_config

    def build(
        self,
        *,
        job: Mapping[str, Any],
        tailored_resume: str = "",
        snapshot: ProfileSnapshot,
        cdp_port: int,
        dry_run: bool = False,
        cover_letter: str | None = None,
        search_config: Mapping[str, Any] | None = None,
        upload_dir: str | None = None,
    ) -> ApplyPrompt:
        """Render the prompt + MCP config for one job.

        ``tailored_resume``, ``cover_letter``, and ``search_config`` remain
        accepted for source compatibility, but are deliberately not forwarded
        across the Apply model boundary. ``snapshot`` is loaded once by the
        launcher and is used only by code-owned artifact/capability setup.
        """
        # Lazy import to avoid a hard dependency on the legacy module
        # at domain-import time (keeps the service unit-testable
        # without the launcher's atexit + signal side effects).
        from jobctrl.apply import prompt as prompt_mod

        text = prompt_mod.build_prompt(
            job=dict(job),
            dry_run=dry_run,
            snapshot=snapshot,
            upload_dir=upload_dir,
        )
        mcp_config = self._build_mcp_config(
            cdp_port,
            job=job,
            snapshot=snapshot,
            upload_dir=upload_dir,
        )
        return ApplyPrompt(text=text, mcp_config=mcp_config)

    def _build_mcp_config(
        self,
        cdp_port: int,
        *,
        job: Mapping[str, Any],
        snapshot: ProfileSnapshot,
        upload_dir: str | None,
    ) -> Mapping[str, Any]:
        try:
            return self._mcp_config_factory(
                cdp_port,
                job=job,
                snapshot=snapshot,
                upload_dir=upload_dir,
            )
        except TypeError:
            return self._mcp_config_factory(cdp_port)


PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.77"


def _default_mcp_config(
    cdp_port: int,
    *,
    job: Mapping[str, Any] | None = None,
    snapshot: ProfileSnapshot | None = None,
    upload_dir: str | None = None,
) -> dict[str, Any]:
    """Default MCP config used when no override is supplied.

    Mirrors the legacy ``apply/launcher._make_mcp_config`` shape so
    the agent connects to the same Playwright server URL the legacy
    launcher used.
    """
    from jobctrl import config as _config
    from jobctrl.runtime import is_bundled_runtime, payload_path

    application_url = str((job or {}).get("application_url") or (job or {}).get("url") or "")
    upload_root = str(upload_dir or (_config.APPLY_WORKER_DIR / "current"))
    apply_tools_env = {
        "JOBCTRL_APPLY_CDP_ENDPOINT": f"http://localhost:{cdp_port}",
        "JOBCTRL_APPLY_APPROVED_APPLICATION_URL": application_url,
        "JOBCTRL_APPLY_UPLOAD_DIR": upload_root,
    }
    captcha_key = os.environ.get("CAPSOLVER_API_KEY", "").strip()
    if captcha_key:
        apply_tools_env["CAPSOLVER_API_KEY"] = captcha_key
    bundled = is_bundled_runtime()
    bundled_env: dict[str, str] = {}
    python_args_prefix: list[str] = []
    if bundled:
        payload_root = str(payload_path(".", require_exists=True))
        bundled_env = {
            "JOBCTRL_DIR": str(_config.APP_DIR),
            "JOBCTRL_PAYLOAD_DIR": payload_root,
            "JOBCTRL_RUNTIME_MODE": "bundled",
            "PYTHONNOUSERSITE": "1",
            "PYTHONSAFEPATH": "1",
        }
        for key in (
            "JOBCTRL_ENV_FILE",
            "JOBCTRL_PROVIDER_PACKS_DIR",
            "PLAYWRIGHT_BROWSERS_PATH",
        ):
            if value := os.environ.get(key, "").strip():
                bundled_env[key] = value
        playwright_command = str(
            payload_path("playwright-mcp/bin/playwright-mcp", require_exists=True)
        )
        playwright_args = [
            f"--cdp-endpoint=http://localhost:{cdp_port}",
            f"--viewport-size={_config.DEFAULTS['viewport']}",
        ]
        # Isolate imports and suppress bytecode writes so MCP children cannot
        # mutate the launcher-verified, signed Python payload.
        python_args_prefix = ["-I", "-B"]
    else:
        playwright_command = "npx"
        playwright_args = [
            PLAYWRIGHT_MCP_PACKAGE,
            f"--cdp-endpoint=http://localhost:{cdp_port}",
            f"--viewport-size={_config.DEFAULTS['viewport']}",
        ]
    apply_tools_env = {**bundled_env, **apply_tools_env}
    return {
        "mcpServers": {
            "playwright": {
                "command": playwright_command,
                "args": playwright_args,
                **({"env": bundled_env} if bundled_env else {}),
            },
            "apply_tools": {
                "command": sys.executable,
                "args": [*python_args_prefix, "-m", "jobctrl.infrastructure.apply_tools.mcp_server"],
                "env": apply_tools_env,
            },
        },
    }


def _verification_sender_domains(application_url: str) -> tuple[str, ...]:
    try:
        hostname = (urlparse(application_url).hostname or "").strip().strip(".").lower()
    except Exception:
        hostname = ""
    if not hostname:
        return ()
    try:
        ip_address(hostname)
    except ValueError:
        pass
    else:
        return ()
    if "." not in hostname:
        return (hostname,)
    registrable_domain = _PUBLIC_SUFFIX_LIST.get_sld(hostname)
    public_suffix = _PUBLIC_SUFFIX_LIST.get_tld(hostname)
    if not registrable_domain or registrable_domain == public_suffix:
        return ()
    return (registrable_domain.lower(),)


def _credential_origins(application_url: str) -> tuple[str, ...]:
    try:
        application_origin = canonical_http_origin(application_url)
    except ValueError:
        return ()

    enrolled: set[str] = set()
    raw = os.environ.get(_TRUSTED_CREDENTIAL_ORIGINS_ENV, "")
    for candidate in raw.split(","):
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            enrolled.add(canonical_http_origin(candidate))
        except ValueError:
            continue
    if application_origin not in enrolled:
        return ()
    return (application_origin,)


__all__ = [
    "ApplyEligibilityChecker",
    "ApplyPromptBuilder",
    "EligibilityResult",
]
