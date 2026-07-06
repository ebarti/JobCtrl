"""CapSolver client for the owned apply CAPTCHA tool."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx


@dataclass(frozen=True)
class CaptchaChallenge:
    kind: str
    sitekey: str
    page_url: str


@dataclass(frozen=True)
class CaptchaSolveResult:
    token: str
    kind: str
    elapsed_s: float
    cost_usd: float | None = None


class CaptchaSolveError(RuntimeError):
    """Raised when the configured CAPTCHA provider cannot return a token."""


class CapSolverClient:
    def __init__(
        self,
        *,
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = http or httpx.Client(timeout=10)
        self._sleep = sleep
        self._monotonic = monotonic

    def solve(
        self,
        *,
        api_key: str,
        challenge: CaptchaChallenge,
        timeout_seconds: float = 120.0,
        poll_seconds: float = 3.0,
    ) -> CaptchaSolveResult:
        task_type = _task_type(challenge.kind)
        start = self._monotonic()
        create = self._post(
            "https://api.capsolver.com/createTask",
            {
                "clientKey": api_key,
                "task": {
                    "type": task_type,
                    "websiteURL": challenge.page_url,
                    "websiteKey": challenge.sitekey,
                },
            },
        )
        task_id = create.get("taskId")
        if not task_id:
            raise CaptchaSolveError("CAPTCHA solver did not return a task id")

        deadline = start + timeout_seconds
        while self._monotonic() < deadline:
            self._sleep(poll_seconds)
            result = self._post(
                "https://api.capsolver.com/getTaskResult",
                {"clientKey": api_key, "taskId": task_id},
            )
            status = str(result.get("status") or "")
            if status == "ready":
                token = _solution_token(result.get("solution"))
                if not token:
                    raise CaptchaSolveError("CAPTCHA solver returned an empty solution")
                return CaptchaSolveResult(
                    token=token,
                    kind=challenge.kind,
                    elapsed_s=round(self._monotonic() - start, 3),
                    cost_usd=_cost_usd(result),
                )
            if status and status != "processing":
                raise CaptchaSolveError(f"CAPTCHA solver failed with status {status}")
        raise CaptchaSolveError("CAPTCHA solver timed out")

    def _post(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._http.post(url, json=payload)
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPError as exc:
            raise CaptchaSolveError("CAPTCHA solver request failed") from exc
        except ValueError as exc:
            raise CaptchaSolveError("CAPTCHA solver returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise CaptchaSolveError("CAPTCHA solver returned an invalid response")
        if data.get("errorId"):
            raise CaptchaSolveError(str(data.get("errorDescription") or "CAPTCHA solver error"))
        return data


def solve_with_capsolver(api_key: str, challenge: CaptchaChallenge) -> CaptchaSolveResult:
    timeout_seconds = float(_env("JOBHUNTER_CAPTCHA_TIMEOUT_SECONDS", "120"))
    poll_seconds = float(_env("JOBHUNTER_CAPTCHA_POLL_SECONDS", "3"))
    return CapSolverClient().solve(
        api_key=api_key,
        challenge=challenge,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
    )


def _task_type(kind: str) -> str:
    task_type = {
        "recaptcha_v2": "ReCaptchaV2TaskProxyLess",
        "hcaptcha": "HCaptchaTaskProxyLess",
        "turnstile": "AntiTurnstileTaskProxyLess",
    }.get(kind)
    if not task_type:
        raise CaptchaSolveError(f"unsupported CAPTCHA kind: {kind}")
    return task_type


def _solution_token(solution: Any) -> str:
    if not isinstance(solution, dict):
        return ""
    token = (
        solution.get("gRecaptchaResponse")
        or solution.get("token")
        or solution.get("captchaKey")
    )
    return str(token) if token else ""


def _cost_usd(result: dict[str, Any]) -> float | None:
    raw = result.get("cost") or result.get("costUsd") or result.get("cost_usd")
    if raw in {None, ""}:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _env(key: str, default: str) -> str:
    import os

    return os.environ.get(key, default)
