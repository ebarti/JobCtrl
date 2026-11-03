import path from "node:path";
import { buildApp } from "../../../apps/api/src/server.js";
import { drainDefaultJsonRpcDispatchers } from "../../../apps/api/src/json-rpc-adapter.js";
import { initializeExactDatabase } from "../../../apps/api/test/exact-schema.js";

const appDir = process.env.JOBCTRL_DIR!;
const dbPath = path.join(appDir, "jobctrl.db");
initializeExactDatabase(dbPath);
const runtime = {
  id: "owned-synthetic-rpc",
  resolve(invocation: { kind: string; args: readonly string[] }) {
    if (invocation.kind !== "cli" || invocation.args.length !== 1 || invocation.args[0] !== "rpc") {
      throw new Error("Unapproved synthetic runtime command");
    }
    return {
      executable: process.env.TASK_PYTHON!,
      argv: [path.join(process.env.TASK_PROOF_SCRIPTS!, "rpc-guard.py"), ...invocation.args],
      cwd: appDir,
      env: process.env,
    };
  },
};
const prohibited = async () => { throw new Error("Credential access forbidden in synthetic proof"); };
const app = buildApp({ appDir, dbPath, configPath: path.join(appDir, "config.json"), pythonRuntime: runtime,
  credentialStore: { list: prohibited, set: prohibited, delete: prohibited, applyBatch: prohibited },
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.TASK_API_PORT) });
console.log("Owned synthetic API ready");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await drainDefaultJsonRpcDispatchers();
      console.log("RPC dispatchers drained");
      await app.close();
      console.log("Owned synthetic API closed");
      process.exit(0);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  });
}
