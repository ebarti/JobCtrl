import path from "node:path";

import { AUTOMATION_PROJECT_DIR, createSourcePythonRuntime, type PythonRuntimeCommandResolver } from "../src/python-runtime.js";

/** Registered RPC without bootstrap; preserve requested CLI and script commands. */
export function createRetryFixturePythonRuntime(): PythonRuntimeCommandResolver {
  const source = createSourcePythonRuntime({ environment: {
    PATH: process.env.PATH,
    LANGFUSE_DISABLE: "1",
    OTEL_SDK_DISABLED: "true",
    PYTHONPATH: [path.join(AUTOMATION_PROJECT_DIR, "src"), AUTOMATION_PROJECT_DIR].join(path.delimiter),
  } });
  return {
    id: "owned-retry-rpc-fixture",
    resolve: (invocation, context) => {
      if (invocation.kind !== "cli" || invocation.args.length !== 1 || invocation.args[0] !== "rpc") {
        return source.resolve(invocation, context);
      }
      return source.resolve({ kind: "script", args: [], script: `
import socket, subprocess
def denied(*_args, **_kwargs):
    raise AssertionError("External work is outside the owned retry fixture")
socket.socket.connect = denied
socket.socket.connect_ex = denied
subprocess.Popen = denied
from jobctrl import config
config.load_env = denied
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
server = JsonRpcServer()
register_default_handlers(server, canceler=denied)
server.serve()
` }, context);
    },
  };
}
