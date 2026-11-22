"""Explicit source-bound legacy evidence review through the Profile owner."""

from __future__ import annotations

from pathlib import Path

import typer

app = typer.Typer(help="Review retained historic evidence without inferring authorship.", no_args_is_help=True)


def _request_json(method, path, payload=None):
    from jobctrl.cli import _output, _request, _run

    _output(_run(_request(method, path, payload)).json())


@app.command("list")
def list_review():
    """Print exact retained originals, current text, conflicts and review tokens."""
    _request_json("GET", "/v1/profile/legacy-evidence")


@app.command("recover")
def recover(payload: Path = typer.Option(..., "--payload", help="Profile recovery bundle or authorityUnavailable:true, plus expectedProfileVersion JSON.")):
    """Inventory preserved originals; no field is restored or confirmed."""
    from jobctrl.cli import _load_payload

    _request_json("POST", "/v1/profile/legacy-evidence/recover", _load_payload(payload))


@app.command("decide")
def decide(payload: Path = typer.Option(..., "--payload", help="Exact sourceId/text, token, versions and confirm/reject choice JSON.")):
    """Record the explicit human decision against the displayed source revision."""
    from jobctrl.cli import _load_payload

    _request_json("POST", "/v1/profile/legacy-evidence/decision", _load_payload(payload))
