import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import {
  loadE2eDbPath,
  refreshE2eWorkerHeartbeat,
} from "../fixtures/e2e-state.js";

test("@mobile E2E worker fixture restores a healthy heartbeat", async ({
  request,
}) => {
  const db = new Database(loadE2eDbPath());
  try {
    db.prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?").run(
      "2020-01-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }

  refreshE2eWorkerHeartbeat();

  const response = await request.get("/v1/health");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    worker: { status: "healthy" },
  });
});
