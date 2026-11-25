"""Source CLI archive of the verified workspace and its durable queue."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from psycopg import Error as PsycopgError
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from sqlalchemy.exc import SQLAlchemyError

from jobctrl.app.database import Database
from jobctrl.app.errors import AppError


def _tool(name: str) -> str:
    configured = os.environ.get("JOBCTRL_POSTGRES_BIN_DIR")
    candidate = str(Path(configured).expanduser().absolute() / name) if configured else name
    found = shutil.which(candidate)
    if found is None:
        raise AppError("postgres_tools_missing", f"Install PostgreSQL tools or set JOBCTRL_POSTGRES_BIN_DIR to the directory containing {name}.")
    return found


def _dump_connection(database: Database, temporary: Path) -> tuple[str, dict[str, str]]:
    parameters = conninfo_to_dict(database.libpq_url)
    password = parameters.pop("password", None)
    environment = {key: os.environ[key] for key in ("HOME", "PATH", "PGUSER", "PGPASSFILE", "PGPORT") if key in os.environ}
    environment["LC_ALL"] = "C"
    if password is not None:
        if "\n" in password or "\r" in password:
            raise AppError("invalid_database_url", "The PostgreSQL password cannot be used in the backup connection.")
        passfile = temporary / "pgpass"
        escaped = password.replace("\\", "\\\\").replace(":", "\\:")
        descriptor = os.open(passfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(f"*:*:*:*:{escaped}\n")
        environment["PGPASSFILE"] = str(passfile)
    return make_conninfo(**parameters), environment


def backup_workspace(workspace: Path, output: Path | None) -> dict:
    if Database.probe(workspace) is None:
        raise AppError("database_missing", "Choose an existing PostgreSQL workspace database.")
    pg_dump, pg_restore = _tool("pg_dump"), _tool("pg_restore")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"jobctrl-{timestamp}.pgdump"
    destination = (output or workspace / "backups" / filename).expanduser().absolute()
    if destination.is_dir():
        destination /= filename
    if os.path.lexists(destination):
        raise AppError("output_exists", "The backup destination already exists. Choose a new path.")
    database = Database.open_existing(workspace)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".jobctrl-backup-", dir=destination.parent) as directory:
            temporary = Path(directory)
            archive = temporary / "workspace.pgdump"
            conninfo, environment = _dump_connection(database, temporary)
            # pg_dump must use this exact workspace's verified snapshot. A
            # replaced cluster or different database cannot import its token.
            with database.connect() as connection:
                snapshot = connection.execute("SELECT pg_export_snapshot()").fetchone()[0]
                subprocess.run(
                    [pg_dump, "--no-password", "--format=custom", "--lock-wait-timeout=10s",
                     "--snapshot", snapshot, "--dbname", conninfo, "--file", str(archive)],
                    env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, check=True,
                )
            subprocess.run(
                [pg_restore, "--list", str(archive)], env=environment, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
            )
            archive.chmod(0o600)
            with archive.open("rb") as stream:
                os.fsync(stream.fileno())
            os.link(archive, destination)
        return {"backedUp": True, "path": str(destination), "bytes": destination.stat().st_size}
    except FileExistsError:
        raise AppError("output_exists", "The backup destination already exists. Choose a new path.") from None
    except (OSError, PsycopgError, subprocess.SubprocessError, SQLAlchemyError):
        raise AppError("backup_failed", "The PostgreSQL archive could not be created.") from None
    finally:
        database.close()
