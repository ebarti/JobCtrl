"""Command-line adapter for the sole Python application authority.

Business actions use the explicit Application composition. Reads and ordinary
writes execute the registered HTTP adapter in-process, so CLI never grows a
second repository or dispatches a legacy RPC method.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import typer

from jobctrl import __version__

app = typer.Typer(name="jobctrl", no_args_is_help=True, help="JobCtrl local Python application.")
_workspace: Path | None = None


def _workspace_path() -> Path:
    return (_workspace or Path(os.environ.get("JOBCTRL_DIR", "~/.jobctrl"))).expanduser().absolute()


def _output(value: Any) -> None:
    typer.echo(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _fail(code: str, message: str, *, exit_code: int = 1) -> None:
    typer.echo(json.dumps({"error": {"code": code, "message": message}}), err=True)
    raise typer.Exit(exit_code)


def _load_payload(payload: Path | None, data: str | None = None) -> dict:
    if payload is not None and data is not None:
        _fail("invalid_payload", "Choose --payload or --data.", exit_code=2)
    try:
        if payload is not None:
            if not payload.is_file() or payload.stat().st_size > 20 * 1024 * 1024:
                _fail("invalid_payload", "Payload must be a JSON object file smaller than 20 MiB.", exit_code=2)
            encoded = payload.read_text(encoding="utf-8")
        else:
            encoded = data if data is not None else "{}"
        def pairs(items):
            result = {}
            for key, item in items:
                if key in result:
                    raise ValueError("Duplicate JSON property.")
                result[key] = item
            return result
        def constant(_value):
            raise ValueError("Nonfinite JSON value.")
        value = json.loads(encoded, object_pairs_hook=pairs, parse_constant=constant)
    except (OSError, UnicodeError, ValueError):
        _fail("invalid_payload", "Payload must be a readable UTF-8 JSON object.", exit_code=2)
    if not isinstance(value, dict):
        _fail("invalid_payload", "Payload must be a JSON object.", exit_code=2)
    return value


def _application():
    from jobctrl.app.bootstrap import create_application

    from jobctrl.app.errors import AppError

    try:
        features = os.environ.get("JOBCTRL_FEATURES")
        return create_application(_workspace_path(), enabled_features=features.split(",") if features else None)
    except AppError as error:
        _fail(error.code, error.message)
    except Exception:
        _fail("application_unavailable", "The application composition could not be initialized.")


def _run(awaitable):
    from jobctrl.app.errors import AppError

    async def lifetime():
        try:
            return await awaitable
        finally:
            from jobctrl.app.model_providers import close_provider_runtimes
            await asyncio.to_thread(close_provider_runtimes)

    try:
        return asyncio.run(lifetime())
    except AppError as error:
        _fail(error.code, error.message)
    except typer.Exit:
        raise
    except KeyboardInterrupt:
        _fail("interrupted", "The command was interrupted; inspect its durable run before retrying.", exit_code=130)
    except Exception:
        _fail("operation_failed", "The application operation failed; inspect its existing run before retrying.")


async def _request(method: str, path: str, body: dict | None = None):
    import httpx

    from jobctrl.app.http import create_http_app
    from jobctrl.app.security import CapabilityToken

    parsed = urlsplit(path)
    if not path.startswith("/v1/") or parsed.scheme or parsed.netloc or parsed.fragment:
        _fail("invalid_path", "Request path must be a local /v1/ application path.", exit_code=2)
    application = _application()
    token = CapabilityToken(application.runtime.workspace).read_or_create()
    transport = httpx.ASGITransport(app=create_http_app(application), client=("127.0.0.1", 0))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8787", timeout=None) as client:
        response = await client.request(method.upper(), path, json=body, headers={"authorization": f"Bearer {token}"})
    if response.status_code >= 400:
        try:
            value = response.json()
            error = value.get("error", {})
            code = error.get("code", "request_failed") if isinstance(error, dict) else "request_failed"
            message = error.get("message", "The application rejected the request.") if isinstance(error, dict) else "The application rejected the request."
        except (ValueError, AttributeError):
            code, message = "request_failed", "The application rejected the request."
        _fail(code, message)
    return response


async def _execute(action_name: str, payload: dict, *, background: bool, idempotency_key: str | None = None):
    application = _application()
    if background:
        return await application.submit(action_name, payload, idempotency_key=idempotency_key)
    if idempotency_key:
        _fail("invalid_idempotency_key", "--idempotency-key requires --background.", exit_code=2)
    return await application.execute(action_name, payload)


def _version(value: bool) -> None:
    if value:
        typer.echo(f"jobctrl {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    workspace: Path | None = typer.Option(None, "--workspace", help="Owned workspace; defaults to JOBCTRL_DIR."),
    version: bool = typer.Option(False, "--version", callback=_version, is_eager=True),
) -> None:
    global _workspace
    _workspace = workspace
    # Native credential/browser adapters resolve the same selected workspace.
    if workspace is not None:
        os.environ["JOBCTRL_DIR"] = str(workspace.expanduser().absolute())


@app.command()
def actions() -> None:
    """List the explicit actions registered by the installed feature composition."""
    _output({"actions": sorted(_application().actions)})


@app.command()
def action(
    name: str = typer.Argument(..., help="Explicit feature.action name from `actions`."),
    payload: Path | None = typer.Option(None, "--payload", help="JSON object payload file."),
    data: str | None = typer.Option(None, "--data", help="Literal JSON object; use a file for private values."),
    background: bool = typer.Option(False, "--background", help="Submit to the durable worker and return its run ID."),
    idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
) -> None:
    """Execute the same canonical action as HTTP and the durable worker."""
    _output(_run(_execute(name, _load_payload(payload, data), background=background, idempotency_key=idempotency_key)))


def _feature_command(feature: str):
    def command(
        name: str = typer.Argument(..., help="Explicit action name (run `jobctrl actions` to inspect)."),
        payload: Path | None = typer.Option(None, "--payload"),
        data: str | None = typer.Option(None, "--data"),
        background: bool = typer.Option(False, "--background"),
        idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
    ) -> None:
        _output(_run(_execute(f"{feature}.{name}", _load_payload(payload, data), background=background, idempotency_key=idempotency_key)))
    return command


# Explicit names are part of the application composition, not discovered plugins.
for _feature in (
    "profile", "jobs", "requirements", "fit", "resumes", "discovery", "companies",
    "contacts", "outreach", "applications", "interviews", "learning",
    "compensation", "offers", "preparation",
):
    app.command(_feature, help=f"Execute a registered {_feature} action.")(_feature_command(_feature))


@app.command()
def request(
    method: str,
    path: str,
    payload: Path | None = typer.Option(None, "--payload"),
    data: str | None = typer.Option(None, "--data"),
    output: Path | None = typer.Option(None, "--output", help="Create an export file; existing files are refused."),
) -> None:
    """Use the actual local HTTP route in-process, including feature reads/exports."""
    if method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        _fail("invalid_method", "Use GET, POST, PUT, PATCH or DELETE.", exit_code=2)
    body = _load_payload(payload, data) if payload is not None or data is not None else None
    response = _run(_request(method, path, body))
    if output is not None:
        try:
            fd = os.open(output.expanduser(), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(response.content)
        except FileExistsError:
            _fail("output_exists", "The export path already exists; choose a new path.")
        _output({"exported": True, "path": str(output), "bytes": len(response.content)})
    elif "application/json" in response.headers.get("content-type", ""):
        _output(response.json())
    elif response.headers.get("content-type", "").startswith("text/"):
        typer.echo(response.text)
    else:
        _fail("output_required", "Use --output for binary exports.", exit_code=2)


async def _preparation(recipe: str, job_ids: list[str], *, limit: int | None = None,
                       force: bool = False, min_fit_score: int | None = None,
                       allow_below_threshold: bool = False, wait: bool = False,
                       idempotency_key: str | None = None, discovery: dict | None = None):
    payload: dict = {"recipe": recipe, "scope": "selected" if job_ids else "pending", "force": force}
    if job_ids:
        payload["job_ids"] = job_ids
    if limit is not None:
        payload["limit"] = limit
    if min_fit_score is not None:
        payload["min_fit_score"] = min_fit_score
    if allow_below_threshold:
        payload["allow_below_threshold"] = True
    if discovery is not None:
        payload["discovery"] = discovery
    application = _application()
    receipt = await application.submit("preparation.run", payload, idempotency_key=idempotency_key)
    if not wait:
        return receipt
    _output(receipt)
    while True:
        run = application.action_run(receipt["runId"])
        if run["status"] == "succeeded":
            return run
        if run["status"] in {"failed", "cancelled", "start_failed"}:
            _fail(run.get("errorCode") or "preparation_failed", "The preparation run ended without success; inspect its run ID and stage outcomes.")
        await asyncio.sleep(0.25)


def _recipe_command(recipe: str):
    def command(
        job_id: list[str] = typer.Option([], "--job-id", help="Saved JobId; repeat for an explicit selection."),
        limit: int | None = typer.Option(None, "--limit", min=1, max=1000),
        force: bool = typer.Option(False, "--force"),
        min_fit_score: int | None = typer.Option(None, "--min-fit-score", "--min-score", min=1, max=10),
        allow_below_threshold: bool = typer.Option(False, "--allow-below-threshold"),
        wait: bool = typer.Option(False, "--wait", help="Wait for this durable run; interruption leaves its ID available."),
        idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
    ) -> None:
        _output(_run(_preparation(recipe, job_id, limit=limit, force=force, min_fit_score=min_fit_score,
                                 allow_below_threshold=allow_below_threshold, wait=wait, idempotency_key=idempotency_key)))
    return command


for _recipe in ("enrich", "analyze", "score", "tailor", "prepare"):
    app.command(_recipe, help=f"Submit the explicit {_recipe} preparation recipe.")(_recipe_command(_recipe))


@app.command()
def discover(
    query: list[str] = typer.Option([], "--query"),
    location: list[str] = typer.Option([], "--location"),
    board: list[str] = typer.Option([], "--board"),
    limit: int | None = typer.Option(None, "--limit", min=1, max=1000),
    results_per_site: int | None = typer.Option(None, "--results-per-site", min=1, max=1000),
    hours_old: int | None = typer.Option(None, "--hours-old", min=1),
    wait: bool = typer.Option(False, "--wait"),
    idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
) -> None:
    """Discover jobs and prepare new/pending work through the canonical recipe."""
    discovery: dict = {}
    for key, value in (("queries", query), ("locations", location), ("boards", board),
                       ("resultsPerSite", results_per_site), ("hoursOld", hours_old)):
        if value:
            discovery[key] = value
    if limit is not None:
        discovery["newJobLimit"] = limit
    _output(_run(_preparation("discover", [], discovery=discovery or None, limit=limit,
                             wait=wait, idempotency_key=idempotency_key)))


@app.command()
def run(
    stages: list[str] | None = typer.Argument(None, help="One explicit recipe; default run performs discovery and preparation."),
    job_id: list[str] = typer.Option([], "--job-id"),
    limit: int | None = typer.Option(None, "--limit", min=1, max=1000),
    force: bool = typer.Option(False, "--force"),
    min_fit_score: int | None = typer.Option(None, "--min-fit-score", "--min-score", min=1, max=10),
    allow_below_threshold: bool = typer.Option(False, "--allow-below-threshold"),
    wait: bool = typer.Option(False, "--wait"),
    idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
) -> None:
    """Submit an explicit preparation recipe with retained per-stage outcomes."""
    chosen = stages or ["run"]
    if chosen == ["all"]:
        chosen = ["discover"]
    if len(chosen) != 1 or chosen[0] not in {"run", "discover", "enrich", "analyze", "score", "tailor", "prepare"}:
        _fail("explicit_recipe_required", "Choose one recipe: run, discover, enrich, analyze, score, tailor or prepare. Custom implicit stage combinations are no longer accepted.", exit_code=2)
    _output(_run(_preparation(chosen[0], job_id, limit=limit, force=force, min_fit_score=min_fit_score,
                             allow_below_threshold=allow_below_threshold, wait=wait, idempotency_key=idempotency_key)))


@app.command()
def retry(
    run_id: str,
    job_id: list[str] = typer.Option([], "--job-id"),
    idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
) -> None:
    """Retry the recorded preparation outcome without inventing new approval."""
    payload: dict = {"run_id": run_id}
    if job_id:
        payload["job_ids"] = job_id
    _output(_run(_execute("preparation.retry", payload, background=True, idempotency_key=idempotency_key)))


@app.command()
def digest(
    acknowledge: bool = typer.Option(False, "--acknowledge"),
    json_output: bool = typer.Option(False, "--json"),
    min_fit_score: int | None = typer.Option(None, "--min-fit-score", min=0, max=10,
                                           help="Override the high-fit threshold for this read only."),
) -> None:
    """Read or explicitly acknowledge the canonical current digest."""
    async def read():
        query = "?" + urlencode({"minFitScore": min_fit_score}) if min_fit_score is not None else ""
        generated = (await _request("GET", "/v1/digest" + query)).json()
        if acknowledge:
            receipt = (await _request("POST", "/v1/digest/acknowledge", {"acknowledgedAt": generated["generatedAt"]})).json()
            return {"digest": generated, "acknowledge": receipt}
        return generated

    _output(_run(read()))


@app.command("material-export")
def material_export(
    resume_id: str,
    output: Path = typer.Option(..., "--output", "-o"),
    format: str = typer.Option("pdf", "--format"),
    accepted: bool = typer.Option(False, "--accepted"),
    revision_id: str | None = typer.Option(None, "--revision-id", help="Pin one exact saved document revision."),
) -> None:
    """Export the actual Resumes document with source/acceptance guards."""
    if format not in {"pdf", "docx", "html", "txt"}:
        _fail("invalid_export_format", "Choose pdf, docx, html or txt.", exit_code=2)
    query = urlencode({"format": format, "accepted": str(accepted).lower(),
                       **({"revision_id": revision_id} if revision_id else {})})
    request("GET", "/v1/resumes/" + quote(resume_id, safe="") + "/export?" + query,
            payload=None, data=None, output=output)


@app.command("material-locale")
def material_locale(
    resume_id: str,
    operation: str = typer.Argument("list", help="list, generate, review, accept or export."),
    locale_id: str | None = typer.Option(None, "--locale-id"),
    payload: Path | None = typer.Option(None, "--payload"),
    output: Path | None = typer.Option(None, "--output"),
    format: str = typer.Option("pdf", "--format"),
) -> None:
    """Use source-linked locale generation, review, acceptance and exports."""
    path = "/v1/resumes/" + quote(resume_id, safe="") + "/locales"
    if operation == "list":
        request("GET", path, payload=None, data=None, output=None)
        return
    if operation not in {"generate", "review", "accept", "export"}:
        _fail("invalid_locale_operation", "Choose list, generate, review, accept or export.", exit_code=2)
    if operation == "generate":
        path += "/generate"
    else:
        if locale_id is None:
            _fail("locale_id_required", "This operation requires --locale-id.", exit_code=2)
        path += "/" + quote(locale_id, safe="") + "/" + operation
    if operation == "export":
        if output is None:
            _fail("output_required", "Locale export requires --output.", exit_code=2)
        request("GET", path + "?" + urlencode({"format": format}), payload=None, data=None, output=output)
    else:
        if payload is None:
            _fail("payload_required", "Locale changes require an exact revision-bound --payload.", exit_code=2)
        request("POST", path, payload=payload, data=None, output=None)


@app.command("check-availability")
def check_posting_availability(job_id: str) -> None:
    """Refresh the saved posting through Jobs source-bound availability authority."""
    async def refresh():
        application = _application()
        snapshot = application.services["jobs"].get_job(job_id)
        return await application.submit("jobs.refresh", {"job_id": job_id, "expectedRevision": snapshot["revision"]})
    _output(_run(refresh()))


screening_app = typer.Typer(help="Read and explicitly review application-bound screening answers.", no_args_is_help=True)


@screening_app.command("read")
def screening_read(job_id: str, tenant: str = typer.Option("local", "--tenant")) -> None:
    if tenant != "local":
        _fail("invalid_tenant", "Only the local workspace is available.", exit_code=2)
    _output(_run(_request("GET", "/v1/jobs/" + quote(job_id, safe="") + "/screening-answers")).json())


@screening_app.command("write")
def screening_write(job_id: str, command_file: Path, tenant: str = typer.Option("local", "--tenant")) -> None:
    if tenant != "local":
        _fail("invalid_tenant", "Only the local workspace is available.", exit_code=2)
    _output(_run(_request("POST", "/v1/jobs/" + quote(job_id, safe="") + "/screening-answers", _load_payload(command_file))).json())


app.add_typer(screening_app, name="screening")


@app.command("compensation-refresh")
def compensation_refresh(
    job_id: str | None = typer.Option(None, "--job-id"),
    all_jobs: bool = typer.Option(False, "--all"),
    stale: bool = typer.Option(False, "--stale"),
    observations_json: Path | None = typer.Option(None, "--observations-json", exists=True, dir_okay=False, readable=True),
    limit: int = typer.Option(0, "--limit", min=0, max=1000),
    tenant_id: str = typer.Option("local", "--tenant-id"),
    include_eurotoptech: bool | None = typer.Option(None, "--include-eurotoptech/--no-eurotoptech"),
    eurotoptech_max_pages: int | None = typer.Option(None, "--eurotoptech-max-pages", min=1, max=100),
    payload: Path | None = typer.Option(None, "--payload"),
    background: bool = typer.Option(True, "--background/--foreground"),
) -> None:
    """Refresh one job, all jobs or stale compensation through the owning action."""
    if tenant_id != "local":
        _fail("invalid_tenant", "Only the local workspace is available.", exit_code=2)
    if sum((job_id is not None, all_jobs, stale)) > 1:
        _fail("invalid_compensation_selection", "Choose a JobId, --all or --stale.", exit_code=2)
    value = _load_payload(payload)
    for key, item in (("observationsJsonPath", str(observations_json.expanduser().resolve()) if observations_json else None),
                      ("includeEuroTopTech", include_eurotoptech), ("euroTopTechMaxPages", eurotoptech_max_pages)):
        if item is not None:
            if key in value:
                _fail("duplicate_refresh_option", "Choose each refresh option in its flag or payload file once.", exit_code=2)
            value[key] = item
    if limit:
        value["limit"] = limit
    if job_id is not None:
        value["jobId"] = job_id
    action_name = "compensation.refresh" if job_id else "compensation.refresh_stale" if stale else "compensation.refresh_all"
    _output(_run(_execute(action_name, value, background=background)))


@app.command()
def apply(
    job_id: str | None = typer.Option(None, "--job-id"),
    payload_id: str | None = typer.Option(None, "--payload-id"),
    approval_id: str | None = typer.Option(None, "--approval-id"),
    payload: Path | None = typer.Option(None, "--payload", help="Exact approved batch items JSON."),
    limit: int = typer.Option(25, "--limit", min=1, max=100),
    workers: int | None = typer.Option(None, "--workers", "-w", min=1, max=8),
    min_fit_score: int | None = typer.Option(None, "--min-fit-score", "--min-score", min=1, max=10),
    url: str | None = typer.Option(None, "--url", help="Exact stored job/application URL; no source fetch or approval creation."),
    control: str | None = typer.Option(None, "--control", help="skip, cancel, reset, mark_failed or mark_applied."),
    expected_version: int | None = typer.Option(None, "--expected-version", min=0),
    reset_attempts: bool = typer.Option(False, "--reset-attempts"),
    recover: bool = typer.Option(False, "--recover", help="Inspect the canonical outcome/intent audit before any retry."),
    dry_run: bool = typer.Option(False, "--dry-run"),
    review_only: bool = typer.Option(False, "--review-only"),
    continuous: bool = typer.Option(False, "--continuous", help="Enable only the standing already-approved application poll."),
    stop_continuous: bool = typer.Option(False, "--stop-continuous"),
    interval_minutes: int = typer.Option(5, "--interval-minutes", min=1, max=1440),
    idempotency_key: str | None = typer.Option(None, "--idempotency-key"),
) -> None:
    """Execute current exact approvals or rehearse a reviewed payload.

    This command never creates approval or renews external authorization.
    """
    if control is not None or recover:
        if control is not None and recover:
            _fail("invalid_apply_selection", "Choose a control mutation or read-only recovery inspection.", exit_code=2)
        if not job_id or any((payload_id, approval_id, payload, dry_run, continuous, stop_continuous, url)):
            _fail("invalid_apply_selection", "Application control/recovery inspection requires exactly one --job-id.", exit_code=2)
        base = "/v1/jobs/" + quote(job_id, safe="")
        if recover:
            _output(_run(_request("GET", base + "/apply-audit")).json())
            return
        if control not in {"skip", "cancel", "reset", "mark_failed", "mark_applied"}:
            _fail("invalid_apply_control", "Choose skip, cancel, reset, mark_failed or mark_applied.", exit_code=2)
        if idempotency_key is None:
            _fail("idempotency_key_required", "Application control requires --idempotency-key.", exit_code=2)
        if control == "mark_applied":
            _output(_run(_request("POST", base + "/outcomes", {"idempotencyKey": idempotency_key, "kind": "applied_confirmation"})).json())
            return
        if expected_version is None:
            _fail("expected_version_required", "Application control requires the reviewed --expected-version.", exit_code=2)
        _output(_run(_request("POST", base + "/application/control", {"idempotencyKey": idempotency_key,
                     "expectedVersion": expected_version, "action": control, "resetAttempts": reset_attempts})).json())
        return
    if continuous or stop_continuous:
        if continuous and stop_continuous or any((job_id, payload_id, approval_id, payload, dry_run, review_only, url)) or limit != 25:
            _fail("invalid_apply_selection", "Standing-poll configuration cannot be combined with a job or batch operation.", exit_code=2)
        settings = _run(_request("GET", "/v1/settings")).json()
        patch = {"expectedRevision": settings["revision"], "applyAutomationEnabled": continuous,
                 "applyAutomationIntervalMinutes": interval_minutes}
        if workers is not None:
            patch["applyConcurrency"] = workers
        if min_fit_score is not None:
            patch["minFitScore"] = min_fit_score
        _output(_run(_request("PATCH", "/v1/settings", patch)).json())
        return
    if review_only:
        if not job_id:
            _fail("job_id_required", "Review requires --job-id.", exit_code=2)
        _output(_run(_request("GET", "/v1/jobs/" + quote(job_id, safe="") + "/application")).json())
        return
    if payload is not None:
        if any((job_id, payload_id, approval_id, dry_run)):
            _fail("invalid_apply_selection", "Choose an approved batch file or a single reviewed payload.", exit_code=2)
        value, action_name = _load_payload(payload), "applications.batch"
    elif job_id is not None:
        if not payload_id or (not dry_run and not approval_id):
            _fail("exact_approval_required", "Provide --payload-id and --approval-id, or --dry-run with --payload-id; inspect --review-only first.", exit_code=2)
        value = {"jobId": job_id, "payloadId": payload_id}
        if not dry_run:
            value["approvalId"] = approval_id
        action_name = "applications.rehearse" if dry_run else "applications.execute"
    else:
        if payload_id or approval_id:
            _fail("job_id_required", "A payload operation requires --job-id.", exit_code=2)
        value, action_name = {"limit": limit, "dry_run": dry_run}, "applications.run_approved"
        for key, item in (("workers", workers), ("min_fit_score", min_fit_score), ("url", url)):
            if item is not None:
                value[key] = item
    _output(_run(_execute(action_name, value, background=True, idempotency_key=idempotency_key)))


@app.command()
def job(
    target: str,
    apply_ready: bool = typer.Option(False, "--apply", help="Execute only a current exact approved payload for this saved URL."),
    prepare: bool = typer.Option(False, "--prepare"),
    score: bool = typer.Option(False, "--score"),
    tailor: bool = typer.Option(False, "--tailor"),
    wait: bool = typer.Option(False, "--wait"),
) -> None:
    """Inspect a saved JobId/URL, import a new URL, or submit its explicit recipe."""
    async def execute():
        application = _application()
        jobs = application.services["jobs"]
        if urlsplit(target).scheme in {"http", "https"}:
            snapshot = jobs.resolve_url(target)
            if snapshot is None:
                if any((apply_ready, prepare, score, tailor)):
                    _fail("saved_job_required", "Import the URL first, then inspect and review its saved data before requesting preparation or Apply.", exit_code=2)
                return await application.submit("jobs.capture_url", {"url": target})
        else:
            snapshot = jobs.get_job(target)
        if sum((apply_ready, prepare, score, tailor)) > 1:
            _fail("explicit_job_action_required", "Choose one explicit job action.", exit_code=2)
        if apply_ready:
            return await application.submit("applications.run_approved", {"limit": 1, "url": snapshot["url"]})
        if any((prepare, score, tailor)):
            recipe = "prepare" if prepare else "score" if score else "tailor"
            return await _preparation(recipe, [snapshot["job_id"]], wait=wait)
        return snapshot
    _output(_run(execute()))


@app.command("run-status")
def run_status(run_id: str) -> None:
    """Inspect the canonical durable run without starting it again."""
    async def inspect():
        return _application().action_run(run_id)
    _output(_run(inspect()))


@app.command()
def cancel(run_id: str) -> None:
    """Request cancellation of the existing durable action."""
    async def stop():
        return await _application().cancel(run_id)
    _output(_run(stop()))


@app.command()
def init() -> None:
    """Initialize a fresh workspace and guide Profile, discovery and provider setup."""
    from jobctrl.runtime import is_bundled_runtime

    health = _run(_request("GET", "/v1/health")).json()
    _output({**health, "nextSteps": [
        {"command": "jobctrl start" if is_bundled_runtime() else "corepack pnpm dev",
         "purpose": "Start the local application and open its web interface."},
        {"path": "/profile", "purpose": "Create or review your complete structured Profile and authored baseline."},
        {"path": "/profile/import", "purpose": "Import a text or PDF source, then review it before acceptance."},
        {"path": "/discovery", "purpose": "Choose roles, locations and source filters without replacing existing choices."},
        {"command": "jobctrl setup", "path": "/settings/credentials",
         "purpose": "Explicitly configure provider credentials and select a live model."},
    ]})


@app.command()
def doctor(json_output: bool = typer.Option(False, "--json")) -> None:
    """Inspect real Profile, providers, browser, worker, budget and Temporal readiness."""
    _output(_run(_request("GET", "/v1/setup/status")).json())


@app.command()
def setup(
    payload: Path | None = typer.Option(None, "--payload", help="Canonical settings patch, including expectedRevision."),
    provider: str | None = typer.Option(None, "--provider", help="Explicit codex, claude or google provider."),
    model: str | None = typer.Option(None, "--model", help="Exact model ID from the provider catalog."),
    yes: bool = typer.Option(False, "--yes", "-y"),
    non_interactive: bool = typer.Option(False, "--non-interactive"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show intended actions without creating or changing files."),
    json_output: bool = typer.Option(False, "--json", help="Print the secret-free machine-readable result."),
    launch_logins: bool = typer.Option(False, "--launch-logins", help="Explicitly enroll Codex using its managed vendor login."),
    skip_doctor: bool = typer.Option(False, "--skip-doctor"),
) -> None:
    """Guide provider/model selection through canonical settings and native credentials.

    Interactive Claude/Google keys go only to the operating system native
    store. Cloud modes remain available through Settings → Credentials or the
    same public credential routes. Source tool/browser provisioning belongs to
    scripts/install and scripts/dev setup.
    """
    if provider is not None and provider not in {"codex", "claude", "google"}:
        _fail("invalid_provider", "Choose codex, claude or google.", exit_code=2)
    if model is not None and provider is None:
        _fail("provider_required", "--model requires --provider.", exit_code=2)
    if payload is not None and (provider is not None or model is not None or launch_logins):
        _fail("invalid_setup_options", "Apply a settings payload separately from provider selection or vendor login.", exit_code=2)
    if launch_logins and provider not in {None, "codex"}:
        _fail("invalid_login_provider", "Managed CLI login is available for Codex; choose --provider codex.", exit_code=2)
    if dry_run:
        patch = _load_payload(payload) if payload is not None else None
        _output({"ok": True, "dryRun": True, "workspace": str(_workspace_path()),
                 "provider": provider, "model": model, "settingsPatchKeys": sorted(patch) if patch is not None else [],
                 "credentialInput": "hidden_interactive_only", "codexLoginRequested": launch_logins,
                 "doctorRequested": not skip_doctor, "liveValidation": "required_when_applied"})
        return
    if payload is not None:
        _output(_run(_request("PATCH", "/v1/settings", _load_payload(payload))).json())
        return
    current = _run(_request("GET", "/v1/settings")).json()
    statuses = _run(_request("GET", "/v1/providers/status")).json()
    interactive = not (non_interactive or yes)
    if launch_logins and provider is None:
        provider = "codex"
    if provider is None and interactive:
        _output(statuses)
        provider = typer.prompt("Provider (codex, claude, google)", default=current["defaultProvider"])
    changed = False
    if provider is not None:
        if provider not in {"codex", "claude", "google"}:
            _fail("invalid_provider", "Choose codex, claude or google.", exit_code=2)
        selected_status = next(item for item in statuses["providers"] if item["provider"] == provider)
        if provider in {"claude", "google"} and interactive:
            key = "ANTHROPIC_API_KEY" if provider == "claude" else "GEMINI_API_KEY"
            if typer.confirm(f"Add or update {key} in the operating system native credential store?", default=False):
                credentials = _run(_request("GET", "/v1/credentials")).json()
                selected_key = next(item for item in credentials["credentials"] if item["key"] == key)
                if not selected_key["editable"]:
                    _fail("credential_not_editable", "This credential is supplied by the launch environment or its native store is unavailable.")
                secret = typer.prompt(key, hide_input=True).strip()
                if not secret:
                    _fail("credential_required", "A nonempty credential is required.", exit_code=2)
                _run(_request("PATCH", "/v1/credentials", {"expectedRevision": credentials["revision"], "key": key, "value": secret}))
                del secret
                changed = True
        elif provider == "codex":
            if launch_logins:
                enrollment = _run(_request("POST", "/v1/providers/codex/login", {})).json()
                if not enrollment.get("ok"):
                    _fail("provider_login_failed", "Codex login did not establish an authenticated managed runtime.")
                changed = True
            elif interactive and not selected_status["ready"] and typer.confirm("Reuse and verify an existing Codex login for this workspace?", default=False):
                enrollment = _run(_request("POST", "/v1/providers/codex/verify", {})).json()
                if not enrollment.get("ok"):
                    _fail("provider_not_ready", "Codex authentication could not be verified; use setup --provider codex --launch-logins or Settings → Credentials.")
        catalog = _run(_request("GET", "/v1/providers/models")).json()
        selected_catalog = next(item for item in catalog["providers"] if item["provider"] == provider)
        if not selected_catalog["ready"] or not selected_catalog["models"]:
            _fail("provider_not_ready", selected_catalog.get("message") or "The selected provider has no available live models; previous model settings are preserved.")
        # Native credential changes advance the shared settings revision too.
        # Read the current canonical selection after enrollment, then retain CAS
        # across the user's model prompt and final confirmation.
        current = _run(_request("GET", "/v1/settings")).json()
        if model is None and interactive:
            _output({"provider": provider, "models": selected_catalog["models"]})
            identifiers = [item["id"] for item in selected_catalog["models"]]
            saved = current["providerModels"][provider]
            model = typer.prompt("Exact model ID from the live catalog", default=saved if saved in identifiers else identifiers[0])
        if model is None:
            model = current["providerModels"][provider]
        if yes or non_interactive or typer.confirm("Save this provider/model selection?", default=False):
            value = {"expectedRevision": current["revision"], "defaultProvider": provider,
                     "providerModels": {**current["providerModels"], provider: model}}
            _run(_request("PATCH", "/v1/settings", value))
            changed = True
    if not skip_doctor:
        _output(_run(_request("GET", "/v1/setup/status")).json())
    else:
        _output({"ok": True, "settingsChanged": changed, "provider": provider})


@app.command("pipeline-status")
def pipeline_status() -> None:
    """Inspect durable application/worker readiness."""
    _output(_run(_request("GET", "/v1/health")).json())


@app.command("runs")
def runs() -> None:
    """List canonical durable action runs."""
    _output(_run(_request("GET", "/v1/action-runs")).json())


@app.command("extension-token")
def extension_token(rotate: bool = typer.Option(False, "--rotate")) -> None:
    """Show the local pairing capability only on this explicit command."""
    from jobctrl.app.security import CapabilityToken

    application = _application()
    token = CapabilityToken(application.runtime.workspace)
    _output({"token": token.rotate() if rotate else token.read_or_create()})


@app.command("profile-transfer")
def profile_transfer(
    source: Path = typer.Option(..., "--source", help="Existing source workspace; read-only."),
    target: Path = typer.Option(..., "--target", help="Nonexistent path for the fresh application workspace."),
    confirm_profile_only_reset: bool = typer.Option(False, "--confirm-profile-only-reset", help="Explicitly transfer only Profile; other application data starts empty."),
    browser_sources: Path = typer.Option(..., "--browser-sources", help="Complete read-only browser Profile sources/attachment manifest."),
) -> None:
    """Deliberate breaking cutover: preserve full Profile into a new workspace.

    Source data remains untouched. No current workspace selector is changed.
    """
    if not confirm_profile_only_reset:
        _fail("confirmation_required", "Pass --confirm-profile-only-reset after reviewing that only Profile transfers.", exit_code=2)
    source = source.expanduser().absolute()
    target = target.expanduser().absolute()
    if source.is_symlink() or not source.is_dir():
        _fail("invalid_source", "Source must be an existing workspace directory.", exit_code=2)
    source = source.resolve()
    target = target.parent.resolve() / target.name
    if target == source or source in target.parents:
        _fail("invalid_target", "The fresh target must be outside the source workspace.", exit_code=2)
    if target.exists() or target.is_symlink():
        _fail("target_exists", "Target must not exist; existing data is never overwritten.", exit_code=2)
    from jobctrl.app.bootstrap import create_application
    from jobctrl.app.errors import AppError
    from jobctrl.features.profile.transfer import export_legacy_profile, import_profile, validate_bundle

    try:
        # Export before creating any target. Profile owns the read-only snapshot,
        # exact attachments and provenance validation, never a runtime SQL copy.
        bundle = export_legacy_profile(source, browser_export=_load_payload(browser_sources))
        transferred = validate_bundle(bundle)
        if transferred.get("transfer_complete") is not True:
            _fail("profile_transfer_incomplete", "The browser Profile export is incomplete; no target was created.")
        digest = hashlib.sha256(json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        target.mkdir(mode=0o700, parents=False, exist_ok=False)
        application = create_application(target, enabled_features={"profile"})
        import_profile(application.services["profile"], bundle)
        receipt = {
            "schema": "jobctrl.profile-cutover.v1", "status": "complete", "sourcePreserved": True,
            "target": str(target), "profileBundleSha256": digest, "reset": "all-non-profile-application-data",
            "selected": False,
        }
        with (target / "profile-transfer-receipt.json").open("x", encoding="utf-8") as stream:
            os.chmod(stream.name, 0o600)
            json.dump(receipt, stream, indent=2)
        _output(receipt)
    except AppError as error:
        _fail(error.code, error.message)
    except FileExistsError:
        _fail("target_exists", "Target was created concurrently; no existing data is overwritten.")
    except (OSError, ValueError):
        _fail("profile_transfer_failed", "Profile transfer did not complete; preserve the source and inspect any owned target before retrying.")


@app.command()
def backup(output: Path | None = typer.Option(None, "--output", "-o")) -> None:
    """Create a consistent read-only snapshot; never replace an existing file."""
    import sqlite3
    import tempfile
    from contextlib import closing
    from datetime import datetime, timezone

    source = _workspace_path() / "jobctrl.db"
    if source.is_symlink() or not source.is_file():
        _fail("database_missing", "Choose an existing regular application database.")
    destination = output or (_workspace_path() / "backups" / ("jobctrl-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".db"))
    destination = destination.expanduser().absolute()
    if destination.is_dir():
        destination /= "jobctrl-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".db"
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        fd, name = tempfile.mkstemp(prefix=".jobctrl-backup-", suffix=".db", dir=destination.parent)
        os.close(fd)
        temporary = Path(name)
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as reader:
            with closing(sqlite3.connect(temporary)) as writer:
                reader.backup(writer)
                if writer.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    _fail("backup_invalid", "The SQLite snapshot did not pass integrity validation.")
        os.link(temporary, destination)
        _output({"backedUp": True, "path": str(destination), "bytes": destination.stat().st_size})
    except FileExistsError:
        _fail("output_exists", "The backup destination already exists; choose a new path.")
    except (OSError, sqlite3.Error):
        _fail("backup_failed", "A consistent backup could not be created; the source was not modified.")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@app.command("gmail-auth")
def gmail_auth(no_open: bool = typer.Option(False, "--no-open"), timeout: int = typer.Option(180, "--timeout", min=10, max=600)) -> None:
    """Start the explicit Gmail OAuth flow through the Applications mail adapter."""
    from jobctrl.app.errors import AppError
    from jobctrl.features.applications.mail import authenticate_gmail

    try:
        path = authenticate_gmail(_workspace_path(), open_browser=not no_open, timeout_seconds=timeout)
    except AppError as error:
        _fail(error.code, error.message)
    _output({"authenticated": True, "tokenPath": str(path)})


from jobctrl.company_briefing_cli import app as company_briefing_app  # noqa: E402
from jobctrl.source_proposals_cli import app as source_proposals_app  # noqa: E402
from jobctrl.legacy_evidence_cli import app as legacy_evidence_app  # noqa: E402

app.add_typer(company_briefing_app, name="company-briefing")
app.add_typer(source_proposals_app, name="source-proposals")
app.add_typer(legacy_evidence_app, name="legacy-evidence")


# These are native I/O adapters, never business/database bootstrap. Importing
# them registers names only; workspace-sensitive modules load inside commands.
from jobctrl.runtime_commands import capability_app, credentials_app, provider_pack_install  # noqa: E402

app.add_typer(capability_app, name="capability")
app.add_typer(credentials_app, name="credentials")
app.command("provider-pack-install", hidden=True)(provider_pack_install)
