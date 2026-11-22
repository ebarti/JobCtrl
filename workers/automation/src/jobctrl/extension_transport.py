"""Browser extension pairing and user-invoked posting capture."""

from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit


from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError, ConflictError
from jobctrl.app.security import CapabilityToken

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


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def build_extension_routes(runtime, jobs, *, application):
    runtime.database.initialize_feature("extension", SCHEMA)
    capability = CapabilityToken(runtime.workspace)

    async def token(request):
        if request.scope.get("state", {}).get("original_method", request.method) == "HEAD":
            return _json({"ok": True})
        if request.method == "POST":
            value = capability.rotate()
        else:
            value = capability.read_or_create()
        return _json({"ok": True, "token": value, "tokenPath": str(capability.path), "created": False})

    async def auth(request):
        capabilities = ["capture"]
        if application is not None and "applications" in application.services:
            capabilities.append("autofill_read")
        return _json({"ok": True, "authenticated": True, "capabilities": capabilities})

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
    )
