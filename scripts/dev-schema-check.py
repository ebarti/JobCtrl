#!/usr/bin/env python3
"""Read-only admission for the Python application; never migrate during launch."""

from __future__ import annotations

import sqlite3
import os
import stat
import struct
import sys
from pathlib import Path

APPLICATION_ID = 0x4A435354
SCHEMA_VERSION = 1


def main() -> int:
    path = Path(sys.argv[1]).absolute()
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        print("compatible")
        return 0
    except OSError:
        print("unknown")
        return 0
    if not stat.S_ISREG(metadata.st_mode):
        print("incompatible")
        return 0
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            identity = os.fstat(descriptor)
            header = os.read(descriptor, 100)
        finally:
            os.close(descriptor)
        if (not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1
                or (os.name != "nt" and (identity.st_uid != os.getuid() or identity.st_mode & 0o077))
                or len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                or struct.unpack(">I", header[68:72])[0] != APPLICATION_ID):
            print("incompatible")
            return 0
        conn = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)
        try:
            application_id = conn.execute("PRAGMA application_id").fetchone()[0]
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if (application_id, version) != (APPLICATION_ID, SCHEMA_VERSION):
                print("incompatible")
                return 0
            metadata = dict(conn.execute("SELECT key,value FROM app_metadata"))
            compatible = metadata == {"application": "jobctrl-python", "schema_version": "1"}
        finally:
            conn.close()
    except (OSError, sqlite3.Error):
        # An inaccessible probe does not authorize runtime replacement or mutation.
        print("unknown")
        return 0
    print("compatible" if compatible else "incompatible")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
