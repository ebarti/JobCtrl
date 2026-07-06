"""Apply Automation domain services.

See ddd-target.md §4.6 (Domain Services). Two services live here:

  ``ApplyEligibilityChecker`` — pure function: validates that a job is
                                 ready to apply (URL present, materials
                                 approved, not already applied, within
                                 attempt limits).
  ``ApplyPromptBuilder``      — pure-ish service that assembles the
                                 autonomous-agent prompt + MCP config
                                 into an ``ApplyPrompt`` value object.
                                 Wraps the legacy ``apply/prompt.py``
                                 string-building logic and isolates
                                 the side effects (resume PDF copy,
                                 cover-letter PDF copy) into named
                                 collaborator functions so the use
                                 case can swap them in tests.

The third apply domain service is the ``ApplySaga`` (the apply
process manager from §8.3) — that lives in
``jobhunter.domain.apply.process_manager`` so the lifecycle wiring
stays separable from the eligibility/prompt logic.
"""

from __future__ import annotations

import logging
import sys
import time
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse

from jobhunter.domain.apply.value_objects import ApplyPrompt
from jobhunter.domain.profile.snapshot import ProfileSnapshot

log = logging.getLogger(__name__)


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
            raise ValueError(
                "ApplyEligibilityChecker.max_attempts must be a positive int"
            )
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
        apply_target_url = (
            (job.get("application_url") or "").strip()
            or (job.get("url") or "").strip()
        )
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
    legacy ``jobhunter.apply.prompt.build_prompt`` function (kept
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
        tailored_resume: str,
        snapshot: ProfileSnapshot,
        cdp_port: int,
        dry_run: bool = False,
        cover_letter: str | None = None,
        search_config: Mapping[str, Any] | None = None,
        upload_dir: str | None = None,
    ) -> ApplyPrompt:
        """Render the prompt + MCP config for one job.

        ``tailored_resume`` is the plain-text contents of the
        tailored resume (the .txt sibling of the .pdf). ``snapshot``
        is the ``ProfileSnapshot`` loaded by the launcher once at
        startup. ``cdp_port`` is the worker's CDP port — the MCP
        config wires it into the Playwright server URL.
        """
        # Lazy import to avoid a hard dependency on the legacy module
        # at domain-import time (keeps the service unit-testable
        # without the launcher's atexit + signal side effects).
        from jobhunter.apply import prompt as prompt_mod

        text = prompt_mod.build_prompt(
            job=dict(job),
            tailored_resume=tailored_resume,
            cover_letter=cover_letter,
            dry_run=dry_run,
            snapshot=snapshot,
            search_config=dict(search_config) if search_config is not None else None,
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
    from jobhunter import config as _config

    application_url = str((job or {}).get("application_url") or (job or {}).get("url") or "")
    personal = snapshot.personal if snapshot is not None else {}
    upload_root = str(
        upload_dir
        or (_config.APPLY_WORKER_DIR / "current")
    )
    return {
        "mcpServers": {
            "playwright": {
                "command": "npx",
                "args": [
                    PLAYWRIGHT_MCP_PACKAGE,
                    f"--cdp-endpoint=http://localhost:{cdp_port}",
                    f"--viewport-size={_config.DEFAULTS['viewport']}",
                ],
            },
            "gmail": {
                "command": sys.executable,
                "args": ["-m", "jobhunter.infrastructure.gmail.mcp_server"],
                "env": {
                    "JOBHUNTER_GMAIL_ALLOWED_DOMAINS": ",".join(
                        _verification_sender_domains(application_url)
                    ),
                    "JOBHUNTER_GMAIL_AFTER_MS": str(int(time.time() * 1000)),
                    "JOBHUNTER_GMAIL_TO_EMAIL": str(personal.get("email") or ""),
                    "JOBHUNTER_GMAIL_TOKEN_PATH": str(_config.get_gmail_mcp_credentials_path()),
                    "JOBHUNTER_GMAIL_OAUTH_CLIENT_PATH": str(_config.get_gmail_mcp_oauth_keys_path()),
                },
            },
            "apply_tools": {
                "command": sys.executable,
                "args": ["-m", "jobhunter.infrastructure.apply_tools.mcp_server"],
                "env": {
                    "JOBHUNTER_APPLY_CDP_ENDPOINT": f"http://localhost:{cdp_port}",
                    "JOBHUNTER_APPLY_PROFILE_DB_PATH": str(_config.DB_PATH),
                    "JOBHUNTER_APPLY_UPLOAD_DIR": upload_root,
                },
            },
        },
    }


def _verification_sender_domains(application_url: str) -> tuple[str, ...]:
    try:
        hostname = (urlparse(application_url).hostname or "").lower()
    except Exception:
        hostname = ""
    if not hostname:
        return ()
    labels = hostname.split(".")
    if len(labels) >= 2:
        return (".".join(labels[-2:]),)
    return (hostname,)


__all__ = [
    "ApplyEligibilityChecker",
    "ApplyPromptBuilder",
    "EligibilityResult",
]
