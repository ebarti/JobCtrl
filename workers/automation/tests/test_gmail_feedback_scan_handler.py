"""The gmail_feedback_scan sync RPC handler used by the TS API's scan route."""

from __future__ import annotations

from jobctrl.infrastructure.rpc import handlers


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


def test_scan_exceptions_become_ok_false_with_the_real_message(monkeypatch):
    def raising_scan(**_kwargs):
        raise RuntimeError("Gmail auth required: run jobctrl gmail-auth")

    monkeypatch.setattr(
        "jobctrl.infrastructure.gmail.feedback.scan_gmail_feedback", raising_scan
    )
    assert handlers.gmail_feedback_scan({}) == {
        "ok": False,
        "message": "Gmail auth required: run jobctrl gmail-auth",
    }
