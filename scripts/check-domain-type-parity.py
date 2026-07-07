#!/usr/bin/env python3
"""Verify TS and Python domain type/event names + field sets match.

This is the two-language drift sensor described in docs/architecture/domain-model/reference.md §10 and
migration plan S-03. It compares:

  1. Event type names across both languages.
  2. Payload field names for each event type.
  3. Stage and StageState variant names.

Exit code 0 = parity OK; exit code 1 = drift detected.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

TS_EVENTS_DIR = REPO_ROOT / "packages" / "domain-types" / "src" / "events"
PY_EVENTS_DIR = REPO_ROOT / "workers" / "automation" / "src" / "jobctrl" / "domain" / "events"

TS_PIPELINE = REPO_ROOT / "packages" / "domain-types" / "src" / "pipeline.ts"
PY_PIPELINE = REPO_ROOT / "workers" / "automation" / "src" / "jobctrl" / "domain" / "pipeline_types.py"

# Files that contain bounded-context events (exclude base and index)
EVENT_MODULES = ["discovery", "enrichment", "scoring", "materials", "apply", "orchestration", "profile"]

errors: list[str] = []


# ---------------------------------------------------------------------------
# TS extraction helpers
# ---------------------------------------------------------------------------


def extract_ts_event_types(filepath: Path) -> dict[str, set[str]]:
    """Extract event type names and their payload field names from a TS file.

    Looks for patterns like:
      export interface FooPayload { ... }
      export type Foo = DomainEvent<"Foo", FooPayload>;
    """
    text = filepath.read_text()
    events: dict[str, set[str]] = {}

    # Find all payload interfaces
    payload_pattern = re.compile(
        r"export\s+interface\s+(\w+Payload)\s*\{([^}]*)\}",
        re.DOTALL,
    )
    payloads: dict[str, set[str]] = {}
    for m in payload_pattern.finditer(text):
        name = m.group(1)
        body = m.group(2)
        fields = set()
        for line in body.strip().splitlines():
            line = line.strip()
            if line.startswith("readonly "):
                field_name = line.split("readonly ")[1].split(":")[0].split("?")[0].strip()
                fields.add(field_name)
        payloads[name] = fields

    # Find all event type aliases: type Foo = DomainEvent<"Foo", FooPayload>;
    type_pattern = re.compile(
        r'export\s+type\s+(\w+)\s*=\s*DomainEvent<"(\w+)"',
    )
    for m in type_pattern.finditer(text):
        event_name = m.group(2)
        payload_name = event_name + "Payload"
        if payload_name in payloads:
            events[event_name] = payloads[payload_name]
        else:
            events[event_name] = set()

    return events


def extract_ts_stages(filepath: Path) -> list[str]:
    """Extract Stage literal values from pipeline.ts."""
    text = filepath.read_text()
    m = re.search(r"export const STAGES\s*=\s*\[(.*?)\]\s*as\s*const", text, re.DOTALL)
    if not m:
        return []
    return re.findall(r'"(\w+)"', m.group(1))


def extract_ts_stage_state_kinds(filepath: Path) -> list[str]:
    """Extract StageState kind values from pipeline.ts."""
    text = filepath.read_text()
    m = re.search(r"export const STAGE_STATE_KINDS\s*=\s*\[(.*?)\]\s*as\s*const", text, re.DOTALL)
    if not m:
        return []
    return re.findall(r'"(\w+)"', m.group(1))


# ---------------------------------------------------------------------------
# Python extraction helpers
# ---------------------------------------------------------------------------


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case for field name comparison."""
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def extract_py_event_types(filepath: Path) -> dict[str, set[str]]:
    """Extract event type names and payload field names from a Python file.

    Looks for frozen dataclass classes ending in Payload, and factory
    functions named create_xxx that produce DomainEvent with a specific type.
    """
    text = filepath.read_text()
    tree = ast.parse(text)
    events: dict[str, set[str]] = {}
    payloads: dict[str, set[str]] = {}

    for node in ast.walk(tree):
        # Find payload dataclasses
        if isinstance(node, ast.ClassDef) and node.name.endswith("Payload"):
            fields = set()
            for item in node.body:
                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                    fields.add(item.target.id)
            payloads[node.name] = fields

        # Find factory functions: create_domain_event("EventType", ...)
        if isinstance(node, ast.FunctionDef) and node.name.startswith("create_"):
            for subnode in ast.walk(node):
                if (
                    isinstance(subnode, ast.Call)
                    and isinstance(subnode.func, ast.Name)
                    and subnode.func.id == "create_domain_event"
                    and subnode.args
                    and isinstance(subnode.args[0], ast.Constant)
                ):
                    event_name = subnode.args[0].value
                    payload_name = event_name + "Payload"
                    if payload_name in payloads:
                        events[event_name] = payloads[payload_name]
                    else:
                        events[event_name] = set()

    return events


def extract_py_stages(filepath: Path) -> list[str]:
    """Extract Stage enum member names from pipeline.py."""
    text = filepath.read_text()
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "Stage":
            members = []
            for item in node.body:
                if isinstance(item, ast.Assign):
                    for target in item.targets:
                        if isinstance(target, ast.Name):
                            members.append(target.id)
            return members
    return []


def extract_py_stage_state_kinds(filepath: Path) -> list[str]:
    """Extract STAGE_STATE_KINDS tuple values from pipeline.py."""
    text = filepath.read_text()
    tree = ast.parse(text)
    for node in ast.walk(tree):
        # Handle both `x = (...)` and `x: type = (...)`
        target_name: str | None = None
        value: ast.expr | None = None
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "STAGE_STATE_KINDS":
                    target_name = target.id
                    value = node.value
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id == "STAGE_STATE_KINDS":
                target_name = node.target.id
                value = node.value

        if target_name and isinstance(value, ast.Tuple):
            return [
                elt.value
                for elt in value.elts
                if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
            ]
    return []


# ---------------------------------------------------------------------------
# Parity checks
# ---------------------------------------------------------------------------


def check_events() -> None:
    """Compare TS and Python event type names and payload fields."""
    ts_all_events: dict[str, set[str]] = {}
    py_all_events: dict[str, set[str]] = {}

    for module in EVENT_MODULES:
        ts_file = TS_EVENTS_DIR / f"{module}.ts"
        py_file = PY_EVENTS_DIR / f"{module}.py"

        if not ts_file.exists():
            errors.append(f"Missing TS event module: {ts_file}")
            continue
        if not py_file.exists():
            errors.append(f"Missing Python event module: {py_file}")
            continue

        ts_events = extract_ts_event_types(ts_file)
        py_events = extract_py_event_types(py_file)

        ts_all_events.update(ts_events)
        py_all_events.update(py_events)

        # Check event names within same module
        ts_names = set(ts_events.keys())
        py_names = set(py_events.keys())

        only_ts = ts_names - py_names
        only_py = py_names - ts_names

        if only_ts:
            errors.append(f"[{module}] Events only in TS: {sorted(only_ts)}")
        if only_py:
            errors.append(f"[{module}] Events only in Python: {sorted(only_py)}")

        # Check payload fields for shared events
        for event_name in ts_names & py_names:
            ts_fields = ts_events[event_name]
            py_fields = py_events[event_name]

            # Convert TS camelCase field names to snake_case for comparison
            ts_fields_snake = {_camel_to_snake(f) for f in ts_fields}

            only_ts_fields = ts_fields_snake - py_fields
            only_py_fields = py_fields - ts_fields_snake

            if only_ts_fields:
                errors.append(
                    f"[{module}/{event_name}] Payload fields only in TS (as snake_case): {sorted(only_ts_fields)}"
                )
            if only_py_fields:
                errors.append(
                    f"[{module}/{event_name}] Payload fields only in Python: {sorted(only_py_fields)}"
                )


def check_stages() -> None:
    """Compare TS and Python Stage values."""
    ts_stages = extract_ts_stages(TS_PIPELINE)
    py_stages = extract_py_stages(PY_PIPELINE)

    if ts_stages != py_stages:
        errors.append(f"Stage mismatch — TS: {ts_stages}, Python: {py_stages}")


def check_stage_state_kinds() -> None:
    """Compare TS and Python StageState kind values."""
    ts_kinds = extract_ts_stage_state_kinds(TS_PIPELINE)
    py_kinds = extract_py_stage_state_kinds(PY_PIPELINE)

    if ts_kinds != py_kinds:
        errors.append(f"StageState kinds mismatch — TS: {ts_kinds}, Python: {py_kinds}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    check_events()
    check_stages()
    check_stage_state_kinds()

    if errors:
        print("DOMAIN TYPE PARITY CHECK FAILED", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        for err in errors:
            print(f"  ✘ {err}", file=sys.stderr)
        print(f"\n{len(errors)} error(s) found.", file=sys.stderr)
        return 1

    print("✓ Domain type parity check passed — TS and Python types are in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
