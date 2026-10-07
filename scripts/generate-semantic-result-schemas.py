"""Publish owning determination schemas for strict TS read-side validation."""

import ast
import importlib
import json
from pathlib import Path


def generate():
    source_root = Path(__file__).resolve().parents[1] / "workers/automation/src/jobctrl"
    registry = {}
    for path in sorted(source_root.rglob("*.py")):
        tree = ast.parse(path.read_text())
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "determine"
        ]
        if not calls:
            continue
        module = importlib.import_module(
            "jobctrl." + ".".join(path.relative_to(source_root).with_suffix("").parts)
        )

        def resolve(expression):
            if isinstance(expression, ast.Constant):
                return expression.value
            if isinstance(expression, ast.Name):
                return getattr(module, expression.id)
            raise ValueError(
                "Determination contract must use a literal or owning module constant"
            )

        for call in calls:
            args = {item.arg: item.value for item in call.keywords}
            registry[resolve(args["kind"])] = {
                "schemaVersion": resolve(args["schema_version"]),
                "promptVersion": resolve(args["prompt_version"]),
                "schema": resolve(args["schema"]).model_json_schema(),
            }
    from jobctrl.domain.apply.terminal_report import ApplyTerminalReport, PROMPT_VERSION

    registry["apply_terminal_report"] = {
        "schemaVersion": "1",
        "promptVersion": PROMPT_VERSION,
        "schema": ApplyTerminalReport.model_json_schema(),
    }
    destination = (
        source_root.parents[3] / "packages/contracts/src/semantic-result-schemas.json"
    )
    destination.write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    generate()
