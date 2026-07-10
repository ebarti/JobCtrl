from typer.testing import CliRunner

from jobctrl.cli import app


def test_python_pipeline_statistics_command_uses_unambiguous_name() -> None:
    """Native `status` owns lifecycle; Python retains statistics explicitly."""

    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "pipeline-status" in result.output
