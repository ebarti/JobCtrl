import { randomUUID } from "node:crypto";

import type { ActionDispatcher } from "./local-actions.js";

/**
 * INSPECT-01 E2E support.
 *
 * The Playwright harness runs the real dev API (no in-test `actionDispatcher`
 * override) so it exercises the live route, worker-readiness gate, and HTTP
 * response shape. It does NOT run a worker subprocess or an LLM, so the real
 * `SubprocessJsonRpcAdapter` cannot be used — it would spawn `uv run jobhunter
 * rpc` and attempt a real generation.
 *
 * When `JOBHUNTER_E2E_STUB_DISPATCH` is set the API uses this deterministic
 * dispatcher instead: it acknowledges the action as `queued` (so the route
 * returns 202 exactly as production does) without any side effect. The E2E spec
 * then injects the terminal `ResumeApproved` event into SQLite to drive the SSE
 * → invalidation → UI realtime loop, mirroring `e2e/tests/dry-run.spec.ts`.
 *
 * This flag is set only by `apps/web/e2e/playwright.config.ts` and is never
 * enabled in normal local or production runs.
 */
export function isE2eStubDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes((env.JOBHUNTER_E2E_STUB_DISPATCH ?? "").toLowerCase());
}

export const e2eStubActionDispatcher: ActionDispatcher = async () => ({
  status: "queued",
  actionId: `e2e-act-${randomUUID()}`,
  runId: `e2e-run-${randomUUID()}`,
});
