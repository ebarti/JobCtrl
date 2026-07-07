import { randomUUID } from "node:crypto";

import type { ActionDispatcher, ProfileImporter } from "./local-actions.js";

/**
 * INSPECT-01 E2E support.
 *
 * The Playwright harness runs the real dev API (no in-test `actionDispatcher`
 * override) so it exercises the live route, worker-readiness gate, and HTTP
 * response shape. It does NOT run a worker subprocess or an LLM, so the real
 * `SubprocessJsonRpcAdapter` cannot be used — it would spawn `uv run jobctl
 * rpc` and attempt a real generation.
 *
 * When `JOBCTL_E2E_STUB_DISPATCH` is set the API uses this deterministic
 * dispatcher instead: it acknowledges the action as `queued` (so the route
 * returns 202 exactly as production does) without any side effect. The E2E spec
 * then injects the terminal `ResumeApproved` event into SQLite to drive the SSE
 * → invalidation → UI realtime loop, mirroring `e2e/tests/dry-run.spec.ts`.
 *
 * This flag is set only by `apps/web/e2e/playwright.config.ts` and is never
 * enabled in normal local or production runs.
 */
export function isE2eStubDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes((env.JOBCTL_E2E_STUB_DISPATCH ?? "").toLowerCase());
}

export const e2eStubActionDispatcher: ActionDispatcher = async () => ({
  status: "queued",
  actionId: `e2e-act-${randomUUID()}`,
  runId: `e2e-run-${randomUUID()}`,
});

export const e2eStubProfileImporter: ProfileImporter = async (input) => {
  const actionId = `e2e-profile-act-${randomUUID()}`;
  const runId = `e2e-profile-run-${randomUUID()}`;
  return {
    profile: {
      personal: {
        full_name: "E2E Imported Candidate",
      },
    },
    style: {},
    templateText: "\\documentclass{article}",
    source: {
      filename: input.filename,
      bytes: input.pdfBytes.length,
      e2e: true,
    },
    action: {
      ok: true,
      runId,
      actionId,
      action: "profile_import",
      status: "queued",
      jobKey: "profile",
      command: {
        action: "profile_import",
        jobKey: "profile",
      },
    },
  };
};
