"""Owned apply-run MCP tools for reviewed local artifacts."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

from jobctrl import __version__
from jobctrl.infrastructure.captcha import (
    CaptchaChallenge,
    CaptchaSolveResult,
    solve_with_capsolver,
)


def main() -> None:
    server = ApplyToolsMcpServer()
    for line in sys.stdin:
        if not line.strip():
            continue
        response = server.handle_json(line)
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()


class ApplyToolsMcpServer:
    def __init__(
        self,
        *,
        upload_dir: str | os.PathLike[str] | None = None,
        cdp_endpoint: str | None = None,
        approved_application_url: str | None = None,
        uploader: Any | None = None,
        credential_resolver: Any | None = None,
        credential_typer: Any | None = None,
        captcha_key_resolver: Any | None = None,
        captcha_solver: Any | None = None,
        captcha_injector: Any | None = None,
    ) -> None:
        raw_upload_dir = upload_dir or os.environ.get("JOBCTRL_APPLY_UPLOAD_DIR")
        self._upload_dir = Path(raw_upload_dir).expanduser() if raw_upload_dir else None
        self._cdp_endpoint = cdp_endpoint or os.environ.get("JOBCTRL_APPLY_CDP_ENDPOINT", "")
        self._approved_application_url = (
            approved_application_url
            if approved_application_url is not None
            else os.environ.get("JOBCTRL_APPLY_APPROVED_APPLICATION_URL", "")
        )
        self._uploader = uploader or _upload_file_to_current_input
        self._credential_resolver = credential_resolver or _profile_credential
        self._credential_typer = credential_typer or _type_credential_into_active_field
        self._captcha_key_resolver = captcha_key_resolver or _captcha_api_key
        self._captcha_solver = captcha_solver or _solve_with_capsolver
        self._captcha_injector = captcha_injector or _inject_captcha_token

    def handle_json(self, line: str) -> dict[str, Any] | None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return _error(None, -32700, "Parse error")
        if not isinstance(request, dict):
            return _error(None, -32600, "Invalid Request")
        if "id" not in request:
            return None
        method = request.get("method")
        try:
            if method == "initialize":
                result = {
                    "protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "jobctrl-apply-tools", "version": __version__},
                }
            elif method == "tools/list":
                result = {"tools": self._tools()}
            elif method == "tools/call":
                result = self._call_tool(request.get("params") or {})
            elif method in {"resources/list", "prompts/list"}:
                result = {"resources" if method == "resources/list" else "prompts": []}
            else:
                return _error(request.get("id"), -32601, f"Method not found: {method}")
            return {"jsonrpc": "2.0", "id": request.get("id"), "result": result}
        except Exception as exc:  # noqa: BLE001 - MCP returns tool errors as JSON-RPC errors
            return _error(request.get("id"), -32000, str(exc))

    def _call_tool(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        if name == "upload_artifact":
            return self._call_upload_artifact(args)
        if name == "type_credential":
            return self._call_type_credential(args)
        if name == "solve_captcha":
            return self._call_solve_captcha(args)
        raise ValueError(f"Unknown apply tool: {name}")

    def _call_upload_artifact(self, args: dict[str, Any]) -> dict[str, Any]:
        kind = str(args.get("kind") or "")
        artifact = self._resolve_artifact(kind)
        approved_url = self._approved_application_url.strip()
        if not approved_url:
            raise ValueError("upload_artifact approved application URL is not configured")
        upload_result = self._uploader(self._cdp_endpoint, artifact, approved_url)
        destination_url = _upload_destination_url(upload_result)
        _record_artifact_upload(
            self._upload_dir,
            {
                "kind": kind,
                "filename": artifact.name,
                "destination_url": destination_url,
            },
        )
        payload = {"ok": True, "kind": kind, "filename": artifact.name}
        if destination_url:
            payload["destination_url"] = destination_url
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(payload, ensure_ascii=False),
                }
            ]
        }

    def _call_type_credential(self, args: dict[str, Any]) -> dict[str, Any]:
        kind = str(args.get("kind") or "")
        credential = self._credential_resolver(kind)
        if not credential:
            raise ValueError(f"{kind or 'credential'} is not configured")
        self._credential_typer(self._cdp_endpoint, credential)
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({"ok": True, "kind": kind, "typed": True}),
                }
            ]
        }

    def _call_solve_captcha(self, args: dict[str, Any]) -> dict[str, Any]:
        api_key = self._captcha_key_resolver()
        if not api_key:
            raise ValueError("CAPTCHA solver is not configured")
        challenge = _captcha_challenge_from_args(args)
        result = self._captcha_solver(api_key, challenge)
        if not isinstance(result, CaptchaSolveResult):
            result = CaptchaSolveResult(token=str(result or ""), kind=challenge.kind, elapsed_s=0.0)
        if not result.token:
            raise ValueError("CAPTCHA solver returned no token")
        self._captcha_injector(self._cdp_endpoint, challenge, result.token)
        payload = {
            "solved": True,
            "kind": challenge.kind,
            "elapsed_s": result.elapsed_s,
        }
        if result.cost_usd is not None:
            payload["cost_usd"] = result.cost_usd
        _record_captcha_usage(self._upload_dir, payload)
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(payload, sort_keys=True),
                }
            ]
        }

    def _resolve_artifact(self, kind: str) -> Path:
        patterns = {
            "resume": ("*Resume.pdf",),
            "cover_letter": ("*Cover_Letter.pdf",),
        }
        if kind not in patterns:
            raise ValueError("upload_artifact kind must be resume or cover_letter")
        if self._upload_dir is None:
            raise ValueError("upload_artifact upload directory is not configured")
        root = self._upload_dir.resolve()
        candidates: list[Path] = []
        for pattern in patterns[kind]:
            candidates.extend(sorted(root.glob(pattern)))
        for candidate in candidates:
            resolved = candidate.resolve()
            if not resolved.is_file():
                continue
            try:
                resolved.relative_to(root)
            except ValueError as exc:
                raise ValueError("artifact path escaped the run upload directory") from exc
            return resolved
        raise ValueError(f"no reviewed {kind} artifact exists for this run")

    def _tools(self) -> list[dict[str, Any]]:
        return _tools(captcha_configured=bool(self._captcha_key_resolver()))


def _tools(*, captcha_configured: bool | None = None) -> list[dict[str, Any]]:
    tools = [
        {
            "name": "upload_artifact",
            "description": "Upload the reviewed resume or cover-letter artifact for this apply run. The model supplies only the artifact kind, never a path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["resume", "cover_letter"],
                    }
                },
                "required": ["kind"],
                "additionalProperties": False,
            },
        },
        {
            "name": "type_credential",
            "description": "Type a locally stored credential into the currently focused credential field. The credential value is resolved by this server and is never returned to the model.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["job_site_password"],
                    }
                },
                "required": ["kind"],
                "additionalProperties": False,
            },
        },
    ]
    configured = bool(_captcha_api_key()) if captcha_configured is None else captcha_configured
    if configured:
        tools.insert(
            1,
            {
                "name": "solve_captcha",
                "description": "Solve a supported CAPTCHA through the local configured solver. Provider keys and solver tokens are never returned to the model.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["recaptcha_v2", "hcaptcha", "turnstile"],
                        },
                        "sitekey": {"type": "string", "minLength": 1},
                        "page_url": {"type": "string", "minLength": 1},
                    },
                    "required": ["kind", "sitekey", "page_url"],
                    "additionalProperties": False,
                },
            },
        )
    return tools


def _profile_credential(kind: str) -> str:
    if kind != "job_site_password":
        raise ValueError("type_credential kind must be job_site_password")

    raw_db_path = os.environ.get("JOBCTRL_APPLY_PROFILE_DB_PATH")
    if raw_db_path:
        db_path = Path(raw_db_path).expanduser()
    else:
        from jobctrl import config

        db_path = config.DB_PATH

    if not db_path.exists():
        raise ValueError("job-site password credential is not configured")

    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                """
                SELECT personal_password
                  FROM candidate_profiles
                 WHERE tenant_id = 'local'
                   AND profile_id = 'default'
                """
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise ValueError("job-site password credential is not configured") from exc

    password = str(row[0] or "") if row else ""
    if not password:
        raise ValueError("job-site password credential is not configured")
    return password


def _captcha_api_key() -> str:
    value = os.environ.get("CAPSOLVER_API_KEY", "").strip()
    return value


def _solve_with_capsolver(api_key: str, challenge: CaptchaChallenge) -> CaptchaSolveResult:
    return solve_with_capsolver(api_key, challenge)


def _captcha_challenge_from_args(args: dict[str, Any]) -> CaptchaChallenge:
    kind = str(args.get("kind") or "")
    sitekey = str(args.get("sitekey") or "")
    page_url = str(args.get("page_url") or "")
    if kind not in {"recaptcha_v2", "hcaptcha", "turnstile"}:
        raise ValueError("solve_captcha kind must be recaptcha_v2, hcaptcha, or turnstile")
    if not sitekey.strip():
        raise ValueError("solve_captcha sitekey is required")
    if not page_url.strip():
        raise ValueError("solve_captcha page_url is required")
    return CaptchaChallenge(kind=kind, sitekey=sitekey, page_url=page_url)


def _record_captcha_usage(upload_dir: Path | None, payload: dict[str, Any]) -> None:
    if upload_dir is None:
        return
    upload_dir.mkdir(parents=True, exist_ok=True)
    event = {
        "event_type": "CaptchaSolveCompleted",
        "payload": payload,
    }
    with (upload_dir / "captcha_solve_events.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, sort_keys=True) + "\n")


def _record_artifact_upload(upload_dir: Path | None, payload: dict[str, Any]) -> None:
    if upload_dir is None:
        return
    upload_dir.mkdir(parents=True, exist_ok=True)
    event = {
        "event_type": "ApplyArtifactUpload",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    with (upload_dir / "artifact_upload_events.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, sort_keys=True) + "\n")


def _inject_captcha_token(cdp_endpoint: str, challenge: CaptchaChallenge, token: str) -> None:
    escaped = json.dumps(token)
    _evaluate_on_page(
        cdp_endpoint,
        f"""
(() => {{
  const token = {escaped};
  const names = ["g-recaptcha-response", "h-captcha-response", "cf-turnstile-response"];
  for (const name of names) {{
    let field = document.querySelector(`textarea[name="${{name}}"], input[name="${{name}}"]`);
    if (!field) {{
      field = document.createElement("textarea");
      field.name = name;
      field.style.display = "none";
      document.body.appendChild(field);
    }}
    field.value = token;
    field.dispatchEvent(new Event("input", {{bubbles: true}}));
    field.dispatchEvent(new Event("change", {{bubbles: true}}));
  }}
  return true;
}})()
""",
    )


def _type_credential_into_active_field(cdp_endpoint: str, credential: str) -> None:
    ws_url = _first_page_ws_url(cdp_endpoint)
    try:
        import websocket
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("websocket-client is required for type_credential") from exc
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    counter = 0

    def send(method: str, params: dict[str, Any] | None = None) -> int:
        nonlocal counter
        counter += 1
        ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
        return counter

    def response(message_id: int) -> dict[str, Any]:
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message

    try:
        guard = response(
            send(
                "Runtime.evaluate",
                {
                    "returnByValue": True,
                    "expression": """
(() => {
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLInputElement)) {
    return {ok: false};
  }
  const type = (el.getAttribute("type") || "text").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  const name = (el.getAttribute("name") || "").toLowerCase();
  const id = (el.getAttribute("id") || "").toLowerCase();
  return {
    ok: type === "password" || autocomplete.includes("password") ||
      name.includes("password") || id.includes("password")
  };
})()
""",
                },
            )
        )
        active = guard.get("result", {}).get("result", {}).get("value") or {}
        if not active.get("ok"):
            raise RuntimeError("active element is not a password credential field")
        response(send("Input.insertText", {"text": credential}))
    finally:
        ws.close()


def _evaluate_on_page(cdp_endpoint: str, expression: str) -> Any:
    ws_url = _first_page_ws_url(cdp_endpoint)
    try:
        import websocket
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("websocket-client is required for apply tools") from exc
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    try:
        ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expression, "returnByValue": True},
                }
            )
        )
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message.get("result", {}).get("result", {}).get("value")
    finally:
        ws.close()


def _upload_file_to_current_input(cdp_endpoint: str, path: Path, approved_application_url: str) -> dict[str, str]:
    ws_url = _first_page_ws_url(cdp_endpoint)
    try:
        import websocket
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("websocket-client is required for upload_artifact") from exc
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    counter = 0

    def send(method: str, params: dict[str, Any] | None = None) -> int:
        nonlocal counter
        counter += 1
        ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
        return counter

    def response(message_id: int) -> dict[str, Any]:
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message

    marker = f"jobctrl-upload-{uuid.uuid4().hex}"
    try:
        response(send("DOM.enable"))
        state = response(
            send(
                "Runtime.evaluate",
                {
                    "returnByValue": True,
                    "expression": _upload_input_guard_expression(marker),
                },
            )
        )
        guard = state.get("result", {}).get("result", {}).get("value") or {}
        if not isinstance(guard, dict):
            raise RuntimeError("could not inspect current upload destination")
        destination_url = str(guard.get("href") or "")
        _assert_approved_upload_destination(destination_url, approved_application_url)
        if not guard.get("ok"):
            reason = str(guard.get("reason") or "no visible file input is currently available")
            raise RuntimeError(reason)
        root = response(send("DOM.getDocument", {"depth": 1}))
        root_id = root.get("result", {}).get("root", {}).get("nodeId")
        if not root_id:
            raise RuntimeError("could not inspect current page DOM")
        query = response(
            send(
                "DOM.querySelector",
                {
                    "nodeId": root_id,
                    "selector": f'input[type=file][data-jobctrl-upload-target="{marker}"]',
                },
            )
        )
        node_id = query.get("result", {}).get("nodeId")
        if not node_id:
            raise RuntimeError("selected file input is no longer available")
        response(send("DOM.setFileInputFiles", {"nodeId": node_id, "files": [str(path)]}))
        return {"destination_url": destination_url}
    finally:
        try:
            response(
                send(
                    "Runtime.evaluate",
                    {"expression": _clear_upload_input_marker_expression(marker)},
                )
            )
        except Exception:  # noqa: BLE001 - marker cleanup must not mask upload errors
            pass
        ws.close()


def _upload_input_guard_expression(marker: str) -> str:
    escaped_marker = json.dumps(marker)
    return f"""
(() => {{
  const marker = {escaped_marker};
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const isVisible = (input) => {{
    const style = window.getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    return !input.disabled &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0;
  }};
  const visible = inputs.filter(isVisible);
  if (visible.length === 0) {{
    return {{
      ok: false,
      href: window.location.href,
      reason: "no visible file input is currently available"
    }};
  }}
  let selected = visible[0];
  if (visible.length > 1) {{
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) ||
        (active.getAttribute("type") || "").toLowerCase() !== "file" ||
        !visible.includes(active)) {{
      return {{
        ok: false,
        href: window.location.href,
        reason: "multiple visible file inputs are available; click the intended upload control first"
      }};
    }}
    selected = active;
  }}
  selected.setAttribute("data-jobctrl-upload-target", marker);
  return {{ok: true, href: window.location.href}};
}})()
"""


def _clear_upload_input_marker_expression(marker: str) -> str:
    escaped_marker = json.dumps(marker)
    return f"""
(() => {{
  const input = document.querySelector(`[data-jobctrl-upload-target=${{CSS.escape({escaped_marker})}}]`);
  if (input) {{
    input.removeAttribute("data-jobctrl-upload-target");
  }}
  return true;
}})()
"""


def _upload_destination_url(result: Any) -> str:
    if isinstance(result, dict):
        return str(result.get("destination_url") or "")
    return ""


def _assert_approved_upload_destination(destination_url: str, approved_application_url: str) -> None:
    destination_origin = _url_origin(destination_url)
    approved_origin = _url_origin(approved_application_url)
    if not approved_origin:
        raise ValueError("upload_artifact approved application URL is invalid")
    if not destination_origin:
        raise RuntimeError("current upload destination is not an HTTP(S) page")
    if destination_origin != approved_origin:
        raise RuntimeError("current upload destination does not match the approved application origin")


def _url_origin(value: str) -> str:
    try:
        parsed = urlparse(value.strip())
        port = parsed.port
    except ValueError:
        return ""
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return ""
    scheme = parsed.scheme.lower()
    host = parsed.hostname.rstrip(".").lower()
    effective_port = port or (443 if scheme == "https" else 80)
    return f"{scheme}://{host}:{effective_port}"


def _first_page_ws_url(cdp_endpoint: str) -> str:
    parsed = urlparse(cdp_endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("CDP endpoint is not configured")
    with urlopen(f"{cdp_endpoint.rstrip('/')}/json/list", timeout=3) as response:
        targets = json.loads(response.read().decode("utf-8"))
    for target in targets:
        if isinstance(target, dict) and target.get("type") == "page":
            ws_url = str(target.get("webSocketDebuggerUrl") or "")
            if ws_url:
                return ws_url
    raise RuntimeError("no page target is available for artifact upload")


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


if __name__ == "__main__":
    main()
