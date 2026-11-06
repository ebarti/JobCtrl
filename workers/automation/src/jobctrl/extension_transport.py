"""Extension HTTP and browser acquisition transport for the Python application.

This adapter owns pairing/lease/capture receipts only. Jobs owns posting meaning
and canonical capture. Discovery calls a narrow browser port; external browser
work is fenced to the exact active action and selected installation.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import ipaddress
import os
import socket
import json
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.security import CapabilityToken
from jobctrl.network.url_safety import validate_public_http_url

SCHEMA = """
CREATE TABLE extension_installation (
 id INTEGER PRIMARY KEY CHECK(id=1), installation_id TEXT NOT NULL,
 version TEXT NOT NULL, last_seen REAL NOT NULL
);
CREATE TABLE extension_browser_tasks (
 task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
 temporal_run_id TEXT NOT NULL, source_id TEXT NOT NULL, request_json TEXT NOT NULL,
 state TEXT NOT NULL, created_at REAL NOT NULL, deadline REAL NOT NULL,
 timeout_ms INTEGER NOT NULL, installation_id TEXT, lease_id TEXT,
 lease_deadline REAL, result_json TEXT
);
CREATE INDEX extension_tasks_state ON extension_browser_tasks(state,created_at);
CREATE TABLE extension_capture_receipts (
 capture_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, owner_id TEXT NOT NULL,
 state TEXT NOT NULL, lease_deadline REAL NOT NULL, acknowledgement_json TEXT
);
"""
TRUSTED_BROWSER_HOSTS = frozenset({
    "ashbyhq.com", "example.com", "example.test", "glassdoor.com", "google.com",
    "greenhouse.io", "icims.com", "indeed.com", "jobvite.com", "lever.co",
    "linkedin.com", "myworkdayjobs.com", "smartrecruiters.com", "workday.com",
})
FORBIDDEN_HEADERS = frozenset({
    "connection", "content-length", "cookie", "host", "origin", "referer",
    "user-agent", "authorization", "proxy-authorization",
})
TERMINAL = frozenset({"succeeded", "failed"})


def _json(value, status=200):
    return JSONResponse(value, status_code=status, headers={"cache-control": "no-store"})


def _text(value, *, maximum=200, label="value"):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AppError("invalid_extension_request", f"A valid {label} is required.")
    return value.strip()


def _identifier(value, *, maximum=160):
    value = _text(value, maximum=maximum, label="stable request identity")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-" for character in value):
        raise AppError("invalid_extension_identity", "Request identities must use the documented identifier format.")
    return value


def _uuid(value):
    try:
        return str(uuid.UUID(_text(value, maximum=36, label="installation/lease identity")))
    except ValueError:
        raise AppError("invalid_extension_identity", "A valid installation/lease identity is required.") from None


def _url(value):
    value = _text(value, maximum=4096, label="HTTP(S) URL")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError()
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
    except ValueError:
        raise AppError("invalid_extension_url", "A public HTTP(S) URL is required.") from None
    return value


async def _public_browser_url(value, runtime):
    value = _url(value)
    hostname = urlsplit(value).hostname.lower().rstrip(".")
    if not any(hostname == host or hostname.endswith("." + host) for host in TRUSTED_BROWSER_HOSTS):
        raise AppError("untrusted_discovery_browser_host", "The live browser is limited to supported provider hosts.")
    resolver = None
    endpoint = os.environ.get("JOBCTRL_E2E_DNS_URL")
    if endpoint:
        # DNS is an external I/O boundary. Owned synthetic E2E controls only its
        # answer; the same production URL/IP validator still decides admission.
        from jobctrl.app.synthetic import synthetic_boundary
        owned = synthetic_boundary(runtime.workspace, endpoint)
        if owned is None:
            raise AppError("synthetic_boundary_unowned", "Controlled DNS requires an owned synthetic workspace.", 503)
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=5) as client:
                async with client.stream("POST", endpoint, json={"hostname": hostname},
                                         headers={"authorization": "Bearer " + owned["token"]}) as response:
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 8192:
                            raise ValueError("DNS response bound")
            answer = json.loads(data)
            addresses = answer["addresses"]
            if set(answer) != {"addresses"} or not isinstance(addresses, list) or not 1 <= len(addresses) <= 32 or not all(isinstance(address, str) and len(address) <= 64 for address in addresses):
                raise ValueError("DNS envelope")
            parsed = [ipaddress.ip_address(address) for address in addresses]
            def controlled_resolver(requested_host, port, **_options):
                if requested_host.lower().rstrip(".") != hostname:
                    raise OSError("Unexpected DNS host")
                return [(socket.AF_INET if address.version == 4 else socket.AF_INET6, socket.SOCK_STREAM,
                         socket.IPPROTO_TCP, "", (str(address), port)) for address in parsed]
            resolver = controlled_resolver
        except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError):
            raise AppError("dns_unavailable", "The controlled external DNS response is unavailable or invalid.", 503) from None
    decision = await asyncio.to_thread(validate_public_http_url, value, resolver=resolver)
    if not decision.allowed:
        raise AppError("unsafe_discovery_browser_url", "The browser destination is not a verified public HTTP(S) address.")
    return value


def _request_payload(value):
    if not isinstance(value, dict):
        raise AppError("invalid_browser_request", "A browser request object is required.")
    mode = value.get("mode")
    allowed = {"mode", "url"} if mode == "rendered_page" else {"mode", "url", "method", "headers", "body"}
    if mode not in {"rendered_page", "http_request"} or set(value) - allowed:
        raise AppError("invalid_browser_request", "Unsupported browser request fields.")
    result = {"mode": mode, "url": _url(value.get("url"))}
    if mode == "http_request":
        method = value.get("method", "GET")
        headers = value.get("headers", {})
        if method not in {"GET", "POST"} or not isinstance(headers, dict) or len(headers) > 32:
            raise AppError("invalid_browser_request", "Browser requests support bounded GET/POST headers.")
        for name, header in headers.items():
            key = _text(name, maximum=80, label="header name").lower()
            if key in FORBIDDEN_HEADERS or key.startswith(("sec-", "proxy-")) or not isinstance(header, str) or len(header) > 4096 or any(c in header + name for c in "\r\n"):
                raise AppError("forbidden_browser_header", "Browser-owned or unsafe headers cannot be supplied.")
        result.update(method=method, headers=dict(headers))
        if "body" in value:
            body = value["body"]
            if method != "POST" or not isinstance(body, str) or len(body.encode()) > 2_000_000:
                raise AppError("invalid_browser_body", "Only POST requests may contain a bounded text body.")
            result["body"] = body
    return result


def _failure(code="request_failed", message="The browser acquisition ended before a valid result was recorded.", retryable=True):
    return {"status": "failed", "errorCode": code, "message": message, "retryable": retryable}


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


class ExtensionBroker:
    def __init__(self, runtime):
        self.runtime = runtime
        self.application = None
        runtime.database.initialize_feature("extension", SCHEMA)

    def bind(self, application):
        self.application = application

    def _active_run(self, run_id, *, workflow_id=None, temporal_run_id=None, connection=None):
        if self.application is None:
            raise AppError("browser_runtime_unbound", "The browser transport is not composed.", 503)
        run = self.application.action_run(run_id, connection=connection)
        if run.get("status") not in {"queued", "running"} or run.get("cancellationRequested") or run.get("cancellation_requested"):
            raise AppError("browser_action_inactive", "Browser acquisition requires an active, uncancelled action.", 409)
        if workflow_id is not None and run.get("workflowId") != workflow_id:
            raise ConflictError("The browser task belongs to a different workflow.")
        if temporal_run_id is not None and run.get("temporalRunId") != temporal_run_id:
            raise ConflictError("The browser task belongs to a different workflow execution.")
        return run

    def _expire(self, connection):
        now = time.time()
        connection.execute("UPDATE extension_browser_tasks SET state='failed',result_json=? WHERE state IN ('pending','leased') AND (deadline<=? OR (state='leased' AND lease_deadline<=?))",
                           (json.dumps(_failure(message="The browser task or lease timed out.")), now, now))
        # Acquisition envelopes have a bounded operational lifetime. They never
        # become Profile, source evidence or a second durable workflow history.
        connection.execute("DELETE FROM extension_browser_tasks WHERE state IN ('succeeded','failed') AND deadline<?", (now - 600,))

    def status(self):
        with self.runtime.database.transaction() as connection:
            self._expire(connection)
            installation = connection.execute("SELECT * FROM extension_installation WHERE id=1").fetchone()
            counts = dict(connection.execute("SELECT state,count(*) FROM extension_browser_tasks GROUP BY state"))
            return {"ok": True, "connected": bool(installation and installation["last_seen"] > time.time() - 45),
                    "installationBound": installation is not None,
                    "installationIdSuffix": installation["installation_id"][-8:] if installation else None,
                    "lastSeenAt": _iso(installation["last_seen"]) if installation else None,
                    "extensionVersion": installation["version"] if installation else None,
                    "pendingTasks": counts.get("pending", 0), "activeTasks": counts.get("leased", 0)}

    def disconnect(self):
        with self.runtime.database.transaction() as connection:
            connection.execute("DELETE FROM extension_installation")
            connection.execute("UPDATE extension_browser_tasks SET state='failed',result_json=? WHERE state IN ('pending','leased')",
                               (json.dumps(_failure(message="The selected extension disconnected.", retryable=False)),))

    def claim(self, body):
        if not isinstance(body, dict) or set(body) - {"installationId", "extensionVersion", "replace"}:
            raise AppError("invalid_extension_claim", "The extension claim is invalid.")
        installation_id = _uuid(body.get("installationId"))
        version = _text(body.get("extensionVersion"), maximum=80, label="extension version")
        replace = body.get("replace", False)
        if type(replace) is not bool:
            raise AppError("invalid_extension_claim", "The extension replacement choice must be explicit.")
        with self.runtime.database.transaction() as connection:
            previous = connection.execute("SELECT installation_id FROM extension_installation WHERE id=1").fetchone()
            if previous and previous[0] != installation_id:
                if not replace:
                    raise ConflictError("Another Chrome profile is selected for Discovery; pair explicitly to replace it.")
                connection.execute("UPDATE extension_browser_tasks SET state='failed',result_json=? WHERE state='leased'",
                                   (json.dumps(_failure(message="The selected Chrome profile changed.", retryable=False)),))
            connection.execute("INSERT INTO extension_installation VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id,version=excluded.version,last_seen=excluded.last_seen",
                               (installation_id, version, time.time()))
        return {"ok": True, "installationBound": True, "selected": True}

    def _selected(self, connection, installation_id, version):
        installation_id = _uuid(installation_id)
        row = connection.execute("SELECT * FROM extension_installation WHERE id=1").fetchone()
        if row is None or row["installation_id"] != installation_id:
            raise ConflictError("This Chrome profile is not selected for Discovery.")
        connection.execute("UPDATE extension_installation SET version=?,last_seen=? WHERE id=1", (version[:80] or "unknown", time.time()))
        return installation_id

    async def create_task(self, body):
        if not isinstance(body, dict) or set(body) - {"taskId", "runId", "workflowId", "temporalRunId", "sourceId", "sourceFamily", "request", "timeoutMs"}:
            raise AppError("invalid_browser_task", "The browser task envelope is invalid.")
        request = _request_payload(body.get("request"))
        await _public_browser_url(request["url"], self.runtime)
        task_id = _identifier(body.get("taskId"))
        run_id = _text(body.get("runId"), maximum=200, label="action run ID")
        workflow_id = _text(body.get("workflowId"), maximum=200, label="workflow ID")
        temporal_run_id = _text(body.get("temporalRunId"), maximum=200, label="Temporal execution ID")
        timeout_ms = body.get("timeoutMs", 60000)
        if type(timeout_ms) is not int or not 1000 <= timeout_ms <= 120000:
            raise AppError("invalid_browser_timeout", "Browser timeouts must be 1–120 seconds.")
        self._active_run(run_id, workflow_id=workflow_id, temporal_run_id=temporal_run_id)
        source_id = _text(body.get("sourceId", "discovery"), maximum=200, label="source ID")
        now = time.time()
        with self.runtime.database.transaction() as connection:
            # Cancellation uses this same writer lock. A DNS result never
            # carries action authority across its asynchronous boundary.
            self._active_run(run_id, workflow_id=workflow_id, temporal_run_id=temporal_run_id, connection=connection)
            self._expire(connection)
            previous = connection.execute("SELECT * FROM extension_browser_tasks WHERE task_id=?", (task_id,)).fetchone()
            if previous:
                if (previous["run_id"], previous["request_json"], previous["workflow_id"], previous["temporal_run_id"]) != (run_id, json.dumps(request, sort_keys=True), workflow_id, temporal_run_id):
                    raise ConflictError("A task ID cannot be reused for a different acquisition.")
                return {"ok": True, "taskId": task_id, "status": previous["state"]}
            if connection.execute("SELECT count(*) FROM extension_browser_tasks WHERE state IN ('pending','leased')").fetchone()[0] >= 64:
                raise AppError("browser_capacity_busy", "The extension acquisition queue is full.", 429)
            connection.execute("INSERT INTO extension_browser_tasks(task_id,run_id,workflow_id,temporal_run_id,source_id,request_json,state,created_at,deadline,timeout_ms) VALUES(?,?,?,?,?,?,'pending',?,?,?)",
                               (task_id, run_id, workflow_id, temporal_run_id, source_id, json.dumps(request, sort_keys=True), now, now + timeout_ms / 1000, timeout_ms))
        return {"ok": True, "taskId": task_id, "status": "pending"}

    def task_status(self, task_id):
        with self.runtime.database.transaction() as connection:
            self._expire(connection)
            row = connection.execute("SELECT * FROM extension_browser_tasks WHERE task_id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError("The browser task does not exist or has expired.")
            result = {"ok": True, "taskId": task_id, "status": row["state"]}
            if row["state"] in TERMINAL:
                result["result"] = json.loads(row["result_json"])
            return result

    def cancel_task(self, task_id):
        with self.runtime.database.transaction() as connection:
            connection.execute("UPDATE extension_browser_tasks SET state='failed',result_json=? WHERE task_id=? AND state IN ('pending','leased')",
                               (json.dumps(_failure(message="The acquisition was cancelled.", retryable=False)), task_id))
        return {"ok": True}

    async def lease(self, installation_id, version):
        # Validate external DNS outside a writer transaction, then CAS all
        # authority and the selected installation again before exposing content.
        with self.runtime.database.transaction() as connection:
            self._expire(connection)
            self._selected(connection, installation_id, version)
            row = connection.execute("SELECT * FROM extension_browser_tasks WHERE state='pending' ORDER BY created_at,task_id LIMIT 1").fetchone()
        if row is None:
            return {"ok": True, "status": "idle"}
        try:
            self._active_run(row["run_id"], workflow_id=row["workflow_id"], temporal_run_id=row["temporal_run_id"])
            await _public_browser_url(json.loads(row["request_json"])["url"], self.runtime)
        except AppError:
            self.cancel_task(row["task_id"])
            return {"ok": True, "status": "idle"}
        lease_id = str(uuid.uuid4())
        with self.runtime.database.transaction() as connection:
            self._expire(connection)
            self._selected(connection, installation_id, version)
            try:
                self._active_run(row["run_id"], workflow_id=row["workflow_id"], temporal_run_id=row["temporal_run_id"], connection=connection)
            except AppError:
                connection.execute("UPDATE extension_browser_tasks SET state='failed',result_json=? WHERE task_id=? AND state='pending'",
                                   (json.dumps(_failure(message="The parent action ended before lease admission.", retryable=False)), row["task_id"]))
                return {"ok": True, "status": "idle"}
            changed = connection.execute("UPDATE extension_browser_tasks SET state='leased',installation_id=?,lease_id=?,lease_deadline=? WHERE task_id=? AND state='pending' AND deadline>?",
                                         (installation_id, lease_id, min(row["deadline"], time.time() + row["timeout_ms"] / 1000), row["task_id"], time.time())).rowcount
            if not changed:
                return {"ok": True, "status": "idle"}
        return {"ok": True, "status": "task", "taskId": row["task_id"], "leaseId": lease_id,
                "timeoutMs": row["timeout_ms"], "request": json.loads(row["request_json"])}

    def lease_active(self, task_id, lease_id, installation_id, version):
        lease_id = _uuid(lease_id)
        with self.runtime.database.transaction() as connection:
            self._expire(connection)
            self._selected(connection, installation_id, version)
            row = connection.execute("SELECT * FROM extension_browser_tasks WHERE task_id=? AND state='leased' AND lease_id=? AND installation_id=?",
                                     (task_id, lease_id, installation_id)).fetchone()
            if not row:
                return False
            try:
                self._active_run(row["run_id"], workflow_id=row["workflow_id"], temporal_run_id=row["temporal_run_id"], connection=connection)
            except AppError:
                connection.execute("UPDATE extension_browser_tasks SET state='failed',result_json=? WHERE task_id=? AND state='leased'",
                                   (json.dumps(_failure(message="The parent action ended before lease validation.", retryable=False)), task_id))
                return False
        return True

    async def complete(self, task_id, body, installation_id, version):
        if not isinstance(body, dict) or set(body) != {"leaseId", "result"}:
            raise AppError("invalid_browser_completion", "The browser completion envelope is invalid.")
        lease_id = _uuid(body["leaseId"])
        if not self.lease_active(task_id, lease_id, installation_id, version):
            raise ConflictError("The browser lease is no longer active.")
        result = body["result"]
        if not isinstance(result, dict) or result.get("status") not in {"succeeded", "failed"}:
            raise AppError("invalid_browser_result", "A bounded browser acquisition result is required.")
        if result["status"] == "succeeded":
            if set(result) - {"status", "finalUrl", "statusCode", "contentType", "title", "browserUserAgent", "bodyText", "bodyHtml", "visibleApplyControls"}:
                raise AppError("invalid_browser_result", "Unsupported browser result fields.")
            await _public_browser_url(result.get("finalUrl"), self.runtime)
            for key in ("bodyText", "bodyHtml"):
                if key == "bodyText" or key in result:
                    if not isinstance(result.get(key), str) or len(result[key].encode()) > 4_000_000:
                        raise AppError("browser_response_too_large", "Browser result text exceeds the acquisition limit.")
            code = result.get("statusCode")
            if code is not None and (type(code) is not int or not 0 <= code <= 599):
                raise AppError("invalid_browser_status", "The browser HTTP status is invalid.")
            controls = result.get("visibleApplyControls", [])
            if not isinstance(controls, list) or len(controls) > 20:
                raise AppError("invalid_browser_result", "The visible application control list is invalid.")
            for control in controls:
                if not isinstance(control, dict) or set(control) != {"href", "jobId"}:
                    raise AppError("invalid_browser_result", "The visible application control is invalid.")
                _text(control["href"], maximum=2048, label="application control URL")
                _text(control["jobId"], maximum=200, label="application control job ID")
            for key, maximum in (("contentType", 300), ("title", 500), ("browserUserAgent", 500)):
                if key in result and (not isinstance(result[key], str) or len(result[key]) > maximum):
                    raise AppError("invalid_browser_result", "Browser response metadata is invalid.")
        elif set(result) != {"status", "errorCode", "message", "retryable"} or result.get("errorCode") not in {"navigation_failed", "request_failed", "response_too_large", "unsafe_redirect", "unsupported_page"} or type(result.get("retryable")) is not bool:
            raise AppError("invalid_browser_failure", "The browser failure envelope is invalid.")
        if result["status"] == "failed":
            _text(result.get("message"), maximum=500, label="failure message")
        # This repeats cancellation/selection after the asynchronous URL check.
        if not self.lease_active(task_id, lease_id, installation_id, version):
            raise ConflictError("The browser lease changed before its result was saved.")
        with self.runtime.database.transaction() as connection:
            self._selected(connection, installation_id, version)
            row = connection.execute("SELECT run_id,workflow_id,temporal_run_id FROM extension_browser_tasks WHERE task_id=?", (task_id,)).fetchone()
            if row is None:
                raise ConflictError("The browser task is no longer available.")
            self._active_run(row["run_id"], workflow_id=row["workflow_id"], temporal_run_id=row["temporal_run_id"], connection=connection)
            changed = connection.execute("UPDATE extension_browser_tasks SET state=?,result_json=? WHERE task_id=? AND state='leased' AND lease_id=? AND installation_id=? AND deadline>?",
                                         (result["status"], json.dumps(result), task_id, lease_id, installation_id, time.time())).rowcount
            if not changed:
                raise ConflictError("The browser lease is no longer active.")
        return {"ok": True}

    async def fetch_public(self, request, context, source_id, timeout_ms=60000):
        if context.cancelled():
            raise AppError("action_cancelled", "The browser acquisition was cancelled.", 409)
        run = self._active_run(context.run_id)
        if not run.get("workflowId") or not run.get("temporalRunId"):
            raise AppError("durable_browser_action_required", "Live browser acquisition requires a durable worker action.", 409)
        task_id = "browser:" + uuid.uuid4().hex
        await self.create_task({"taskId": task_id, "runId": context.run_id, "workflowId": run["workflowId"],
                                "temporalRunId": run["temporalRunId"], "sourceId": source_id,
                                "request": request, "timeoutMs": timeout_ms})
        try:
            deadline = time.monotonic() + timeout_ms / 1000
            while time.monotonic() < deadline:
                if context.cancelled():
                    raise AppError("action_cancelled", "The browser acquisition was cancelled.", 409)
                context.heartbeat({"browserTaskId": task_id})
                status = self.task_status(task_id)
                if status["status"] in TERMINAL:
                    result = status["result"]
                    if result["status"] != "succeeded":
                        raise AppError(result["errorCode"], "The selected Chrome acquisition failed.", 409,
                                       {"retryable": result.get("retryable", False)})
                    return {"body_text": result["bodyText"], "body_html": result.get("bodyHtml"),
                            "status_code": result.get("statusCode"), "final_url": result["finalUrl"],
                            "title": result.get("title", ""), "browser_user_agent": result.get("browserUserAgent", ""),
                            "visible_apply_controls": result.get("visibleApplyControls")}
                await asyncio.sleep(0.2)
            raise AppError("browser_timeout", "The selected Chrome acquisition timed out.", 504)
        finally:
            self.cancel_task(task_id)


def build_extension_routes(runtime, jobs, *, broker=None, application=None):
    broker = broker or ExtensionBroker(runtime)
    if application is not None:
        broker.bind(application)
    capability = CapabilityToken(runtime.workspace)

    def worker_only(request):
        if request.headers.get("origin") or request.headers.get("referer") or request.headers.get("sec-fetch-site"):
            raise AppError("discovery_browser_worker_required", "Only the local worker may access browser task administration.", 403)
        if not capability.verify(request.headers.get("authorization")):
            raise AppError("unauthorized_browser_worker", "Local worker authorization is required.", 403)

    def identity(request):
        return (request.headers.get("x-jobctrl-extension-installation", ""),
                request.headers.get("x-jobctrl-extension-version", "unknown")[:80])

    async def token(request):
        if request.scope.get("state", {}).get("original_method", request.method) == "HEAD":
            return _json({"ok": True})
        if request.method == "POST":
            value = capability.rotate()
            try:
                broker.disconnect()
            except Exception:
                raise AppError("extension_rotation_partial", "The pairing token changed but installation cleanup could not be completed; recheck pairing status.",
                               503, {"tokenChanged": True, "installationDisconnect": "pending"}) from None
        else:
            value = capability.read_or_create()
        return _json({"ok": True, "token": value, "tokenPath": str(capability.path), "created": False})

    async def auth(request):
        capabilities = ["capture"]
        if application is not None and "applications" in application.services:
            capabilities.append("autofill_read")
        if application is not None and "discovery" in application.services:
            capabilities.append("discovery_browser")
        return _json({"ok": True, "authenticated": True, "capabilities": capabilities})

    async def status(request):
        if request.scope.get("state", {}).get("original_method", request.method) == "HEAD":
            return _json({"ok": True})
        return _json(broker.status())

    async def claim(request):
        return _json(broker.claim(await request.json()))

    async def next_task(request):
        if request.scope.get("state", {}).get("original_method", request.method) == "HEAD":
            return _json({"ok": True})
        return _json(await broker.lease(*identity(request)))

    async def lease(request):
        if request.scope.get("state", {}).get("original_method", request.method) == "HEAD":
            return _json({"ok": True})
        return _json({"ok": True, "active": broker.lease_active(request.path_params["task_id"], request.query_params.get("leaseId"), *identity(request))})

    async def create_task(request):
        worker_only(request)
        # The parent is already an accepted Temporal action. This endpoint
        # acknowledges transport queueing; it does not start a second workflow.
        return _json(await broker.create_task(await request.json()), 201)

    async def task(request):
        worker_only(request)
        task_id = request.path_params["task_id"]
        if request.scope.get("state", {}).get("original_method", request.method) == "HEAD":
            with runtime.database.connect() as connection:
                if connection.execute("SELECT 1 FROM extension_browser_tasks WHERE task_id=?", (task_id,)).fetchone() is None:
                    raise NotFoundError("The browser task does not exist.")
            return _json({"ok": True})
        return _json(broker.cancel_task(task_id) if request.method == "DELETE" else broker.task_status(task_id))

    async def complete(request):
        return _json(await broker.complete(request.path_params["task_id"], await request.json(), *identity(request)))

    async def capture(request):
        body = await request.json()
        if not isinstance(body, dict) or set(body) - {"captureId", "originatingUrl", "captureMode", "capturedUrl", "contentText", "contentHtmlBase64", "note", "futureManualActionRequired", "captureClient", "extensionVersion"}:
            raise AppError("invalid_extension_capture", "The capture envelope is invalid.")
        capture_id = _identifier(body.get("captureId"), maximum=120)
        origin = _url(body.get("originatingUrl"))
        mode = body.get("captureMode")
        if mode not in {"current_page", "saved_html", "copied_url", "pasted_text", "email_import"}:
            raise AppError("invalid_capture_mode", "The capture mode is unsupported.")
        if type(body.get("futureManualActionRequired", False)) is not bool or body.get("captureClient", "browser_extension") != "browser_extension":
            raise AppError("invalid_extension_capture", "The capture provenance is invalid.")
        url = _url(body.get("capturedUrl", origin))
        text = body.get("contentText", "")
        if not isinstance(text, str) or len(text) > 200000:
            raise AppError("invalid_extension_capture", "Captured text exceeds the limit.")
        html = None
        if body.get("contentHtmlBase64") is not None:
            try:
                encoded = body["contentHtmlBase64"]
                if not isinstance(encoded, str) or len(encoded) > 8000000:
                    raise ValueError()
                html = base64.b64decode(encoded, validate=True).decode("utf-8")
            except (ValueError, UnicodeError):
                raise AppError("invalid_capture_html", "Captured HTML must be bounded UTF-8 base64.") from None
        if not text and not html and "capturedUrl" not in body:
            raise AppError("empty_extension_capture", "A capture URL, text or HTML is required.")
        item_id = "extension:" + hashlib.sha256(capture_id.encode()).hexdigest()[:32]
        input_hash = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        owner_id = uuid.uuid4().hex
        with runtime.database.transaction() as connection:
            row = connection.execute("SELECT * FROM extension_capture_receipts WHERE capture_id=?", (capture_id,)).fetchone()
            if row:
                if row["input_hash"] != input_hash:
                    raise AppError("extension_capture_superseded", "This capture ID is bound to different saved content.", 409)
                if row["state"] == "accepted":
                    return _json(json.loads(row["acknowledgement_json"]))
                if row["state"] == "importing" and row["lease_deadline"] > time.time():
                    raise AppError("extension_capture_in_progress", "This capture is still being imported.", 409)
                connection.execute("UPDATE extension_capture_receipts SET owner_id=?,state='importing',lease_deadline=? WHERE capture_id=?", (owner_id, time.time() + 120, capture_id))
            else:
                connection.execute("INSERT INTO extension_capture_receipts VALUES(?,?,?,'importing',?,NULL)", (capture_id, input_hash, owner_id, time.time() + 120))

        def guard(connection):
            row = connection.execute("SELECT owner_id,state FROM extension_capture_receipts WHERE capture_id=?", (capture_id,)).fetchone()
            if row is None or row["owner_id"] != owner_id or row["state"] != "importing":
                raise ConflictError("A newer capture attempt owns this receipt.")

        try:
            snapshot = jobs.read_capture_receipt(item_id)
            if snapshot is None:
                snapshot = await jobs.capture_external({"url": url, "html": html, "text": text, "captureId": item_id,
                                                        "source_id": "extension", "provenance": {"sourceKind": "user_mediated_capture", "originatingUrl": origin, "captureMode": mode, "futureManualActionRequired": body.get("futureManualActionRequired", False), "captureClient": "browser_extension", "extensionVersion": body.get("extensionVersion", "unknown")}}, guard=guard)
            acknowledgement = {"ok": True, "itemId": item_id, "jobKey": snapshot["job_id"], "importedAt": snapshot.get("observed_at") or _iso(time.time()),
                               "provenance": {"sourceKind": "user_mediated_capture", "originatingUrl": origin, "captureMode": mode,
                                              "futureManualActionRequired": body.get("futureManualActionRequired", False),
                                              "captureClient": "browser_extension", "extensionVersion": body.get("extensionVersion", "unknown")}}
            with runtime.database.transaction() as connection:
                guard(connection)
                connection.execute("UPDATE extension_capture_receipts SET state='accepted',acknowledgement_json=? WHERE capture_id=? AND owner_id=?", (json.dumps(acknowledgement), capture_id, owner_id))
            return _json(acknowledgement)
        except BaseException:
            with runtime.database.transaction() as connection:
                connection.execute("UPDATE extension_capture_receipts SET state='failed',lease_deadline=0 WHERE capture_id=? AND owner_id=? AND state='importing'", (capture_id, owner_id))
            raise

    return (
        Route("/v1/extension/pairing-token", token, methods=["GET"]),
        Route("/v1/extension/pairing-token/rotate", token, methods=["POST"]),
        Route("/v1/extension/auth/status", auth, methods=["GET", "POST"]),
        Route("/v1/extension/captures", capture, methods=["POST"]),
        Route("/v1/discovery/browser-extension/status", status, methods=["GET"]),
        Route("/v1/extension/discovery/claim", claim, methods=["POST"]),
        Route("/v1/extension/discovery/tasks/next", next_task, methods=["GET"]),
        Route("/v1/extension/discovery/tasks/{task_id}/lease", lease, methods=["GET"]),
        Route("/v1/extension/discovery/tasks/{task_id}/result", complete, methods=["POST"]),
        Route("/v1/extension/discovery/tasks", create_task, methods=["POST"]),
        Route("/v1/extension/discovery/tasks/{task_id}", task, methods=["GET", "DELETE"]),
    )
