"""Explicit source-history proposal commands; list uses a read-only connection."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

import typer
from jobctrl.infrastructure.migrations.schema_manifest import SchemaManifestError
from jobctrl.database import UnresolvedDatabaseInitializationError

app = typer.Typer(help="Propose sources from saved posting history for explicit review.", no_args_is_help=True)


@contextmanager
def connection(*, readonly: bool = False):
    from jobctrl import config
    from jobctrl.database import SCHEMA_VERSION, EXACT_V14_MANIFEST, _refuse_unresolved_initialization, assert_exact_manifest

    config.load_env()
    _refuse_unresolved_initialization(config.DB_PATH)
    mode = "ro" if readonly else "rw"
    conn = sqlite3.connect(config.DB_PATH.resolve().as_uri() + f"?mode={mode}", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        if conn.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
            raise ValueError("Source proposals require the current migrated database.")
        assert_exact_manifest(conn, EXACT_V14_MANIFEST)
        with conn:
            yield conn
    finally:
        conn.close()


def run(action, *, readonly: bool = False):
    try:
        with connection(readonly=readonly) as conn:
            result = action(conn)
        typer.echo(json.dumps(result, ensure_ascii=False))
    except (ValueError, sqlite3.Error, SchemaManifestError, UnresolvedDatabaseInitializationError) as exc:
        typer.echo(f"Source proposal command failed: {exc}", err=True)
        raise typer.Exit(1) from exc


@app.command("from-history")
def from_history(
    job_id: str | None = typer.Option(None, "--job-id", help="Propose only from one canonical saved JobId."),
):
    """Opt into source proposals from saved canonical URLs; never fetch or enable."""
    from jobctrl.infrastructure.discovery.posting_source_proposals import propose_from_history

    run(lambda conn: propose_from_history(conn, job_id=job_id))


@app.command("list")
def list_saved():
    """Read candidates, origin receipts and durable review history as JSON."""
    from jobctrl.infrastructure.discovery.posting_source_proposals import list_proposals

    run(list_proposals, readonly=True)


@app.command("reset")
def reset(candidate_id: str = typer.Argument(...)):
    """Explicitly allow a rejected coordinate to be proposed again; never enable it."""
    from jobctrl.infrastructure.discovery.posting_source_proposals import reset_suppression

    run(lambda conn: reset_suppression(conn, candidate_id))
