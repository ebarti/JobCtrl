"""Owned CapSolver client behavior."""

from __future__ import annotations

import json

import httpx
import pytest

from jobctl.infrastructure.captcha import CaptchaChallenge, CaptchaSolveError
from jobctl.infrastructure.captcha.capsolver import CapSolverClient


def test_capsolver_success_polls_and_returns_token_without_key_echo() -> None:
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        requests.append(body)
        if request.url.path.endswith("/createTask"):
            return httpx.Response(200, json={"errorId": 0, "taskId": "task-1"})
        assert body == {"clientKey": "capsolver-secret", "taskId": "task-1"}
        return httpx.Response(
            200,
            json={
                "errorId": 0,
                "status": "ready",
                "solution": {"gRecaptchaResponse": "solver-token"},
                "cost": "0.002",
            },
        )

    client = CapSolverClient(
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _seconds: None,
        monotonic=lambda: 10.0,
    )

    result = client.solve(
        api_key="capsolver-secret",
        challenge=CaptchaChallenge(
            kind="recaptcha_v2",
            sitekey="site-key",
            page_url="https://example.com/apply",
        ),
        timeout_seconds=1,
        poll_seconds=0,
    )

    assert result.token == "solver-token"
    assert result.cost_usd == 0.002
    assert requests[0]["clientKey"] == "capsolver-secret"
    assert requests[0]["task"]["websiteKey"] == "site-key"


def test_capsolver_failure_raises_without_returning_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/createTask"):
            return httpx.Response(200, json={"errorId": 0, "taskId": "task-1"})
        return httpx.Response(200, json={"errorId": 0, "status": "failed"})

    client = CapSolverClient(
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _seconds: None,
        monotonic=lambda: 10.0,
    )

    with pytest.raises(CaptchaSolveError, match="failed with status failed"):
        client.solve(
            api_key="capsolver-secret",
            challenge=CaptchaChallenge(
                kind="hcaptcha",
                sitekey="site-key",
                page_url="https://example.com/apply",
            ),
            timeout_seconds=1,
            poll_seconds=0,
        )


def test_capsolver_timeout_raises_after_processing_results() -> None:
    now = 0.0

    def monotonic() -> float:
        return now

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/createTask"):
            return httpx.Response(200, json={"errorId": 0, "taskId": "task-1"})
        return httpx.Response(200, json={"errorId": 0, "status": "processing"})

    client = CapSolverClient(
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=sleep,
        monotonic=monotonic,
    )

    with pytest.raises(CaptchaSolveError, match="timed out"):
        client.solve(
            api_key="capsolver-secret",
            challenge=CaptchaChallenge(
                kind="turnstile",
                sitekey="site-key",
                page_url="https://example.com/apply",
            ),
            timeout_seconds=0.2,
            poll_seconds=0.1,
        )
