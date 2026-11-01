"""Versioned codes and display labels, generated from the Contracts authority."""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Literal

from jobctrl.domain.determinations import DeterminationFailure

SEMANTIC_TAXONOMY = json.loads(files("jobctrl").joinpath("assets/determinations/taxonomy.v1.json").read_text())
SEMANTIC_TAXONOMY_VERSION = SEMANTIC_TAXONOMY["schemaVersion"]


def validate_taxonomy_code(
    category: Literal["track", "seniority", "occupationFamily", "workModel", "region"],
    code: str,
) -> str:
    if code not in SEMANTIC_TAXONOMY[category]:
        raise DeterminationFailure("unknown_taxonomy_code")
    return code
