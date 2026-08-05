"""SQLite expressions for the shared score eligibility policy."""

from __future__ import annotations

import json
import sqlite3

from jobctrl.domain.scoring.eligibility import eligibility_blocks_downstream
from jobctrl.domain.scoring.value_objects import EligibilityAssessment

_SQL_FUNCTION = "score_eligible_for_downstream"


def score_eligible_for_downstream_sql(json_expr: str) -> str:
    """Return SQL that excludes actionable blockers but permits salary advice.

    A blocked status with no blocker evidence remains blocked. A blocked status
    backed only by compensation reasons is eligible because those reasons are
    advisory under the shared domain policy.
    """

    return f"{_SQL_FUNCTION}({json_expr}) = 1"


def register_score_eligibility_sql(conn: sqlite3.Connection) -> None:
    """Register the deterministic SQLite adapter for the domain policy."""

    conn.create_function(
        _SQL_FUNCTION,
        1,
        _score_eligible_for_downstream,
        deterministic=True,
    )


def _score_eligible_for_downstream(raw_breakdown: object) -> int:
    try:
        payload = json.loads(str(raw_breakdown or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        payload = {}
    eligibility_payload = payload.get("eligibility") if isinstance(payload, dict) else None
    eligibility = EligibilityAssessment.from_dict(
        eligibility_payload if isinstance(eligibility_payload, dict) else None
    )
    return int(not eligibility_blocks_downstream(eligibility))
