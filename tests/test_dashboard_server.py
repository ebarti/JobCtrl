import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from jobhunter.dashboard_server import DashboardHTTPServer, DashboardHandler
from jobhunter.database import close_connection, init_db
from jobhunter.view import dashboard_html


def _insert_job(conn, *, url: str = "https://example.com/job", detail_error: str | None = None) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, strategy, discovered_at, detail_error
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Platform Engineer",
            "ExampleCo",
            "test",
            "2026-04-29T10:00:00+00:00",
            detail_error,
        ),
    )
    conn.commit()


def _insert_artifact(conn, *, path: str, url: str = "https://example.com/job") -> None:
    conn.execute(
        """
        INSERT INTO job_artifacts (
            job_url, stage, artifact_type, status, path, created_at, size_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "tailor",
            "tailored_resume_txt",
            "active",
            path,
            "2026-04-29T10:05:00+00:00",
            12,
        ),
    )
    conn.commit()


def _profile_payload() -> dict:
    return {
        "personal": {"full_name": "Jordan Candidate", "email": "jordan@example.com"},
        "resume": {
            "executive_profile": {"baseline_text": "Engineer."},
            "experience_entries": [
                {
                    "id": "current_role",
                    "date_range": "2024 -- Present",
                    "title": "Engineer",
                    "company": "Example",
                    "location": "Remote",
                    "bullets": ["Built systems."],
                }
            ],
            "education_entries": [],
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python"]}],
            "tailoring_rules": {
                "required_experience_entry_ids": ["current_role"],
                "required_skill_category_ids": ["languages"],
                "required_bullets_by_experience_id": {"current_role": ["Built systems."]},
                "max_experience_bullets": 4,
                "tailoring_policy": {
                    "mode": "balanced",
                    "allow_title_reframing": False,
                    "allow_achievement_rewriting": True,
                    "allow_skill_reordering": True,
                    "allow_summary_rewrite": True,
                    "allow_minor_inference": False,
                },
                "writing_style": {
                    "tone": "technical",
                    "bullet_style": "impact",
                    "verbosity": "concise",
                    "keyword_density": "moderate",
                    "avoid_first_person": True,
                },
                "custom_tailoring_prompt": "Prioritize backend platform impact.",
            },
        },
    }


class _ServerContext:
    def __init__(self):
        self.server = DashboardHTTPServer(("127.0.0.1", 0), DashboardHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get_json(self, path: str):
        with urllib.request.urlopen(f"{self.base_url}{path}", timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def post_json(self, path: str, payload: dict):
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def post_multipart(self, path: str, *, field_name: str, filename: str, payload: bytes):
        boundary = "----jobhunter-test-boundary"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
            "Content-Type: application/pdf\r\n\r\n"
        ).encode("utf-8") + payload + f"\r\n--{boundary}--\r\n".encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={"content-type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def patch_json(self, path: str, payload: dict):
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="PATCH",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))


def test_live_dashboard_html_fetches_api_payload():
    html = dashboard_html(live=True)

    assert 'data-live="1"' in html
    assert 'data-view="jobs"' in html
    assert 'data-view="artifacts"' in html
    assert 'data-view="config"' in html
    assert 'data-view="profile"' in html
    assert "data-job-filter" in html
    assert 'id="current-stage-filter"' in html
    assert "Current stage filter" in html
    assert "score-anchor" in html
    assert "config-form" in html
    assert "data-profile-field" in html
    assert "data-style-field" in html
    assert "data-required-experience-index" in html
    assert "data-required-bullet-index" in html
    assert "Tailoring controls" in html
    assert "Writing tone" in html
    assert "Additional tailoring prompt" in html
    assert "Advanced settings" in html
    assert "data-field-save" in html
    assert "data-field-discard" in html
    assert "data-profile-save-all" in html
    assert "data-profile-discard-all" in html
    assert "view only" not in html
    assert "brand-db" not in html
    assert "<title>JobHunter</title>" in html
    assert "JobHunter Ops" not in html
    assert "brand-sub" not in html
    assert "live API" not in html
    assert 'id="generated-state"' not in html
    assert "waiting for API" not in html
    assert "data-artifact-path" in html
    assert "/api/config" in html
    assert "/api/dashboard" in html
    assert "/api/open-artifact" in html
    assert "/api/command" in html
    assert "/api/profile-config" in html
    assert "/api/profile-import" in html
    assert "data-command-run" in html
    assert "data-command-copy" in html
    assert "Import from resume PDF" in html
    assert "data-profile-splitter" in html
    assert "data-profile-panel-toggle" in html
    assert "panes" in html
    assert "show inputs" in html
    assert "show preview" in html
    assert "editors" not in html
    assert "jobhunter.profileEditorPx" in html
    assert "jobhunter.profileEditorPct" in html
    assert 'id="jobhunter-data"' not in html
    assert "jobhunter status --watch" not in html
    assert "jobhunter status" in html


def test_dashboard_api_returns_live_payload(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, detail_error="timeout")

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)

        with _ServerContext() as server:
            data = server.get_json("/api/dashboard")

        assert data["schema_version"] == 2
        assert data["totals"]["jobs"] == 1
        assert data["triage"][0]["stage"] == "enrich"
    finally:
        close_connection(db_path)


def test_dashboard_config_patch_persists_and_updates_payload(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    settings_path = Path(tmp_path) / "dashboard.json"
    conn = init_db(db_path)
    _insert_job(conn)

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DASHBOARD_CONFIG_PATH", settings_path)

        with _ServerContext() as server:
            result = server.patch_json(
                "/api/config",
                {
                    "target_role": "Security Engineering",
                    "location_filter": "Remote Europe",
                    "min_fit_score": 8,
                    "auto_apply": True,
                    "apply_concurrency": 3,
                },
            )
            data = server.get_json("/api/dashboard")

        saved = json.loads(settings_path.read_text(encoding="utf-8"))
        assert result == {
            "ok": True,
            "config": {
                "target_role": "Security Engineering",
                "location_filter": "Remote Europe",
                "min_fit_score": 8,
                "auto_apply": True,
                "apply_concurrency": 3,
            },
        }
        assert saved == result["config"]
        assert data["config"]["min_fit_score"] == 8
        assert data["config"]["target_role"] == "Security Engineering"
    finally:
        close_connection(db_path)


def test_dashboard_profile_config_get_and_patch(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    profile_path = Path(tmp_path) / "profile.json"
    template_path = Path(tmp_path) / "resume_template.tex"
    style_path = Path(tmp_path) / "resume_style.json"
    style_path = Path(tmp_path) / "resume_style.json"
    init_db(db_path)
    profile_text = json.dumps(_profile_payload())
    template_text = (
        r"\documentclass{article}"
        "\n{{ personal_data }}"
        "\n\\begin{document}"
        "\n{{ resume_body }}"
        "\n\\end{document}"
    )

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.PROFILE_PATH", profile_path)
        monkeypatch.setattr("jobhunter.config.RESUME_TEMPLATE_PATH", template_path)
        monkeypatch.setattr("jobhunter.config.RESUME_STYLE_PATH", style_path)
        monkeypatch.setattr("jobhunter.config.RESUME_STYLE_PATH", style_path)

        with _ServerContext() as server:
            initial = server.get_json("/api/profile-config")
            saved = server.patch_json(
                "/api/profile-config",
                {"profile_text": profile_text, "template_text": template_text},
            )
            loaded = server.get_json("/api/profile-config")

        assert initial["profile"]["path"] == str(profile_path)
        assert initial["profile"]["exists"] is False
        assert initial["profile"]["data"]["personal"]["email"] == "jordan.candidate@example.com"
        assert initial["style"]["path"] == str(style_path)
        assert initial["style"]["data"]["document_font_size"] == "11pt"
        assert initial["latex_template"]["path"] == str(template_path)
        assert "{{ personal_data }}" in initial["latex_template"]["text"]
        assert saved["ok"] is True
        assert json.loads(profile_path.read_text(encoding="utf-8"))["personal"]["email"] == "jordan@example.com"
        assert template_path.read_text(encoding="utf-8") == template_text
        assert loaded["profile"]["exists"] is True
        assert loaded["profile"]["text"] == saved["profile"]["text"]
        assert loaded["latex_template"]["text"] == template_text
    finally:
        close_connection(db_path)


def test_dashboard_profile_import_returns_unsaved_profile_and_style_draft(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    profile_path = Path(tmp_path) / "profile.json"
    template_path = Path(tmp_path) / "resume_template.tex"
    style_path = Path(tmp_path) / "resume_style.json"
    init_db(db_path)
    imported_profile = _profile_payload()
    imported_profile["personal"]["email"] = "imported@example.com"
    imported_style = {
        "document_font_size": "10pt",
        "paper_size": "letterpaper",
        "font_family": "roman",
        "moderncv_style": "banking",
        "moderncv_color": "green",
        "page_scale": 0.8,
        "hints_column_width_cm": 3.5,
        "body_alignment": "left",
    }

    def fake_import_resume_pdf(pdf_bytes, *, filename="", base_profile=None, base_style=None):
        assert pdf_bytes.startswith(b"%PDF")
        assert filename == "resume.pdf"
        assert base_profile["personal"]["email"] == "jordan.candidate@example.com"
        return {
            "profile": imported_profile,
            "style": imported_style,
            "source": {"filename": filename, "pages": 1, "warnings": []},
        }

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.PROFILE_PATH", profile_path)
        monkeypatch.setattr("jobhunter.config.RESUME_TEMPLATE_PATH", template_path)
        monkeypatch.setattr("jobhunter.config.RESUME_STYLE_PATH", style_path)
        monkeypatch.setattr("jobhunter.dashboard_server.import_resume_pdf", fake_import_resume_pdf)

        with _ServerContext() as server:
            imported = server.post_multipart(
                "/api/profile-import",
                field_name="resume_pdf",
                filename="resume.pdf",
                payload=b"%PDF-1.7 test",
            )

        assert imported["ok"] is True
        assert imported["profile"]["data"]["personal"]["email"] == "imported@example.com"
        assert imported["style"]["data"]["font_family"] == "roman"
        assert r"\documentclass[10pt,letterpaper,roman]{moderncv}" in imported["latex_template"]["text"]
        assert imported["source"]["filename"] == "resume.pdf"
        assert not profile_path.exists()
        assert not style_path.exists()
        assert not template_path.exists()
    finally:
        close_connection(db_path)


def test_dashboard_profile_config_rejects_invalid_profile(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    profile_path = Path(tmp_path) / "profile.json"
    template_path = Path(tmp_path) / "resume_template.tex"
    init_db(db_path)
    template_text = (
        r"\documentclass{article}"
        "\n{{ personal_data }}"
        "\n\\begin{document}"
        "\n{{ resume_body }}"
        "\n\\end{document}"
    )

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.PROFILE_PATH", profile_path)
        monkeypatch.setattr("jobhunter.config.RESUME_TEMPLATE_PATH", template_path)

        with _ServerContext() as server:
            try:
                server.patch_json(
                    "/api/profile-config",
                    {"profile_text": '{"personal": {}}', "template_text": template_text},
                )
            except urllib.error.HTTPError as exc:
                status_code = exc.code
                body = json.loads(exc.read().decode("utf-8"))
            else:
                raise AssertionError("expected 400")

        assert status_code == 400
        assert body["error"]["code"] == "bad_request"
        assert "resume" in body["error"]["message"]
        assert not profile_path.exists()
    finally:
        close_connection(db_path)


def test_dashboard_profile_config_accepts_structured_profile_and_style(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    profile_path = Path(tmp_path) / "profile.json"
    template_path = Path(tmp_path) / "resume_template.tex"
    style_path = Path(tmp_path) / "resume_style.json"
    init_db(db_path)
    profile = _profile_payload()
    profile["personal"]["email"] = "structured@example.com"
    style = {
        "document_font_size": "12pt",
        "paper_size": "letterpaper",
        "font_family": "roman",
        "moderncv_style": "classic",
        "moderncv_color": "blue",
        "page_scale": 0.9,
        "hints_column_width_cm": 2.5,
        "body_alignment": "left",
    }

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.PROFILE_PATH", profile_path)
        monkeypatch.setattr("jobhunter.config.RESUME_TEMPLATE_PATH", template_path)
        monkeypatch.setattr("jobhunter.config.RESUME_STYLE_PATH", style_path)

        with _ServerContext() as server:
            saved = server.patch_json(
                "/api/profile-config",
                {"profile": profile, "style": style},
            )

        saved_profile = json.loads(profile_path.read_text(encoding="utf-8"))
        saved_style = json.loads(style_path.read_text(encoding="utf-8"))
        generated_template = template_path.read_text(encoding="utf-8")

        assert saved["ok"] is True
        assert saved_profile["personal"]["email"] == "structured@example.com"
        assert saved_profile["resume"]["tailoring_rules"]["required_bullets_by_experience_id"] == {
            "current_role": ["Built systems."]
        }
        assert saved_profile["resume"]["tailoring_rules"]["tailoring_policy"]["allow_title_reframing"] is False
        assert saved_profile["resume"]["tailoring_rules"]["writing_style"]["tone"] == "technical"
        assert saved_profile["resume"]["tailoring_rules"]["custom_tailoring_prompt"] == "Prioritize backend platform impact."
        assert saved_style["moderncv_style"] == "classic"
        assert saved_style["font_family"] == "roman"
        assert r"\documentclass[12pt,letterpaper,roman]{moderncv}" in generated_template
        assert r"\moderncvstyle{classic}" in generated_template
        assert r"\moderncvcolor{blue}" in generated_template
        assert r"\AtBeginDocument{\raggedright}" in generated_template
        assert "{{ resume_body }}" in generated_template
        assert saved["profile"]["data"]["personal"]["email"] == "structured@example.com"
        assert saved["style"]["data"]["document_font_size"] == "12pt"
    finally:
        close_connection(db_path)


def test_dashboard_job_api_and_retry_post(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, detail_error="timeout")

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)

        with _ServerContext() as server:
            encoded = urllib.parse.quote("https://example.com/job", safe="")
            detail = server.get_json(f"/api/job?url={encoded}")
            retry = server.post_json(
                "/api/retry",
                {"stage": "enrich", "url": "https://example.com/job", "reset_attempts": True},
            )

        row = conn.execute(
            "SELECT detail_error, detail_scraped_at FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = conn.execute(
            "SELECT state, attempt_count FROM job_stage_states WHERE job_url = ? AND stage = 'enrich'",
            ("https://example.com/job",),
        ).fetchone()

        assert detail["url"] == "https://example.com/job"
        assert retry == {
            "ok": True,
            "job_url": "https://example.com/job",
            "stage": "enrich",
            "reset_attempts": True,
        }
        assert row["detail_error"] is None
        assert row["detail_scraped_at"] is None
        assert state["state"] == "pending"
        assert state["attempt_count"] == 0
    finally:
        close_connection(db_path)


def test_dashboard_command_endpoint_captures_allowlisted_status(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    calls = []

    class _Completed:
        returncode = 0
        stdout = "status ok\n"
        stderr = ""

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return _Completed()

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.dashboard_server.subprocess.run", fake_run)

        with _ServerContext() as server:
            result = server.post_json("/api/command", {"cmd": "jobhunter status"})

        assert result["ok"] is True
        assert result["mode"] == "capture"
        assert result["output"] == "status ok"
        assert calls[0][0][-1] == "status"
        assert "shell" not in calls[0][1]
    finally:
        close_connection(db_path)


def test_dashboard_command_endpoint_starts_allowlisted_apply(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn)
    calls = []

    class _Proc:
        pid = 12345

    def fake_popen(args, **kwargs):
        calls.append((args, kwargs))
        return _Proc()

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.dashboard_server.config.APP_DIR", Path(tmp_path) / ".jobhunter")
        monkeypatch.setattr("jobhunter.dashboard_server.subprocess.Popen", fake_popen)

        with _ServerContext() as server:
            result = server.post_json(
                "/api/command",
                {"cmd": "jobhunter apply --url https://example.com/job"},
            )

        assert result["ok"] is True
        assert result["mode"] == "background"
        assert result["pid"] == 12345
        assert calls[0][0][-3:] == ["apply", "--url", "https://example.com/job"]
        assert Path(result["log_path"]).parent.name == "dashboard_commands"
    finally:
        close_connection(db_path)


def test_dashboard_command_endpoint_rejects_unknown_commands(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)

        with _ServerContext() as server:
            try:
                server.post_json("/api/command", {"cmd": "rm -rf /"})
            except urllib.error.HTTPError as exc:
                status_code = exc.code
                body = json.loads(exc.read().decode("utf-8"))
            else:
                raise AssertionError("Expected command API to reject non-JobHunter command.")

        assert status_code == 400
        assert body["ok"] is False
        assert body["error"]["code"] == "bad_request"
    finally:
        close_connection(db_path)


def test_dashboard_open_artifact_post_opens_known_file(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    artifact_path = Path(tmp_path) / "resume.txt"
    artifact_path.write_text("hello", encoding="utf-8")
    conn = init_db(db_path)
    _insert_job(conn)
    _insert_artifact(conn, path=str(artifact_path))
    calls = []

    def fake_popen(cmd, **kwargs):
        calls.append((cmd, kwargs))

        class _Proc:
            pass

        return _Proc()

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.dashboard_server.sys.platform", "darwin")
        monkeypatch.setattr("jobhunter.dashboard_server.subprocess.Popen", fake_popen)

        with _ServerContext() as server:
            result = server.post_json("/api/open-artifact", {"path": str(artifact_path)})

        assert result == {"ok": True, "path": str(artifact_path)}
        assert calls[0][0] == ["open", str(artifact_path)]
    finally:
        close_connection(db_path)


def test_dashboard_open_artifact_rejects_unknown_file(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    unknown_path = Path(tmp_path) / "unknown.txt"
    unknown_path.write_text("hello", encoding="utf-8")
    init_db(db_path)

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)

        with _ServerContext() as server:
            try:
                server.post_json("/api/open-artifact", {"path": str(unknown_path)})
            except urllib.error.HTTPError as exc:
                status_code = exc.code
                body = json.loads(exc.read().decode("utf-8"))
            else:
                raise AssertionError("expected 404")

        assert status_code == 404
        assert body["error"]["code"] == "artifact_not_found"
    finally:
        close_connection(db_path)


def test_dashboard_job_api_returns_404_for_missing_job(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    try:
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)

        with _ServerContext() as server:
            try:
                server.get_json("/api/job?url=https%3A%2F%2Fmissing.example%2Fjob")
            except urllib.error.HTTPError as exc:
                status_code = exc.code
                body = json.loads(exc.read().decode("utf-8"))
            else:
                raise AssertionError("expected 404")

        assert status_code == 404
        assert body["error"]["code"] == "job_not_found"
    finally:
        close_connection(db_path)
