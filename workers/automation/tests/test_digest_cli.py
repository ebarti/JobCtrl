from __future__ import annotations

import json

from typer.testing import CliRunner

from jobhunter import cli, digest as digest_module
from jobhunter.cli import app
from jobhunter.infrastructure.scoring import criteria_provider


def _sample_digest() -> dict:
    return {
        "ok": True,
        "generatedAt": "2026-07-05T12:00:00.000Z",
        "since": "2026-07-01T00:00:00.000Z",
        "highFitThreshold": 7,
        "newMatches": {"count": 4, "highFitCount": 2},
        "blockedSources": {
            "count": 1,
            "sources": [
                {
                    "sourceId": "linkedin",
                    "recommendedState": "quarantined",
                    "consecutiveFailures": 3,
                }
            ],
        },
        "reviewNeededMaterials": {"count": 3},
        "staleScores": {"count": 1},
        "pendingApprovals": {"count": 2},
        "followUpsDue": {
            "count": 1,
            "derived": True,
            "thresholdDays": 7,
            "dayBoundary": "UTC",
        },
        "budget": {
            "status": "ok",
            "estimatedUsd": 8.5,
            "dailyBudgetUsd": 25,
            "remainingUsd": 16.5,
            "unlimited": False,
        },
        "deepLinks": {
            "newMatches": "/jobs?discoveredSince=2026-07-01T00%3A00%3A00.000Z",
            "blockedSources": "/discovery",
            "reviewNeededMaterials": "/apply-review",
            "staleScores": "/jobs?state=stale",
            "pendingApprovals": "/apply-review",
            "followUpsDue": "/jobs?applyStatus=applied",
            "budget": "/settings",
        },
    }


def test_digest_cli_prints_read_only_summary(monkeypatch) -> None:
    build_calls: list[int] = []
    acknowledge_calls: list[str] = []

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr("jobhunter.database.get_connection", lambda: object())
    monkeypatch.setattr(criteria_provider, "read_min_fit_score", lambda: 7)
    monkeypatch.setattr(
        digest_module,
        "build_digest",
        lambda conn, *, min_fit_score: build_calls.append(min_fit_score) or _sample_digest(),
    )
    monkeypatch.setattr(
        digest_module,
        "acknowledge_digest",
        lambda conn, *, acknowledged_at: acknowledge_calls.append(acknowledged_at),
    )

    result = CliRunner().invoke(app, ["digest"])

    assert result.exit_code == 0, result.output
    assert build_calls == [7]
    assert acknowledge_calls == []
    assert "Daily digest" in result.output
    assert "New matches" in result.output
    assert "Run with --acknowledge" in result.output


def test_digest_cli_json_acknowledges_generated_digest(monkeypatch) -> None:
    acknowledge_calls: list[str] = []

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr("jobhunter.database.get_connection", lambda: object())
    monkeypatch.setattr(criteria_provider, "read_min_fit_score", lambda: 7)
    monkeypatch.setattr(
        digest_module,
        "build_digest",
        lambda conn, *, min_fit_score: _sample_digest(),
    )

    def acknowledge(conn, *, acknowledged_at: str) -> dict:
        acknowledge_calls.append(acknowledged_at)
        return {
            "ok": True,
            "state": {
                "lastAcknowledgedAt": acknowledged_at,
                "updatedAt": acknowledged_at,
            },
        }

    monkeypatch.setattr(digest_module, "acknowledge_digest", acknowledge)

    result = CliRunner().invoke(app, ["digest", "--acknowledge", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert acknowledge_calls == ["2026-07-05T12:00:00.000Z"]
    assert payload["digest"]["newMatches"]["count"] == 4
    assert payload["acknowledge"]["state"]["lastAcknowledgedAt"] == "2026-07-05T12:00:00.000Z"


def test_digest_cli_allows_one_off_threshold_override(monkeypatch) -> None:
    build_calls: list[int] = []

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr("jobhunter.database.get_connection", lambda: object())
    monkeypatch.setattr(criteria_provider, "read_min_fit_score", lambda: 3)
    monkeypatch.setattr(
        digest_module,
        "build_digest",
        lambda conn, *, min_fit_score: build_calls.append(min_fit_score) or _sample_digest(),
    )

    result = CliRunner().invoke(app, ["digest", "--min-fit-score", "9", "--json"])

    assert result.exit_code == 0, result.output
    assert build_calls == [9]
