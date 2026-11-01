import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTOMATION_PROJECT_DIR, type PythonRuntimeCommandResolver } from "../src/python-runtime.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";

/** Registered handlers and workflow-spec builders are real. Only Temporal's
 * WorkflowStarter/handle are synthetic; no provider or acquisition executes. */
const WORKFLOW_PROBE = String.raw`
import asyncio, json, os, sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowResult
from jobctrl.pipeline.workflow import JobPipelineWorkflowResult
from jobctrl.domain.rpc.messages import JsonRpcRequest
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
import jobctrl.workflow_specs as workflow_specs
root = Path(os.environ["JOBCTRL_DIR"])
assert (root / ".rpc-workflow-owned").is_file()
control = root / "rpc-control.json"
trace = root / "rpc-trace.jsonl"
def record(kind, **data):
    with trace.open("a") as file:
        file.write(json.dumps(dict(kind=kind, at=datetime.now(timezone.utc).isoformat(), **data)) + "\n")
record("runtime", workflowSpecsPath=str(Path(workflow_specs.__file__).resolve()))
def mode():
    return json.loads(control.read_text()).get("mode", "success")
class Handle:
    def __init__(self, identity, discover):
        self.id = identity
        self.discover = discover
        self.first_execution_run_id = "synthetic-first-run"
    async def result(self):
        record("waiting", workflowId=self.id)
        while mode() == "hold":
            await asyncio.sleep(0.01)
        if mode() == "wait_failure":
            raise RuntimeError("synthetic wait failure")
        if mode() == "invalid_result":
            return {"stages_completed": "malformed"}
        if mode() == "wrong_result_family":
            return DiscoverWorkflowResult() if not self.discover else JobPipelineWorkflowResult()
        record("completed", workflowId=self.id)
        if mode() == "stage_failure":
            return JobPipelineWorkflowResult(stages_failed=["score"], failure="synthetic stage failure", error_code="synthetic")
        if mode() == "stage_failure_without_message":
            return JobPipelineWorkflowResult(stages_failed=["score"])
        if self.discover:
            return DiscoverWorkflowResult(families_completed=["synthetic-source"])
        return JobPipelineWorkflowResult(stages_completed=["score", "tailor", "cover"])
async def starter(spec):
    record("start", workflowId=spec.workflow_id, input=asdict(spec.args[0]), reusePolicy=str(spec.id_reuse_policy))
    if mode() == "start_failure":
        raise RuntimeError("synthetic start failure")
    identity = spec.workflow_id or "synthetic-workflow"
    registry_path = root / "rpc-workflow-registry.json"
    registry = json.loads(registry_path.read_text()) if registry_path.exists() else {}
    record("attached", workflowId=identity, reattached=identity in registry)
    registry[identity] = "synthetic-first-run"
    registry_path.write_text(json.dumps(registry))
    return Handle(identity, spec.workflow is DiscoverWorkflow)
server = JsonRpcServer(workflow_starter=starter)
register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
for raw in sys.stdin:
    request = JsonRpcRequest.from_dict(json.loads(raw))
    record("request", request=json.loads(raw))
    print(json.dumps(dict(jsonrpc="2.0", method="progress", params={"phase":"synthetic"})), flush=True)
    response = server.dispatch(request)
    body = response.to_dict()
    if mode() == "invalid_ack":
        body = dict(jsonrpc="2.0", id=request.id, result={"workflowId":"missing-run-id"})
    if mode() == "invalid_envelope":
        body["error"] = dict(code=-32603, message="synthetic conflicting envelope")
    record("response", response=body)
    print(json.dumps(body), flush=True)
`;

export function workflowRpcFixture(root: string, dbPath: string, configPath: string) {
  fs.writeFileSync(path.join(root, ".rpc-workflow-owned"), "owned synthetic workflow boundary");
  const control = path.join(root, "rpc-control.json");
  const trace = path.join(root, "rpc-trace.jsonl");
  fs.writeFileSync(control, JSON.stringify({ mode: "success" }));
  const runtime: PythonRuntimeCommandResolver = {
    id: `registered-workflow-probe:${root}`,
    resolve: () => ({
      executable: path.join(AUTOMATION_PROJECT_DIR, ".venv/bin/python"),
      argv: ["-u", "-c", WORKFLOW_PROBE], cwd: root,
      env: { ...process.env, PYTHONPATH: path.join(AUTOMATION_PROJECT_DIR, "src"), JOBCTRL_DIR: root, JOBCTRL_DB_PATH: dbPath, JOBCTRL_CONFIG_PATH: configPath },
    }),
  };
  const adapter = new SubprocessJsonRpcAdapter({ appDir: root, pythonRuntime: runtime, requestTimeoutMs: 10_000 });
  return {
    adapter,
    mode: (mode: string) => {
      fs.writeFileSync(control + ".next", JSON.stringify({ mode }));
      fs.renameSync(control + ".next", control);
    },
    rows: () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [],
    retain: (name: string, observations: unknown) => {
      const destination = process.env.JOBCTRL_RPC_EVIDENCE_DIR;
      if (!destination) return;
      fs.mkdirSync(destination, { recursive: true });
      const probePath = path.join(destination, "registered-workflow-probe.py");
      fs.writeFileSync(probePath, WORKFLOW_PROBE);
      fs.writeFileSync(path.join(destination, `${name}.json`), JSON.stringify({ recordedAt: new Date().toISOString(), observations, probe: { path: probePath, sha256: createHash("sha256").update(WORKFLOW_PROBE).digest("hex") }, trace: fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "", seams: "Synthetic WorkflowStarter/handle; registered Python handlers, workflow spec builders and result dataclasses unchanged. No live acquisition or model quality proof." }, null, 2));
    },
  };
}
