import type { FastifyInstance } from "fastify";
import { drainDefaultJsonRpcDispatchers } from "./json-rpc-adapter.js";

export async function shutdownApi(app: FastifyInstance, closeTimeoutMs = 30_000): Promise<void> {
  const failures: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("API requests did not drain before the shutdown deadline.")), closeTimeoutMs);
      }),
    ]);
  } catch (error) { failures.push(error); }
  finally { if (timer) clearTimeout(timer); }
  // Even a failed close hook must fence RPC admission and attempt to drain the
  // process-owned children. Keep both errors so failure is never a clean stop.
  try { await drainDefaultJsonRpcDispatchers(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "API shutdown did not complete cleanly");
}

/** Handle direct API signals; a successful return is not a native runtime receipt. */
export function installApiShutdown(app: FastifyInstance): void {
  let stopping: Promise<void> | undefined;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopping ??= (async () => {
        try {
          await shutdownApi(app);
        } catch (error) {
          app.log.error(error, "API shutdown did not complete cleanly");
          process.exitCode = 1;
        }
      })();
    });
  }
}
