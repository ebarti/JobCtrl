"""Source-history proposal CLI using the owning Discovery HTTP adapters."""

from __future__ import annotations

from urllib.parse import quote

import typer

app = typer.Typer(help="Propose sources from saved postings for explicit review.", no_args_is_help=True)


def _request_json(method, path, payload=None):
    from jobctrl.cli import _output, _request, _run

    _output(_run(_request(method, path, payload)).json())


@app.command("from-history")
def from_history(job_id: str | None = typer.Option(None, "--job-id")):
    """Explicitly propose from canonical URLs; never fetch, promote or enable."""
    _request_json("POST", "/v1/discovery/source-proposals/from-history", {"job_id": job_id} if job_id else {})


@app.command("list")
def list_saved():
    """Read proposals, origin receipts and persisted review history."""
    _request_json("GET", "/v1/discovery/source-proposals")


@app.command("reset")
def reset(candidate_id: str):
    """Allow a rejected source to be proposed again without enabling it."""
    _request_json("POST", "/v1/discovery/locator-candidates/" + quote(candidate_id, safe="") + "/reset", {})
