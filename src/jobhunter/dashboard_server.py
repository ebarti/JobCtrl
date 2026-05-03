"""Local live dashboard HTTP server."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import threading
import time
import webbrowser
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from rich.console import Console

from jobhunter.actions import LocalActionRequest, run_local_action
from jobhunter import config
from jobhunter.database import close_connection, get_connection
from jobhunter.pipeline import STAGE_ORDER
from jobhunter.profile_import import MAX_IMPORT_BYTES, import_resume_pdf
from jobhunter.resume_profile import (
    get_custom_tailoring_prompt,
    get_tailoring_policy,
    get_writing_style,
    require_resume_master,
)
from jobhunter.scoring.pdf import (
    build_latex_template_from_style,
    ensure_latex_template,
    load_resume_style,
    save_latex_template,
    save_resume_style,
)
from jobhunter.state import (
    build_dashboard_data,
    build_dashboard_job_detail,
    delete_dashboard_jobs,
    list_dashboard_artifacts,
    list_dashboard_jobs,
    reset_job_stage,
)
from jobhunter.view import dashboard_html

console = Console()


def _profile_for_editor(profile: Any) -> Any:
    """Add editor defaults without changing user-authored resume facts."""
    if not isinstance(profile, dict):
        return profile
    resume = profile.get("resume")
    if not isinstance(resume, dict):
        return profile
    rules = resume.setdefault("tailoring_rules", {})
    if isinstance(rules, dict):
        rules.setdefault("required_bullets_by_experience_id", {})
        rules["tailoring_policy"] = get_tailoring_policy(profile)
        rules["writing_style"] = get_writing_style(profile)
        rules.setdefault("custom_tailoring_prompt", get_custom_tailoring_prompt(profile))
    return profile


class DashboardHTTPServer(ThreadingHTTPServer):
    """Threading server carrying small bits of app configuration."""

    allow_reuse_address = True

    def __init__(self, server_address, handler_class, *, min_score: int | None = None):
        super().__init__(server_address, handler_class)
        self.dashboard_settings = config.load_dashboard_settings()
        self.command_actions: dict[str, dict[str, Any]] = {}
        self.command_actions_lock = threading.Lock()
        if min_score is not None:
            self.dashboard_settings = config.normalize_dashboard_settings(
                {"min_fit_score": min_score},
                base=self.dashboard_settings,
            )


class DashboardHandler(BaseHTTPRequestHandler):
    """HTTP handler for the live JobHunter dashboard."""

    server: DashboardHTTPServer

    def _fresh_connection(self):
        """Open the DB fresh for this request.

        The dashboard is a local operator view, and users may migrate or swap
        the SQLite file while the server is running. Closing the thread-local
        handle before each request prevents the API from reading a stale file.
        """
        close_connection()
        return get_connection()

    def _dashboard_data(self) -> dict[str, Any]:
        return build_dashboard_data(
            self._fresh_connection(),
            dashboard_settings=self.server.dashboard_settings,
            include_lists=False,
        )

    def _command_data(self) -> dict[str, Any]:
        return build_dashboard_data(
            self._fresh_connection(),
            dashboard_settings=self.server.dashboard_settings,
            include_lists=True,
        )

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/":
                self._send_html(dashboard_html(live=True))
            elif parsed.path == "/api/health":
                self._send_json(
                    {
                        "ok": True,
                        "db_path": str(config.DB_PATH),
                        "bind": f"{self.server.server_address[0]}:{self.server.server_address[1]}",
                    }
                )
            elif parsed.path == "/api/dashboard":
                self._send_json(self._dashboard_data())
            elif parsed.path == "/api/jobs":
                self._handle_list_jobs(parsed.query)
            elif parsed.path == "/api/artifacts":
                self._handle_list_artifacts(parsed.query)
            elif parsed.path == "/api/job":
                self._handle_get_job(parsed.query)
            elif parsed.path == "/api/action":
                self._handle_get_action(parsed.query)
            elif parsed.path == "/api/profile-config":
                self._handle_get_profile_config()
            else:
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", f"No route for {parsed.path}")
        except Exception as exc:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "server_error", str(exc))

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/config":
                self._handle_update_config()
            elif parsed.path == "/api/profile-config":
                self._handle_update_profile_config()
            else:
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", f"No route for {parsed.path}")
        except ValueError as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, "bad_request", str(exc))
        except Exception as exc:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "server_error", str(exc))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/retry":
                self._handle_retry()
            elif parsed.path == "/api/command":
                self._handle_command()
            elif parsed.path == "/api/open-artifact":
                self._handle_open_artifact()
            elif parsed.path == "/api/profile-import":
                self._handle_profile_import()
            else:
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", f"No route for {parsed.path}")
        except ValueError as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, "bad_request", str(exc))
        except Exception as exc:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "server_error", str(exc))

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/jobs":
                self._handle_delete_jobs()
            else:
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", f"No route for {parsed.path}")
        except ValueError as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, "bad_request", str(exc))
        except Exception as exc:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "server_error", str(exc))

    def _handle_get_job(self, query: str) -> None:
        params = parse_qs(query)
        url = (params.get("url") or [""])[0]
        if not url:
            self._send_error(HTTPStatus.BAD_REQUEST, "missing_url", "Query parameter 'url' is required.")
            return
        detail = build_dashboard_job_detail(
            self._fresh_connection(),
            url,
            dashboard_settings=self.server.dashboard_settings,
        )
        if detail is None:
            self._send_error(HTTPStatus.NOT_FOUND, "job_not_found", f"No job detail for {url}")
            return
        self._send_json(detail)

    def _handle_list_jobs(self, query: str) -> None:
        params = parse_qs(query)
        self._send_json(
            list_dashboard_jobs(
                self._fresh_connection(),
                page=_int_param(params, "page", 1),
                page_size=_int_param(params, "page_size", 50),
                sort=_str_param(params, "sort", "discovered_at"),
                direction=_str_param(params, "dir", "desc"),
                query=_str_param(params, "q", ""),
                kind=_str_param(params, "kind", "all"),
                filter_stage=_str_param(params, "filter_stage", ""),
                filter_state=_str_param(params, "filter_state", ""),
                current_stage=_str_param(params, "current_stage", "all"),
                dashboard_settings=self.server.dashboard_settings,
            )
        )

    def _handle_list_artifacts(self, query: str) -> None:
        params = parse_qs(query)
        self._send_json(
            list_dashboard_artifacts(
                self._fresh_connection(),
                page=_int_param(params, "page", 1),
                page_size=_int_param(params, "page_size", 50),
                sort=_str_param(params, "sort", "created_at"),
                direction=_str_param(params, "dir", "desc"),
                query=_str_param(params, "q", ""),
                status=_str_param(params, "status", "all"),
            )
        )

    def _handle_delete_jobs(self) -> None:
        payload = self._read_json()
        urls = payload.get("urls")
        filters = payload.get("filters")
        if urls is not None and not isinstance(urls, list):
            raise ValueError("urls must be a list.")
        if filters is not None and not isinstance(filters, dict):
            raise ValueError("filters must be an object.")
        confirm_count = payload.get("confirm_count")
        self._send_json(
            delete_dashboard_jobs(
                self._fresh_connection(),
                urls=urls,
                filters=filters,
                confirm_count=int(confirm_count) if confirm_count is not None else None,
                dashboard_settings=self.server.dashboard_settings,
            )
        )

    def _handle_retry(self) -> None:
        payload = self._read_json()
        stage = str(payload.get("stage") or "")
        url = str(payload.get("url") or "")
        reset_attempts = bool(payload.get("reset_attempts", False))
        if not stage or not url:
            raise ValueError("'stage' and 'url' are required.")
        job_url = reset_job_stage(self._fresh_connection(), url, stage, reset_attempts=reset_attempts)
        self._send_json({"ok": True, "job_url": job_url, "stage": stage, "reset_attempts": reset_attempts})

    def _handle_command(self) -> None:
        payload = self._read_json()
        command = str(payload.get("cmd") or "").strip()
        if not command:
            raise ValueError("'cmd' is required.")

        action = _parse_dashboard_command(command, self._command_data())
        if action["mode"] == "noop":
            self._send_json(
                {
                    "ok": True,
                    "cmd": command,
                    "mode": "noop",
                    "message": action["message"],
                    "output": action["message"],
                }
            )
            return

        if action["mode"] == "capture":
            args = _dashboard_command_args(action["argv"])
            completed = subprocess.run(
                args,
                cwd=_project_root(),
                env=_command_env(),
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            output = "\n".join(part for part in (completed.stdout, completed.stderr) if part).strip()
            self._send_json(
                {
                    "ok": completed.returncode == 0,
                    "cmd": command,
                    "mode": "capture",
                    "returncode": completed.returncode,
                    "output": output,
                },
                status=HTTPStatus.OK if completed.returncode == 0 else HTTPStatus.ACCEPTED,
            )
            return

        if self._should_queue_structured_action(action):
            result = self._queue_structured_command_action(command, action)
            response_ok = True
            response_status = HTTPStatus.ACCEPTED
        else:
            result = self._run_structured_command_action(command, action)
            response_ok = result.get("ok", False)
            response_status = HTTPStatus.OK if response_ok else HTTPStatus.ACCEPTED

        self._send_json(
            {
                "ok": response_ok,
                "cmd": command,
                "mode": "action",
                "action": result,
                "message": result.get("message") or result.get("status") or command,
                "output": json.dumps(result, indent=2, sort_keys=True),
            },
            status=response_status,
        )

    @staticmethod
    def _should_queue_structured_action(action: dict[str, Any]) -> bool:
        return not (action["kind"] == "retry" and not action.get("run_after"))

    def _queue_structured_command_action(self, command: str, action: dict[str, Any]) -> dict[str, Any]:
        action_id = f"cmd_{int(time.time() * 1000)}_{uuid4().hex[:10]}"
        queued = {
            "ok": True,
            "action_id": action_id,
            "cmd": command,
            "kind": action["kind"],
            "status": "queued",
            "message": "Queued local action.",
            "created_at": time.time(),
        }
        self._store_command_action(action_id, queued)
        worker = threading.Thread(
            target=self._run_queued_command_action,
            args=(action_id, command, action),
            daemon=True,
        )
        worker.start()
        return queued

    def _run_queued_command_action(self, action_id: str, command: str, action: dict[str, Any]) -> None:
        self._store_command_action(
            action_id,
            {"status": "running", "message": "Running local action.", "started_at": time.time()},
        )
        try:
            result = self._run_structured_command_action(command, action)
            ok = bool(result.get("ok", False))
            status = "succeeded" if ok else "failed"
            self._store_command_action(
                action_id,
                {
                    "ok": ok,
                    "status": status,
                    "message": result.get("message") or result.get("status") or status,
                    "result": result,
                    "output": json.dumps(result, indent=2, sort_keys=True),
                    "finished_at": time.time(),
                },
            )
        except Exception as exc:  # pragma: no cover - exercised through HTTP behavior.
            failure = {"ok": False, "status": "failed", "error": str(exc)}
            self._store_command_action(
                action_id,
                {
                    **failure,
                    "message": str(exc),
                    "result": failure,
                    "output": json.dumps(failure, indent=2, sort_keys=True),
                    "finished_at": time.time(),
                },
            )

    def _store_command_action(self, action_id: str, patch: dict[str, Any]) -> None:
        with self.server.command_actions_lock:
            current = self.server.command_actions.get(action_id, {"action_id": action_id})
            self.server.command_actions[action_id] = {**current, **patch}

    def _handle_get_action(self, query: str) -> None:
        params = parse_qs(query)
        action_id = (params.get("id") or [""])[0]
        if not action_id:
            self._send_error(HTTPStatus.BAD_REQUEST, "bad_request", "'id' is required.")
            return
        with self.server.command_actions_lock:
            action = self.server.command_actions.get(action_id)
            payload = dict(action) if action else None
        if payload is None:
            self._send_error(HTTPStatus.NOT_FOUND, "not_found", f"No action found for {action_id}.")
            return
        self._send_json({"ok": True, "action": payload})

    def _run_structured_command_action(self, command: str, action: dict[str, Any]) -> dict[str, Any]:
        if action["kind"] == "retry":
            stage = action["stage"]
            job_url = reset_job_stage(
                self._fresh_connection(),
                action["url"],
                stage,
                reset_attempts=bool(action.get("reset_attempts")),
            )
            if not action.get("run_after"):
                return {
                    "ok": True,
                    "kind": "retry",
                    "stage": stage,
                    "job_url": job_url,
                    "status": "reset",
                    "message": f"Reset {stage} for retry.",
                }
            if stage == "apply":
                request = LocalActionRequest(stage="apply", job_url=job_url, limit=1)
            else:
                request = LocalActionRequest(stage=stage, limit=1)
            result = run_local_action(request).to_dict()
            result["kind"] = "retry"
            result["job_url"] = job_url
            return result

        if action["kind"] == "stage":
            return run_local_action(action["request"]).to_dict()

        if action["kind"] == "apply":
            return run_local_action(action["request"]).to_dict()

        raise ValueError(f"Unsupported structured command action for {command}.")

    def _handle_update_config(self) -> None:
        payload = self._read_json()
        settings = config.save_dashboard_settings(payload, base=self.server.dashboard_settings)
        self.server.dashboard_settings = settings
        self._send_json({"ok": True, "config": settings})

    def _handle_get_profile_config(self) -> None:
        profile_data, profile_text, profile_exists = _load_profile_for_editor()
        style = load_resume_style()
        if not config.RESUME_TEMPLATE_PATH.exists():
            save_latex_template(build_latex_template_from_style(style))
        template_text = ensure_latex_template()
        self._send_json(
            {
                "ok": True,
                "profile": {
                    "path": str(config.PROFILE_PATH),
                    "exists": profile_exists,
                    "text": profile_text,
                    "data": profile_data,
                },
                "style": {
                    "path": str(config.RESUME_STYLE_PATH),
                    "data": style,
                },
                "latex_template": {
                    "path": str(config.RESUME_TEMPLATE_PATH),
                    "text": template_text,
                    "tokens": [
                        "{{ personal_data }}",
                        "{{ resume_body }}",
                        "{{ executive_profile_section }}",
                        "{{ experience_section }}",
                        "{{ education_section }}",
                        "{{ skills_section }}",
                    ],
                },
            }
        )

    def _handle_profile_import(self) -> None:
        filename, pdf_bytes = self._read_multipart_file("resume_pdf")
        base_profile, _, _ = _load_profile_for_editor()
        imported = import_resume_pdf(
            pdf_bytes,
            filename=filename,
            base_profile=base_profile if isinstance(base_profile, dict) else None,
            base_style=load_resume_style(),
        )
        profile = _profile_for_editor(imported["profile"])
        require_resume_master(profile)
        profile_text = json.dumps(profile, indent=2, ensure_ascii=False) + "\n"
        style = imported["style"]
        template_text = build_latex_template_from_style(style)
        self._send_json(
            {
                "ok": True,
                "profile": {
                    "path": str(config.PROFILE_PATH),
                    "exists": config.PROFILE_PATH.exists(),
                    "text": profile_text,
                    "data": profile,
                },
                "style": {"path": str(config.RESUME_STYLE_PATH), "data": style},
                "latex_template": {
                    "path": str(config.RESUME_TEMPLATE_PATH),
                    "text": template_text,
                    "tokens": [
                        "{{ personal_data }}",
                        "{{ resume_body }}",
                        "{{ executive_profile_section }}",
                        "{{ experience_section }}",
                        "{{ education_section }}",
                        "{{ skills_section }}",
                    ],
                },
                "source": imported.get("source", {}),
            }
        )

    def _handle_update_profile_config(self) -> None:
        payload = self._read_json()
        if isinstance(payload.get("profile"), dict):
            profile = payload["profile"]
        else:
            profile_text = str(payload.get("profile_text") or "")
            if not profile_text.strip():
                raise ValueError("profile_text or profile is required.")
            try:
                profile = json.loads(profile_text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid profile JSON: {exc}") from exc
        if not isinstance(profile, dict):
            raise ValueError("profile.json must be a JSON object.")
        require_resume_master(profile)
        profile = _profile_for_editor(profile)

        if isinstance(payload.get("style"), dict):
            style = save_resume_style(payload["style"])
            template_text = build_latex_template_from_style(style)
            save_latex_template(template_text)
        else:
            template_text = str(payload.get("template_text") or "")
            if not template_text.strip():
                style = save_resume_style(load_resume_style())
                template_text = build_latex_template_from_style(style)
            save_latex_template(template_text)
            style = load_resume_style()

        config.PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        formatted_profile = json.dumps(profile, indent=2, ensure_ascii=False) + "\n"
        config.PROFILE_PATH.write_text(formatted_profile, encoding="utf-8")
        self._send_json(
            {
                "ok": True,
                "profile": {
                    "path": str(config.PROFILE_PATH),
                    "exists": True,
                    "text": formatted_profile,
                    "data": profile,
                },
                "style": {"path": str(config.RESUME_STYLE_PATH), "data": style},
                "latex_template": {
                    "path": str(config.RESUME_TEMPLATE_PATH),
                    "text": template_text,
                    "tokens": [
                        "{{ personal_data }}",
                        "{{ resume_body }}",
                        "{{ executive_profile_section }}",
                        "{{ experience_section }}",
                        "{{ education_section }}",
                        "{{ skills_section }}",
                    ],
                },
            }
        )

    def _handle_open_artifact(self) -> None:
        payload = self._read_json()
        path = str(payload.get("path") or "")
        if not path:
            raise ValueError("'path' is required.")

        if not _is_known_artifact_path(self._fresh_connection(), path):
            self._send_error(HTTPStatus.NOT_FOUND, "artifact_not_found", f"No known artifact for {path}")
            return

        artifact_path = Path(path).expanduser()
        if not artifact_path.is_file():
            self._send_error(HTTPStatus.NOT_FOUND, "artifact_missing", f"Artifact file does not exist: {path}")
            return

        _open_local_file(artifact_path)
        self._send_json({"ok": True, "path": path})

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON body: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object.")
        return payload

    def _read_multipart_file(self, field_name: str) -> tuple[str, bytes]:
        content_type = self.headers.get("content-type", "")
        if "multipart/form-data" not in content_type:
            raise ValueError("Expected multipart/form-data upload.")
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            raise ValueError("Upload body is empty.")
        if length > MAX_IMPORT_BYTES + 1024 * 1024:
            raise ValueError(f"Upload body must be {MAX_IMPORT_BYTES // (1024 * 1024)}MB or smaller.")

        raw = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw
        )
        if not message.is_multipart():
            raise ValueError("Upload body is not multipart.")

        for part in message.iter_parts():
            disposition = part.get_content_disposition()
            name = part.get_param("name", header="content-disposition")
            if disposition == "form-data" and name == field_name:
                payload = part.get_payload(decode=True) or b""
                filename = part.get_filename() or "resume.pdf"
                if not payload:
                    raise ValueError("Uploaded PDF is empty.")
                return filename, payload
        raise ValueError(f"Missing upload field: {field_name}.")

    def _send_html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, code: str, message: str) -> None:
        self._send_json({"ok": False, "error": {"code": code, "message": message}}, status=status)

    def _cors_headers(self) -> None:
        self.send_header("access-control-allow-origin", "http://127.0.0.1")
        self.send_header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")


def _str_param(params: dict[str, list[str]], key: str, default: str) -> str:
    value = (params.get(key) or [default])[0]
    return str(value or default)


def _int_param(params: dict[str, list[str]], key: str, default: int) -> int:
    value = (params.get(key) or [default])[0]
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _is_known_artifact_path(conn, path: str) -> bool:
    row = conn.execute("SELECT 1 FROM job_artifacts WHERE path = ? LIMIT 1", (path,)).fetchone()
    if row:
        return True
    row = conn.execute(
        """
        SELECT 1
        FROM jobs
        WHERE tailored_resume_path = ?
           OR cover_letter_path = ?
           OR replace(tailored_resume_path, '.txt', '.pdf') = ?
           OR replace(cover_letter_path, '.txt', '.pdf') = ?
        LIMIT 1
        """,
        (path, path, path, path),
    ).fetchone()
    return bool(row)


def _parse_dashboard_command(command: str, data: dict[str, Any]) -> dict[str, Any]:
    """Parse one UI-emitted command into an allowlisted action."""
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise ValueError(f"Invalid command: {exc}") from exc
    if not argv or argv[0] != "jobhunter":
        raise ValueError("Only JobHunter commands emitted by this dashboard can be run.")

    subcommand = argv[1] if len(argv) > 1 else ""
    known_urls = _known_job_urls(data)
    valid_stage_commands = set(STAGE_ORDER)

    if subcommand == "dashboard" and len(argv) == 2:
        return {
            "mode": "noop",
            "argv": argv,
            "label": "dashboard",
            "message": "Dashboard is already open.",
        }

    if subcommand in {"status", "runs", "doctor"}:
        _validate_info_command(argv)
        return {"mode": "capture", "argv": argv, "label": subcommand}

    if subcommand == "retry":
        _validate_retry_command(argv, known_urls)
        return {
            "mode": "action",
            "kind": "retry",
            "argv": argv,
            "label": "retry",
            "stage": argv[2],
            "url": argv[3],
            "reset_attempts": "--reset-attempts" in argv,
            "run_after": "--run" in argv,
        }

    if subcommand == "apply":
        _validate_apply_command(argv, known_urls)
        return {
            "mode": "action",
            "kind": "apply",
            "argv": argv,
            "label": "apply",
            "request": _local_action_request_from_apply(argv),
        }

    if subcommand in valid_stage_commands:
        _validate_stage_command(argv)
        return {
            "mode": "action",
            "kind": "stage",
            "argv": argv,
            "label": subcommand,
            "request": _local_action_request_from_stage(argv),
        }

    raise ValueError(f"Command is not allowed from the dashboard: {subcommand or command}")


def _validate_info_command(argv: list[str]) -> None:
    subcommand = argv[1]
    if subcommand in {"status", "doctor"} and len(argv) == 2:
        return
    if subcommand == "runs":
        i = 2
        while i < len(argv):
            flag = argv[i]
            if flag in {"--failed-only"}:
                i += 1
                continue
            if flag in {"--limit", "-l", "--events", "-e", "--run-id"} and i + 1 < len(argv):
                if flag != "--run-id":
                    _require_int(argv[i + 1], flag)
                i += 2
                continue
            raise ValueError(f"Unsupported runs option: {flag}")
        return
    raise ValueError(f"Unsupported {subcommand} command options.")


def _local_action_request_from_stage(argv: list[str]) -> LocalActionRequest:
    stage = argv[1]
    return LocalActionRequest(
        stage=stage,
        limit=_int_option(argv, "--limit", "-l", default=0),
        workers=_int_option(argv, "--workers", "-w", default=1),
        min_score=_int_option(argv, "--min-score", default=7),
        validation_mode=_str_option(argv, "--validation", default="normal"),
        dry_run="--dry-run" in argv,
        rescore="--rescore" in argv,
        retailor="--retailor" in argv,
    )


def _local_action_request_from_apply(argv: list[str]) -> LocalActionRequest:
    job_url = _str_option(argv, "--url", default=None)
    limit_default = 1 if job_url and not _has_option(argv, "--limit", "-l") else 0
    return LocalActionRequest(
        stage="apply",
        job_url=job_url,
        limit=_int_option(argv, "--limit", "-l", default=limit_default),
        workers=_int_option(argv, "--workers", "-w", default=1),
        min_score=_int_option(argv, "--min-score", default=7),
        model=_str_option(argv, "--model", "-m", default="haiku") or "haiku",
        headless="--headless" in argv,
        dry_run="--dry-run" in argv,
    )


def _has_option(argv: list[str], *flags: str) -> bool:
    return any(item in flags for item in argv)


def _str_option(argv: list[str], *flags: str, default: str | None = "") -> str | None:
    for index, item in enumerate(argv):
        if item in flags and index + 1 < len(argv):
            return argv[index + 1]
    return default


def _int_option(argv: list[str], *flags: str, default: int = 0) -> int:
    value = _str_option(argv, *flags, default=None)
    return int(value) if value not in (None, "") else default


def _validate_retry_command(argv: list[str], known_urls: set[str]) -> None:
    valid_retry_stages = set(STAGE_ORDER) | {"apply"}
    if len(argv) < 4:
        raise ValueError("Retry commands must include a stage and job URL.")
    stage = argv[2]
    url = argv[3]
    if stage not in valid_retry_stages:
        raise ValueError(f"Unsupported retry stage: {stage}")
    _require_known_url(url, known_urls)
    for flag in argv[4:]:
        if flag not in {"--reset-attempts", "--run"}:
            raise ValueError(f"Unsupported retry option: {flag}")


def _validate_apply_command(argv: list[str], known_urls: set[str]) -> None:
    i = 2
    has_url = False
    while i < len(argv):
        flag = argv[i]
        if flag == "--url" and i + 1 < len(argv):
            _require_known_url(argv[i + 1], known_urls)
            has_url = True
            i += 2
            continue
        if flag in {"--dry-run", "--headless"}:
            i += 1
            continue
        if flag in {"--limit", "-l", "--workers", "-w", "--min-score", "--model", "-m"} and i + 1 < len(argv):
            if flag in {"--limit", "-l", "--workers", "-w", "--min-score"}:
                _require_int(argv[i + 1], flag)
            i += 2
            continue
        raise ValueError(f"Unsupported apply option: {flag}")
    if not has_url:
        raise ValueError("Dashboard apply commands must target one known job URL.")


def _validate_stage_command(argv: list[str]) -> None:
    i = 2
    while i < len(argv):
        flag = argv[i]
        if flag in {"--dry-run", "--rescore", "--retailor"}:
            i += 1
            continue
        if flag in {"--limit", "--workers", "-w", "--min-score"} and i + 1 < len(argv):
            _require_int(argv[i + 1], flag)
            i += 2
            continue
        if flag == "--validation" and i + 1 < len(argv):
            if argv[i + 1] not in {"strict", "normal", "lenient"}:
                raise ValueError("Unsupported validation mode.")
            i += 2
            continue
        raise ValueError(f"Unsupported stage option: {flag}")


def _known_job_urls(data: dict[str, Any]) -> set[str]:
    urls = set(data.get("job_detail", {}).keys())
    for job in data.get("jobs", []):
        for key in ("job_url", "application_url"):
            value = job.get(key)
            if value:
                urls.add(str(value))
    for detail in data.get("job_detail", {}).values():
        for key in ("url", "application_url"):
            value = detail.get(key)
            if value:
                urls.add(str(value))
    return urls


def _require_known_url(url: str, known_urls: set[str]) -> None:
    if url not in known_urls:
        raise ValueError("Command targets a job URL that is not in the dashboard data.")


def _require_int(value: str, flag: str) -> None:
    try:
        int(value)
    except ValueError as exc:
        raise ValueError(f"{flag} expects an integer value.") from exc


def _dashboard_command_args(argv: list[str]) -> list[str]:
    return [sys.executable, "-m", "jobhunter.cli", *argv[1:]]


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _command_env() -> dict[str, str]:
    env = os.environ.copy()
    src_path = str(Path(__file__).resolve().parents[1])
    env["PYTHONPATH"] = (
        f"{src_path}{os.pathsep}{env['PYTHONPATH']}"
        if env.get("PYTHONPATH")
        else src_path
    )
    env["PYTHONUNBUFFERED"] = "1"
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    return env


def _command_log_path(label: str) -> Path:
    root = config.APP_DIR / "dashboard_commands"
    root.mkdir(parents=True, exist_ok=True)
    safe_label = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in label) or "command"
    return root / f"{int(time.time())}_{safe_label}.log"


def _open_local_file(path: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    if sys.platform.startswith("linux"):
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    raise RuntimeError(f"Opening local files is not supported on {sys.platform}.")


def _default_profile_json_text() -> str:
    example_path = Path(__file__).resolve().parents[2] / "profile.example.json"
    if example_path.exists():
        return example_path.read_text(encoding="utf-8")
    return json.dumps({"personal": {}, "resume": {}}, indent=2) + "\n"


def _load_profile_for_editor() -> tuple[Any, str, bool]:
    profile_path = config.PROFILE_PATH
    if profile_path.exists():
        profile_text = profile_path.read_text(encoding="utf-8")
        profile_exists = True
    else:
        profile_text = _default_profile_json_text()
        profile_exists = False

    try:
        profile_data = json.loads(profile_text)
    except json.JSONDecodeError:
        profile_data = None
    profile_data = _profile_for_editor(profile_data)
    if isinstance(profile_data, dict):
        profile_text = json.dumps(profile_data, indent=2, ensure_ascii=False) + "\n"
    return profile_data, profile_text, profile_exists


def serve_dashboard(
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    open_browser: bool = True,
    min_score: int | None = None,
) -> None:
    """Serve the live dashboard until interrupted."""
    server = DashboardHTTPServer((host, port), DashboardHandler, min_score=min_score)
    url = f"http://{host}:{server.server_address[1]}"
    console.print(f"[green]JobHunter dashboard running:[/green] {url}")
    console.print("[dim]Press Ctrl-C to stop.[/dim]")

    if open_browser:
        threading.Timer(0.25, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        console.print("\n[yellow]Stopping dashboard server...[/yellow]")
    finally:
        server.server_close()
