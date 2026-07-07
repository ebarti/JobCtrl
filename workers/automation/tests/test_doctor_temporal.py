from unittest.mock import AsyncMock, patch

from typer.testing import CliRunner

from jobctrl.cli import app


def test_doctor_reports_temporal_reachable():
    sentinel = object()
    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(return_value=sentinel),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Temporal" in result.output
    assert "reachable" in result.output


def test_doctor_reports_temporal_unreachable():
    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Temporal" in result.output
    assert "unreachable" in result.output
    # Rich may soft-wrap the hint; collapse whitespace before asserting.
    assert "temporal server start-dev" in " ".join(result.output.split())
