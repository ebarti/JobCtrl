"""Owned Python producer for cross-stack private-journal authority verification."""

from __future__ import annotations

import sqlite3
import sys
import json
from pathlib import Path

from jobctrl.infrastructure.migrations.legacy_to_v15_execute import execute_legacy_to_v15_candidate
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema
from jobctrl.infrastructure.profile.legacy_evidence import decide_review, prepare_review, requires_review
from tests.test_legacy_evidence_preservation import seed_evidence


def main() -> None:
    path = Path(sys.argv[1])
    if sys.argv[2] == "create":
        source = path.with_suffix(".v12-source.db")
        with sqlite3.connect(source) as conn:
            create_exact_v12_schema(conn)
            seed_evidence(conn)
            if len(sys.argv) > 3:
                conn.execute("UPDATE candidate_profile_achievement_evidence SET claim_confidence=? WHERE evidence_index=0", (float(sys.argv[3]),))
        execute_legacy_to_v15_candidate(source, path, source_version=12)
    elif sys.argv[2] == "review":
        with sqlite3.connect(path) as conn:
            while items := prepare_review(conn, tenant_id="local", profile_id="default"):
                item = items[0]
                row = item["current"]
                decide_review(conn, tenant_id="local", profile_id="default", entry_id=row["entry_id"],
                              evidence_id=row["evidence_id"], token=item["token"],
                              decision="reject" if row["evidence_id"] == "role_bullet_2" else "confirm")
            print(json.dumps({"requires_review": requires_review(conn, "local", "default", "role", "role_bullet_1"),
                              "unconfirmed_control_requires_review": requires_review(conn, "local", "default", "role", "unconfirmed-control")}))
    else:
        raise ValueError("unknown owned fixture action")


if __name__ == "__main__":
    main()
