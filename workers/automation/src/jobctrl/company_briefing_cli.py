"""Explicit Companies CLI adapter over its public application service."""

from __future__ import annotations

import json
import typer
from rich.console import Console

app = typer.Typer(help="Opt-in company briefings from selected public pages.", no_args_is_help=True)


def _call(operation, json_output):
    from jobctrl.cli import _application, _run

    async def execute():
        application = _application()
        return operation(application.services["companies"])
    output(_run(execute()), json_output)


def output(view, json_output):
    if json_output:
        typer.echo(json.dumps(view, ensure_ascii=False))
        return
    console = Console(markup=False)
    if view is None:
        console.print(
            "No company briefing configured. Use company-briefing configure to confirm identity and select sources."
        )
        return
    if view["status"] == "unavailable":
        console.print("The saved briefing could not be verified. Its history is preserved.")
        return
    console.print(f"Company briefing: {view['company']['name']} · {view['status']}")
    console.print(view["company"]["homepageUrl"])
    if view["staleReasons"]:
        console.print("Review needed: " + ", ".join(view["staleReasons"]))
    if view["lastAttempt"] and view["lastAttempt"]["failureCode"]:
        console.print("Refresh failed: " + view["lastAttempt"]["failureCode"] + ". Last accepted briefing preserved.")
    accepted = view["accepted"]
    if not accepted:
        console.print("No accepted briefing. Refresh requires --allow-public-fetch.")
        return
    console.print("Sources observed: " + accepted["observedAt"])
    sources = {source["sourceId"]: source for source in accepted["sources"]}
    for claim in accepted["result"]["claims"]:
        console.print(f"\n{claim['kind']}: {claim['text']}")
        console.print("Uncertainty: " + claim["uncertainty"])
        if claim["event_date"]:
            console.print("Reported date: " + claim["event_date"])
        for citation in claim["citations"]:
            source = sources[citation["source_id"]]
            console.print(f"  {source['finalUrl']} · observed {source['observedAt']}\n  {citation['quote']}")



@app.command("configure")
def configure(
    job_id: str,
    company_url: str = typer.Option(..., "--company-url"),
    source: list[str] = typer.Option(..., "--source"),
    confirm_identity: bool = typer.Option(False, "--confirm-identity"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Confirm the job/company identity and public sources without fetching."""
    _call(lambda service: service.configure(job_id, homepage_url=company_url,
                                            source_urls=source, confirm_identity=confirm_identity), json_output)


@app.command("show")
def show(job_id: str, json_output: bool = typer.Option(False, "--json")):
    """Read accepted briefing, freshness, sources and latest failed attempt."""
    _call(lambda service: service.read(job_id), json_output)


@app.command("refresh")
def refresh(
    job_id: str,
    allow_public_fetch: bool = typer.Option(False, "--allow-public-fetch"),
    force: bool = typer.Option(False, "--force"),
    background: bool = typer.Option(False, "--background"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Execute the canonical Companies refresh with explicit public-fetch consent."""
    from jobctrl.cli import _execute, _run

    result = _run(_execute("companies.refresh", {"job_id": job_id, "allow_public_fetch": allow_public_fetch,
                                               "force": force}, background=background))
    if background:
        typer.echo(json.dumps(result, ensure_ascii=False))
    else:
        output(result, json_output)
