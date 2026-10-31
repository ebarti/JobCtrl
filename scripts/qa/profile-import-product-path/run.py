"""Run exact source through local Temporal; only the model adapter is synthetic."""
import asyncio
import json
import os
import socket
from pathlib import Path

from jobctrl import config

def prohibited(*_args, **_kwargs):
    raise RuntimeError("credential lookup is prohibited in this synthetic test")

config.load_env = lambda: ()
config.load_native_credential_fallbacks = prohibited
config._load_native_credential_fallbacks = prohibited
config._find_macos_security_binary = lambda _name: None

from jobctrl.domain.profile.resume_extraction import ModelResumeExtractor
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.profile import factory
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.llm import check_spend_budget, enforce_spend_budget
from jobctrl.profile.activities import profile_import_activity
from jobctrl.profile.workflow import ProfileImportWorkflow
from temporalio.client import Client
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions
from tests.test_profile_import import _simple_pdf

class SyntheticModel:
    def chat_json(self, messages, *, response_schema, **_kwargs):
        source_payload = json.loads(messages[1].content)
        sources = source_payload["sources"]
        if response_schema["title"] == "ResumeExtraction":
            source = next(item for item in sources if item["source_id"] == "resume")
            text = source["text"]
            def field(value):
                assert value in text
                return {"value": value, "citations": [{"source_id": "resume", "quote": value}]}
            personal = dict.fromkeys(["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"])
            if "synthetic-race@example.invalid" in text:
                personal["email"] = field("synthetic-race@example.invalid")
                return {"personal": personal, "executive_profile": None, "experience": [], "education": [], "skills": []}
            personal["full_name"] = field("Synthetic imported name")
            return {
                "personal": personal, "executive_profile": None,
                "experience": [{"title": field("Synthetic imported role"), "company": field("Synthetic employer"),
                    "date_range": None, "location": None, "summary": None,
                    "bullets": [field("Synthetic imported accomplishment")]}],
                "education": [], "skills": [],
            }
        if response_schema["title"] == "CandidateInterpretation":
            source = next((item for item in sources if item["text"] == "Synthetic imported role"), None)
            if source is None:
                source = next(item for item in sources if item["text"] == "synthetic-race@example.invalid")
            cite = {"source_id": source["source_id"], "quote": source["text"]}
            def field(value): return {"value": value, "citations": [cite], "rationale": "Synthetic test determination"}
            return {"track": field("unknown"), "seniority": field("unknown"), "functions": [],
                "target_roles": [], "target_preferences": [], "experience_places": []}
        raise AssertionError("unexpected model determination")


def synthetic_dependencies(connection, *, tenant_id, lane, **_kwargs):
    assert tenant_id == "local" and lane == "profile"
    return {"llm": SyntheticModel(), "repository": SqliteDeterminationRepository(connection),
        "tenant_id": tenant_id, "provider": "synthetic", "model": "synthetic", "lane": lane,
        "preflight": lambda: enforce_spend_budget(lane=lane)}

factory.determination_dependencies = synthetic_dependencies

async def listener_owned(pid, port):
    probe = await asyncio.create_subprocess_exec(
        os.environ["TASK_LSOF"], "-nP", "-a", "-p", str(pid), f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpn",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await probe.communicate()
    if probe.returncode not in (0, 1):
        raise RuntimeError(f"listener proof failed: lsof exit {probe.returncode}: {stderr.decode().strip()}")
    fields = stdout.decode().splitlines()
    return f"p{pid}" in fields and f"n127.0.0.1:{port}" in fields


async def stop_and_reap(proc, name):
    if proc.returncode is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), 12)
        except TimeoutError:
            print(f"{name} required forced termination; retain the workspace", flush=True)
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await asyncio.wait_for(proc.wait(), 12)
    else:
        await proc.wait()
    print(f"Reaped {name} pid={proc.pid} status={proc.returncode}", flush=True)


async def main():
    workspace = Path(os.environ["JOBCTRL_DIR"])
    assert workspace == config.APP_DIR and workspace.parent == Path(os.environ["TASK_PROOF_ROOT"])
    pdf = _simple_pdf(["Synthetic imported name", "Synthetic imported role", "Synthetic employer", "Synthetic imported accomplishment"])
    (workspace.parent / "synthetic.pdf").write_bytes(pdf)
    email_only = _simple_pdf(["synthetic-race@example.invalid", "Synthetic resume without a name field", "Synthetic source for the import race"])
    (workspace.parent / "synthetic-email-only.pdf").write_bytes(email_only)
    # Reserve a random loopback port only long enough to select it; verify the
    # started PID owns the actual listener before allowing the product test.
    with socket.socket() as reserving:
        reserving.bind(("127.0.0.1", 0))
        port = reserving.getsockname()[1]
    log_path = workspace.parent / "temporal.log"
    server = None
    api = None
    child = None
    with log_path.open("wb") as server_log:
        try:
            server = await asyncio.create_subprocess_exec(
                os.environ["TASK_TEMPORAL_CLI"], "server", "start-dev", "--headless",
                "--ip", "127.0.0.1", "--port", str(port),
                stdout=server_log, stderr=server_log,
            )
            print(f"Started owned Temporal process pid={server.pid}, loopback port={port}", flush=True)
            for _ in range(150):
                if server.returncode is not None:
                    raise RuntimeError(f"owned Temporal exited early: {server.returncode}")
                if await listener_owned(server.pid, port):
                    break
                await asyncio.sleep(0.2)
            else:
                raise TimeoutError("owned Temporal PID did not establish its loopback listener")
            print(f"Verified loopback listener 127.0.0.1:{port} owned by pid={server.pid}", flush=True)
            client = await asyncio.wait_for(Client.connect(f"127.0.0.1:{port}"), timeout=15)
            restrictions = SandboxRestrictions.default.with_passthrough_modules("jobctrl")
            async with Worker(client, task_queue="jobctrl-default", workflows=[ProfileImportWorkflow],
                              activities=[profile_import_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                              workflow_runner=SandboxedWorkflowRunner(restrictions=restrictions)):
                with socket.socket() as reserving:
                    reserving.bind(("127.0.0.1", 0))
                    api_port = reserving.getsockname()[1]
                child_env = dict(os.environ, TEMPORAL_ADDRESS=f"127.0.0.1:{port}",
                                 TASK_API_PORT=str(api_port), TASK_API_URL=f"http://127.0.0.1:{api_port}")
                with (workspace.parent / "api.log").open("wb") as api_log:
                    api = await asyncio.create_subprocess_exec(
                        os.environ["TASK_NODE"],
                        "--import", os.environ["TASK_CHECKOUT"] + "/apps/api/node_modules/tsx/dist/loader.mjs",
                        str(Path(os.environ["TASK_PROOF_SCRIPTS"]) / "api-server.mts"),
                        cwd=os.environ["TASK_CHECKOUT"] + "/apps/api", env=child_env,
                        stdout=api_log, stderr=api_log,
                    )
                    print(f"Started owned API process pid={api.pid}, loopback port={api_port}", flush=True)
                    for _ in range(150):
                        if api.returncode is not None:
                            raise RuntimeError(f"owned API exited early: {api.returncode}; inspect api.log")
                        if await listener_owned(api.pid, api_port):
                            break
                        await asyncio.sleep(0.2)
                    else:
                        raise TimeoutError("owned API PID did not establish its loopback listener")
                    print(f"Verified loopback listener 127.0.0.1:{api_port} owned by pid={api.pid}", flush=True)
                    child = await asyncio.create_subprocess_exec(
                        os.environ["TASK_COREPACK"], "pnpm", "exec", "vitest", "run",
                        "src/contexts/profile/components/ProfileImportReview.product-path.test.tsx",
                        "--no-file-parallelism", "--maxWorkers=1", "--testTimeout=120000",
                        cwd=os.environ["TASK_CHECKOUT"] + "/apps/web", env=child_env)
                    try:
                        code = await asyncio.wait_for(child.wait(), timeout=180)
                    except TimeoutError:
                        raise
                    if code:
                        raise RuntimeError(f"synthetic product-path Vitest exited {code}")
        finally:
            cleanup_errors = []
            if child is not None:
                try:
                    await stop_and_reap(child, "Vitest")
                except Exception as error:
                    cleanup_errors.append(f"Vitest cleanup: {error}")
            if api is not None:
                try:
                    api_pid = api.pid
                    await stop_and_reap(api, "API")
                    if await listener_owned(api_pid, api_port):
                        raise RuntimeError("owned API listener remains after process exit")
                    print(f"Confirmed no loopback listener remains for reaped pid={api_pid}", flush=True)
                except Exception as error:
                    cleanup_errors.append(f"API cleanup: {error}")
            if server is not None:
                try:
                    pid = server.pid
                    await stop_and_reap(server, "Temporal")
                    if await listener_owned(pid, port):
                        raise RuntimeError("owned Temporal listener remains after process exit")
                    print(f"Confirmed no loopback listener remains for reaped pid={pid}", flush=True)
                except Exception as error:
                    cleanup_errors.append(f"Temporal cleanup: {error}")
            if cleanup_errors:
                raise RuntimeError("; ".join(cleanup_errors) + "; preserve the owned workspace")
    print("Synthetic product-path proof completed; Temporal worker stopped", flush=True)

if __name__ == "__main__":
    asyncio.run(main())
