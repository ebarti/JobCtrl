"""Local-only, explicit and current-state-bound legacy evidence review."""

from __future__ import annotations

import json
from pathlib import Path

import typer

from jobctrl.infrastructure.profile.legacy_evidence import (
    LegacyEvidenceReviewError, decide_review, evidence_rows, prepare_review, record_legacy_inventory,
)
from jobctrl.infrastructure.profile.legacy_evidence_recovery import inventory_recovery
from jobctrl.source_proposals_cli import connection

app = typer.Typer(help="Review legacy achievement confirmations without inferring authorship.", no_args_is_help=True)


def _run(action, *, readonly=False):
    try:
        with connection(readonly=readonly) as conn:
            result = action(conn)
        typer.echo(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        # Source cells belong only in the deliberate local list output, never logs.
        code = str(error) if isinstance(error, LegacyEvidenceReviewError) else "legacy_evidence_review_failed"
        typer.echo(code, err=True)
        raise typer.Exit(1) from None


@app.command("list")
def list_review():
    """Print exact originals, current cells, conflicts and one-use review tokens locally."""
    _run(lambda conn: {"status": "review_required", "records": prepare_review(conn, tenant_id="local", profile_id="default")}, readonly=True)


@app.command("recover")
def recover(
    paired_backup: Path | None = typer.Option(None, "--paired-backup", help="Native backup directory containing pair.json and both databases."),
    authority_unavailable: bool = typer.Option(False, "--authority-unavailable", help="Record current cells as uncertain when no trustworthy pre-cutover paired backup exists."),
    stopped_runtime: bool = typer.Option(False, "--stopped-runtime", help="Attest all JobCtrl processes using this workspace have been stopped."),
):
    """Inventory retained originals for review; never restore or confirm a field."""
    if not stopped_runtime or bool(paired_backup) == authority_unavailable:
        typer.echo("Use --stopped-runtime and exactly one of --paired-backup or --authority-unavailable.", err=True)
        raise typer.Exit(1)

    def inventory(conn):
        if paired_backup:
            inventory_recovery(conn, paired_backup)
        else:
            conn.execute("BEGIN IMMEDIATE")
            try:
                record_legacy_inventory(conn, evidence_rows(conn), include_unconfirmed=True)
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
        return {"status": "review_required", "records": prepare_review(conn, tenant_id="local", profile_id="default")}

    _run(inventory)


@app.command("decide")
def decide(
    entry_id: str = typer.Option(..., "--entry-id"),
    evidence_id: str = typer.Option(..., "--evidence-id"),
    token: str = typer.Option(..., "--token", help="Exact token from the current local review list."),
    decision: str = typer.Option(..., "--decision", help="confirm or reject the displayed current evidence; no source text is restored."),
    stopped_runtime: bool = typer.Option(False, "--stopped-runtime"),
):
    """Record one explicit human decision, refusing changed state or source conflicts."""
    if not stopped_runtime:
        typer.echo("legacy_evidence_stopped_runtime_required", err=True)
        raise typer.Exit(1)
    _run(lambda conn: {"status": "review_recorded", "eventId": decide_review(
        conn, tenant_id="local", profile_id="default", entry_id=entry_id,
        evidence_id=evidence_id, token=token, decision=decision,
    )})
