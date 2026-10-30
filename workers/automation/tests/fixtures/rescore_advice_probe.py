"""Check advice through the registered CLI without starting work or reading credentials."""

from __future__ import annotations

import json
import shlex
import sys
from unittest.mock import patch

from typer.testing import CliRunner

from jobctrl import cli


def verify_advice(commands: list[str]) -> None:
    specs = []
    # Preserve the command tree, direct score handler, and workflow-spec builder.
    # The seam prevents bootstrap, provider readiness, and Temporal dispatch.
    with (
        patch.object(cli, "_bootstrap"),
        patch.object(cli, "_check_tier2_stage"),
        patch.object(cli, "_run_workflow_spec_from_cli", side_effect=lambda spec, *, label: specs.append((spec, label))),
    ):
        for index, command in enumerate(commands):
            argv = shlex.split(command)
            # Do not let an unexpected advice string invoke any other CLI action.
            assert argv == ["jobctrl", "score", "--rescore"], command
            result = CliRunner().invoke(cli.app, argv[1:])
            assert result.exit_code == 0, f"{command}: {result.output} {result.exception}"
            assert len(specs) == index + 1
            spec, label = specs[-1]
            assert label == "score"
            assert spec.args[0].stages == ["score"]
            assert spec.args[0].rescore is True
        assert len(specs) == len(commands)


if __name__ == "__main__":
    verify_advice(json.load(sys.stdin))
    print("rescore advice reached the no-spend workflow seam")
