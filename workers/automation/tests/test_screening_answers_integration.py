"""Registered RPC, CLI and exact-schema persistence in owned synthetic storage."""

import json
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from jobctrl import cli, config
from jobctrl.domain.rpc.messages import JsonRpcRequest
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V14_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.rpc import handlers
from tests.rpc_contract_probe import build_server
import pytest
from tests.test_screening_answers import StructuralModel, workspace as shared_workspace


@pytest.fixture
def owned_workspace(tmp_path):
    yield from shared_workspace.__wrapped__(tmp_path)


def dependencies(conn, *, tenant_id, lane):
    assert lane == "apply"
    return dict(
        llm=StructuralModel(),
        repository=SqliteDeterminationRepository(conn),
        tenant_id=tenant_id,
        lane=lane,
        provider="synthetic",
        model="structural",
        preflight=lambda: None,
    )


def test_registered_rpc_complete_workflow_persistence_and_cli_read(owned_workspace, monkeypatch, tmp_path):
    conn, jobs, _ = owned_workspace
    monkeypatch.setattr(handlers, "get_connection", lambda: conn)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", Path(conn.execute("PRAGMA database_list").fetchone()[2]))
    server = build_server()
    params = {
        "tenantId": "local",
        "jobId": jobs[0],
        "expectedAppDir": str(config.APP_DIR),
        "expectedDbPath": str(config.DB_PATH),
    }

    def rpc(command=None):
        response = server.dispatch(
            JsonRpcRequest(
                method="screening_answers", params={**params, **({"command": command} if command else {})}, id=1
            )
        )
        assert response.error is None, response.error
        return response.result

    with patch("jobctrl.infrastructure.determinations.determination_dependencies", dependencies):
        captured = rpc(
            {
                "action": "capture",
                "applicationId": "attempt",
                "question": "Synthetic question",
                "context": "Synthetic context",
                "expectedRevision": 0,
                "idempotencyKey": "capture",
            }
        )["state"]
        drafted = rpc(
            {"action": "draft", "questionId": captured["questionId"], "expectedRevision": 1, "idempotencyKey": "draft"}
        )["state"]
        edited = rpc(
            {
                "action": "edit",
                "text": "Synthetic edited text",
                "questionId": drafted["questionId"],
                "expectedRevision": 2,
                "idempotencyKey": "edit",
            }
        )["state"]
        reviewed = rpc(
            {
                "action": "review",
                "decision": "approved",
                "questionId": edited["questionId"],
                "expectedRevision": 3,
                "idempotencyKey": "review",
            }
        )["state"]
        used = rpc(
            {
                "action": "use",
                "text": "Actual used text",
                "attested": True,
                "questionId": reviewed["questionId"],
                "expectedRevision": 4,
                "idempotencyKey": "use",
            }
        )["state"]
        read = rpc()
        assert read["questions"][0]["snapshotId"] == used["snapshotId"]
        assert len(read["history"]) == 5
        assert {row["kind"] for row in read["determinations"]} == {
            "screening_context",
            "screening_draft",
            "claim_verification",
            "artifact_quality",
        }
        assert_exact_manifest(conn, EXACT_V14_MANIFEST)
        output = CliRunner().invoke(cli.app, ["screening", "read", jobs[0]])
        assert output.exit_code == 0, output.output
        assert json.loads(output.output)["questions"][0]["manualUse"]["text"] == "Actual used text"
        command_file = tmp_path / "owned-command.json"
        command_file.write_text(
            json.dumps(
                {
                    "action": "use",
                    "text": "CLI used text",
                    "attested": True,
                    "questionId": used["questionId"],
                    "expectedRevision": 5,
                    "idempotencyKey": "cli",
                }
            )
        )
        output = CliRunner().invoke(cli.app, ["screening", "write", jobs[0], str(command_file)])
        assert output.exit_code == 0, output.output
        assert json.loads(output.output)["state"]["revision"] == 6


def test_registered_rpc_refuses_same_version_wrong_database_and_unknown_fields(owned_workspace, monkeypatch, tmp_path):
    conn, jobs, _ = owned_workspace
    monkeypatch.setattr(handlers, "get_connection", lambda: conn)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "source.db")
    server = build_server()
    params = {
        "tenantId": "local",
        "jobId": jobs[0],
        "expectedAppDir": str(tmp_path),
        "expectedDbPath": str(tmp_path / "foreign.db"),
    }
    response = server.dispatch(JsonRpcRequest(method="screening_answers", params=params, id=1))
    assert response.error is not None
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    params["expectedDbPath"] = str(config.DB_PATH)
    params["command"] = {
        "action": "capture",
        "question": "Question",
        "context": "Context",
        "applicationId": "attempt",
        "expectedRevision": 0,
        "idempotencyKey": "one",
        "submit": True,
    }
    response = server.dispatch(JsonRpcRequest(method="screening_answers", params=params, id=1))
    assert response.error.code == -32602
    assert response.error.message == "screening_invalid_command"
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0


def test_actual_cli_process_reopens_persisted_answers_and_records_manual_use(owned_workspace, tmp_path):
    import os
    import sqlite3
    import subprocess
    from tests.test_screening_answers import reviewed, service

    conn, jobs, _ = owned_workspace
    state = reviewed(service(conn), jobs[0])
    app_dir = tmp_path / "cli-workspace"
    app_dir.mkdir()
    target = sqlite3.connect(app_dir / "jobctrl.db")
    conn.backup(target)
    target.close()
    project = Path(__file__).resolve().parents[1]
    interpreter = project / ".venv/bin/python"
    env = {
        "PATH": os.environ["PATH"],
        "PYTHONPATH": str(project / "src"),
        "JOBCTRL_DIR": str(app_dir),
        "PYTHON_DOTENV_DISABLED": "1",
    }
    process = subprocess.run(
        [str(interpreter), "-m", "jobctrl.cli", "screening", "read", jobs[0]],
        cwd=app_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    persisted = json.loads(process.stdout)
    assert persisted["questions"][0]["accepted"]["text"] == state["accepted"]["text"]
    command_file = app_dir / "command.json"
    command_file.write_text(
        json.dumps(
            {
                "action": "use",
                "text": "CLI process actual text",
                "attested": True,
                "questionId": state["questionId"],
                "expectedRevision": state["revision"],
                "idempotencyKey": "cli-process",
            }
        )
    )
    process = subprocess.run(
        [str(interpreter), "-m", "jobctrl.cli", "screening", "write", jobs[0], str(command_file)],
        cwd=app_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    assert json.loads(process.stdout)["state"]["manualUse"]["text"] == "CLI process actual text"
    check = sqlite3.connect(app_dir / "jobctrl.db")
    assert check.execute("SELECT COUNT(*) FROM application_outcomes").fetchone()[0] == 0
    check.close()


def test_cli_invalid_input_never_displays_private_command_text(tmp_path):
    filename = tmp_path / "invalid.json"
    filename.write_text('{"text":"Private synthetic command text"')
    result = CliRunner().invoke(cli.app, ["screening", "write", "job", str(filename)])
    assert result.exit_code == 1
    assert "Private synthetic command text" not in result.output
    filename.write_text("null")
    result = CliRunner().invoke(cli.app, ["screening", "write", "job", str(filename)])
    assert result.exit_code == 1
    assert "Invalid screening command file" in result.output
