"""Explicit company briefing commands; passive reads never refresh."""

import json
import typer
from rich.console import Console

from jobctrl.domain.determinations import DeterminationFailure

app = typer.Typer(help="Opt-in company briefings from selected public pages.", no_args_is_help=True)


def repository():
    from jobctrl.cli import _bootstrap
    from jobctrl.database import get_connection
    from jobctrl.infrastructure.materials.company_briefings import CompanyBriefingRepository

    _bootstrap()
    return CompanyBriefingRepository(get_connection())


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


def run(action, json_output):
    try:
        output(action(), json_output)
    except (DeterminationFailure, ValueError) as error:
        code = error.code if isinstance(error, DeterminationFailure) else "briefing_invalid_input"
        typer.echo(
            json.dumps({"ok": False, "error": code})
            if json_output
            else f"Company briefing unavailable: {code}. Saved briefing preserved."
        )
        raise typer.Exit(1) from None


@app.command("configure")
def configure(
    job_id: str = typer.Argument(..., help="Canonical saved JobId."),
    company_url: str = typer.Option(
        ..., "--company-url", help="Exact public company homepage identifying this employer."
    ),
    source: list[str] = typer.Option(
        ..., "--source", help="Public source URL; repeat up to three times. No queries or fragments."
    ),
    confirm_identity: bool = typer.Option(
        False, "--confirm-identity", help="Confirm that this job belongs to the selected company."
    ),
    json_output: bool = typer.Option(False, "--json"),
):
    """Confirm one job/company link and the shared source list. Makes no network calls."""
    run(
        lambda: repository().configure(
            job_id, homepage_url=company_url, source_urls=source, confirm_identity=confirm_identity
        ),
        json_output,
    )


@app.command("show")
def show(job_id: str = typer.Argument(...), json_output: bool = typer.Option(False, "--json")):
    """Read the last accepted briefing with its current freshness and failure state."""
    run(lambda: repository().read(job_id), json_output)


@app.command("refresh")
def refresh(
    job_id: str = typer.Argument(...),
    allow_public_fetch: bool = typer.Option(
        False, "--allow-public-fetch", help="Opt into bounded anonymous fetches and the configured enrichment model."
    ),
    force: bool = typer.Option(
        False, "--force", help="Re-fetch even when the saved briefing is less than seven days old."
    ),
    json_output: bool = typer.Option(False, "--json"),
):
    """Refresh selected sources. Reuse a current briefing unless --force is given."""
    from jobctrl.infrastructure.materials.company_briefings import refresh_briefing

    run(lambda: refresh_briefing(repository(), job_id, allow_public_fetch=allow_public_fetch, force=force), json_output)
