import fs from "node:fs";
import { createRequire } from "node:module";

const { assertExpectedWorkspace } = createRequire(import.meta.url)(
  "../fixtures/owned-workspace.cjs",
) as {
  assertExpectedWorkspace(report: unknown): void;
};

export default async function globalSetup(): Promise<void> {
  const statePath = process.env["JOBCTRL_E2E_STATE_FILE"]!;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    workspace?: unknown;
  };
  assertExpectedWorkspace(state.workspace);

  const response = await fetch(
    `http://127.0.0.1:${process.env["JOBCTRL_LIVE_WORKER_CONTROL_PORT"]}/state`,
    {
      headers: {
        Authorization: `Bearer ${process.env["JOBCTRL_LIVE_WORKER_SMOKE_TOKEN"]}`,
      },
    },
  );
  const runtime = (await response.json()) as {
    providerCalls?: number;
    workerPaused?: boolean;
  };
  if (!response.ok || !runtime.workerPaused || runtime.providerCalls !== 0) {
    throw new Error(
      "Live-worker runtime did not reach its guarded paused state",
    );
  }

  const health = await fetch(
    `http://127.0.0.1:${process.env["JOBCTRL_E2E_API_PORT"]}/v1/health`,
  );
  const healthBody = (await health.json()) as {
    ok?: boolean;
    worker?: { status?: string };
  };
  if (
    !health.ok ||
    healthBody.ok !== true ||
    healthBody.worker?.status !== "healthy"
  ) {
    throw new Error(
      "Live-worker smoke requires the production API and real worker heartbeat",
    );
  }
}
