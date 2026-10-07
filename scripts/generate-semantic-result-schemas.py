"""Publish owning determination schemas for strict TS read-side validation."""

import ast
import argparse
import importlib
import json
from pathlib import Path


def generate(*, check=False):
    source_root = Path(__file__).resolve().parents[1] / "workers/automation/src/jobctrl"
    registry = {}
    def register(kind, contract):
        if kind in registry:
            raise ValueError(f"Duplicate determination owner: {kind}")
        registry[kind] = contract

    for path in sorted(source_root.rglob("*.py")):
        tree = ast.parse(path.read_text())
        imports = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                for name in node.names:
                    imports[name.asname or name.name] = (node.module or "") + "." + name.name
            elif isinstance(node, ast.Import):
                for name in node.names:
                    imports[name.asname or name.name.split(".")[0]] = name.name if name.asname else name.name.split(".")[0]

        def qualified(expression):
            if isinstance(expression, ast.Name):
                return imports.get(expression.id, expression.id)
            if isinstance(expression, ast.Attribute):
                return qualified(expression.value) + "." + expression.attr
            return ""

        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and qualified(node.func) == "jobctrl.domain.determinations.determine"
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
            register(resolve(args["kind"]), {
                "schemaVersion": resolve(args["schema_version"]),
                "promptVersion": resolve(args["prompt_version"]),
                "schema": resolve(args["schema"]).model_json_schema(),
            })
    from jobctrl.domain.apply.terminal_report import ApplyTerminalReport, PROMPT_VERSION

    register("apply_terminal_report", {
        "schemaVersion": "1",
        "promptVersion": PROMPT_VERSION,
        "schema": ApplyTerminalReport.model_json_schema(),
    })
    destination = (
        source_root.parents[3] / "packages/contracts/src/semantic-result-schemas.json"
    )
    serialized = json.dumps(registry, indent=2, sort_keys=True) + "\n"
    if check:
        if destination.read_text() != serialized:
            raise SystemExit("Semantic result contracts drifted; regenerate the owning schemas.")
        print("Semantic result contracts match their Python owners.")
    else:
        destination.write_text(serialized)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    generate(check=parser.parse_args().check)
