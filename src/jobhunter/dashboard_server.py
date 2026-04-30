"""Local live dashboard HTTP server."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from rich.console import Console

from jobhunter import config
from jobhunter.database import close_connection, get_connection
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
from jobhunter.state import build_dashboard_data, reset_job_stage
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
            elif parsed.path == "/api/job":
                self._handle_get_job(parsed.query)
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
            elif parsed.path == "/api/open-artifact":
                self._handle_open_artifact()
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
        data = self._dashboard_data()
        detail = data.get("job_detail", {}).get(url)
        if detail is None:
            self._send_error(HTTPStatus.NOT_FOUND, "job_not_found", f"No job detail for {url}")
            return
        self._send_json(detail)

    def _handle_retry(self) -> None:
        payload = self._read_json()
        stage = str(payload.get("stage") or "")
        url = str(payload.get("url") or "")
        reset_attempts = bool(payload.get("reset_attempts", False))
        if not stage or not url:
            raise ValueError("'stage' and 'url' are required.")
        job_url = reset_job_stage(self._fresh_connection(), url, stage, reset_attempts=reset_attempts)
        self._send_json({"ok": True, "job_url": job_url, "stage": stage, "reset_attempts": reset_attempts})

    def _handle_update_config(self) -> None:
        payload = self._read_json()
        settings = config.save_dashboard_settings(payload, base=self.server.dashboard_settings)
        self.server.dashboard_settings = settings
        self._send_json({"ok": True, "config": settings})

    def _handle_get_profile_config(self) -> None:
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
        style = load_resume_style()
        if not config.RESUME_TEMPLATE_PATH.exists():
            save_latex_template(build_latex_template_from_style(style))
        template_text = ensure_latex_template()
        self._send_json(
            {
                "ok": True,
                "profile": {
                    "path": str(profile_path),
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

        data = self._dashboard_data()
        known_paths = {
            artifact["path"]
            for artifact in data.get("artifacts", [])
            if artifact.get("path")
        }
        for detail in data.get("job_detail", {}).values():
            known_paths.update(
                artifact["path"]
                for artifact in detail.get("artifacts", [])
                if artifact.get("path")
            )
        if path not in known_paths:
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
        self.send_header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")


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
