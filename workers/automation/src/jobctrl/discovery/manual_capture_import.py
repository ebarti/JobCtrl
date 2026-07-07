"""CLI bridge for importing a queued manual capture through worker code."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.discovery.production_wiring import (
    ManualCaptureImport,
    import_manual_capture_item,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", required=True, help="Path to the JobCtrl SQLite database.")
    args = parser.parse_args(argv)

    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("manual capture payload must be a JSON object")
        db_path = Path(args.db_path)
        conn = init_db(db_path)
        try:
            outcome = import_manual_capture_item(
                conn,
                ManualCaptureImport(
                    item_id=_text(payload, "itemId"),
                    capture_mode=_text(payload, "captureMode"),
                    content_text=_optional_text(payload, "contentText"),
                    content_html_base64=_optional_text(payload, "contentHtmlBase64"),
                    captured_url=_optional_text(payload, "capturedUrl"),
                    note=_optional_text(payload, "note"),
                    future_manual_action_required=bool(
                        payload.get("futureManualActionRequired")
                    ),
                ),
            )
            row = conn.execute(
                """
                SELECT imported_at, retry_context_json
                FROM manual_capture_queue
                WHERE item_id = ?
                """,
                (outcome.item_id,),
            ).fetchone()
            print(
                json.dumps(
                    {
                        "ok": True,
                        "itemId": outcome.item_id,
                        "jobId": outcome.job_id,
                        "snapshotVersion": outcome.snapshot_version,
                        "promotedToJobEnrichment": outcome.promoted_to_job_enrichment,
                        "quarantineReason": outcome.quarantine_reason,
                        "importedAt": row["imported_at"] if row else None,
                        "retryContext": _json_dict(row["retry_context_json"] if row else None),
                    },
                    sort_keys=True,
                )
            )
            return 0
        finally:
            close_connection(db_path)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2


def _text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _optional_text(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value


def _json_dict(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


if __name__ == "__main__":
    raise SystemExit(main())
