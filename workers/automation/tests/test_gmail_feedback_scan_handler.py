"""The gmail_feedback_scan sync RPC handler used by the TS API's scan route."""

from __future__ import annotations

import httpx
import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.gmail.auth import GmailAuthError
from jobctrl.infrastructure.rpc import handlers
from jobctrl.infrastructure.runtime_identity import RuntimeIdentityMismatch


def test_maps_camel_case_params_and_passes_result_through(monkeypatch):
    captured: dict[str, object] = {}

    def fake_scan(*, db_path, **kwargs):
        captured["db_path"] = str(db_path)
        captured.update(kwargs)
        return {"ok": True, "scannedAnchorCount": 3}

    monkeypatch.setattr(
        "jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback", fake_scan
    )
    result = handlers.gmail_feedback_scan(
        {
            "recipientEmail": "user@example.com",
            "limit": 10,
            "maxResultsPerAnchor": 4,
            "windowDays": 30,
        }
    )
    assert result == {"ok": True, "scannedAnchorCount": 3}
    assert captured["recipient_email"] == "user@example.com"
    assert captured["limit"] == 10
    assert captured["max_results_per_anchor"] == 4
    assert captured["window_days"] == 30


def test_omits_unset_params_so_scan_defaults_apply(monkeypatch):
    captured: dict[str, object] = {}

    def fake_scan(*, db_path, **kwargs):
        captured.update(kwargs)
        return {"ok": True}

    monkeypatch.setattr(
        "jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback", fake_scan
    )
    assert handlers.gmail_feedback_scan({}) == {"ok": True}
    assert captured == {}


def test_auth_failures_pass_through_as_ok_false(monkeypatch):
    monkeypatch.setattr(
        "jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback",
        lambda **_kwargs: {"ok": False, "message": "gmail auth required"},
    )
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False,
        "message": "gmail auth required",
    }


def test_auth_exceptions_become_safe_typed_failures(monkeypatch):
    def raising_scan(**_kwargs):
        raise GmailAuthError("private credential detail")

    monkeypatch.setattr(
        "jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback", raising_scan
    )
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False,
        "status": "unavailable",
        "failureCode": "gmail_auth_required",
    }


def test_unexpected_exceptions_do_not_expose_message_content(monkeypatch):
    def raising_scan(**_kwargs):
        raise RuntimeError("private message body")

    monkeypatch.setattr("jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback", raising_scan)
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False,
        "status": "blocked",
        "failureCode": "gmail_scan_failed",
    }


def test_typed_failures_and_progress_pass_through(monkeypatch):
    monkeypatch.setattr(
        "jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback",
        lambda **_kwargs: {"ok": False, "status": "blocked", "failureCode": "budget_denied", "linkedEvidenceCount": 1},
    )
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False,
        "status": "blocked",
        "failureCode": "budget_denied",
        "linkedEvidenceCount": 1,
    }


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (GmailAuthError("private credential path"), "unavailable", "gmail_auth_required"),
        (httpx.ConnectError("private provider response"), "unavailable", "gmail_transport_error"),
        (DeterminationFailure("provider_unavailable"), "unavailable", "provider_unavailable"),
        (DeterminationFailure("budget_denied"), "unavailable", "budget_denied"),
        (DeterminationFailure("foreign_source_id"), "blocked", "foreign_source_id"),
        (DeterminationFailure("private unknown cause"), "blocked", "determination_failed"),
    ],
)
def test_typed_scan_exceptions_keep_only_safe_codes(monkeypatch, error, status, code):
    def raising_scan(**_kwargs):
        raise error

    monkeypatch.setattr("jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback", raising_scan)
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False, "status": status, "failureCode": code,
    }


def test_runtime_mismatch_is_typed_and_does_not_expose_workspace_paths(monkeypatch):
    def mismatch(**_kwargs):
        raise RuntimeIdentityMismatch("private workspace path")

    monkeypatch.setattr(handlers, "assert_expected_runtime", mismatch)
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False,
        "status": "blocked",
        "failureCode": "runtime_mismatch",
    }
