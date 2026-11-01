#!/usr/bin/env python3
"""Read-only source startup check; actual schema admission stays in the API/worker."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "workers" / "automation" / "src"))

from jobctrl.infrastructure.migrations.schema_manifest import (  # noqa: E402
    EXACT_V15_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
)


def main() -> int:
    path = Path(sys.argv[1]).absolute()
    if not path.exists():
        print("compatible")  # The worker owns first initialization.
        return 0
    try:
        conn = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)
        try:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version != EXACT_V15_MANIFEST.version:
                print("incompatible")
                return 0
            try:
                assert_exact_manifest(conn, EXACT_V15_MANIFEST)
            except SchemaManifestError:
                print("incompatible")
                return 0
        finally:
            conn.close()
    except (OSError, sqlite3.Error):
        # A failed probe is not evidence of a schema mismatch. The normal
        # process startup reports the underlying failure instead.
        print("unknown")
        return 0
    print("compatible")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
