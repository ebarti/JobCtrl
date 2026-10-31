import path from "node:path";

import { AUTOMATION_PROJECT_DIR, createSourcePythonRuntime, type PythonRuntimeCommandResolver } from "../src/python-runtime.js";

/** Registered RPC and real CLI retry with an empty synthetic credential store. */
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
      if (invocation.kind === "cli" && invocation.args[0] === "retry") {
        return source.resolve({ kind: "script", args: invocation.args, script: `
import functools, os, runpy, sys
from jobctrl import config
from jobctrl.native_credentials import PROVIDER_SECRET_KEYS, load_native_credential_fallbacks
assert not any(os.environ.get(key) for key in PROVIDER_SECRET_KEYS)
class EmptyNativeStore:
    kind = "synthetic_empty"
    def read(self, key):
        assert key in PROVIDER_SECRET_KEYS
        return None
config.load_native_credential_fallbacks = functools.partial(
    load_native_credential_fallbacks, store=EmptyNativeStore(),
)
sys.argv = ["jobctrl", *sys.argv[1:]]
runpy.run_module("jobctrl", run_name="__main__", alter_sys=True)
` }, context);
      }
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
