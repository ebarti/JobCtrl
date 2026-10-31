import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

it("reports pending or unresolved accounting without a known zero total", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-spend-health-"));
  const dbPath = path.join(directory, "jobctrl.db");
  const configPath = path.join(directory, "config.json");
  initializeExactDatabase(dbPath);
  fs.writeFileSync(configPath, JSON.stringify({ daily_budget_usd: 12.5 }));
  const receiptDir = path.join(directory, ".jobctrl.db.llm-spend-pending");
  fs.mkdirSync(receiptDir);
  const receipt = path.join(receiptDir, "synthetic.jsonl");
  fs.writeFileSync(receipt, '{"lane":"scoring"}\n');
  const forbidden = async () => { throw new Error("external access is outside this test"); };
  const app = buildApp({
    dbPath, configPath, appDir: directory, runtimeEnvironment: {},
    credentialStore: { list: forbidden, set: forbidden, delete: forbidden, applyBatch: forbidden },
    pythonRuntime: { id: "denied", resolve: () => { throw new Error("Python is outside this test"); } },
    providerDispatcher: { call: forbidden, close: vi.fn(async () => undefined) },
  });
  try {
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    const digest = await app.inject({ method: "GET", url: "/v1/digest" });
    expect(health.statusCode, health.body).toBe(200);
    expect(health.json().llmSpend).toMatchObject({
      status: "incomplete", inputTokens: null, outputTokens: null, estimatedUsd: null, remainingUsd: null,
      lanes: { scoring: { status: "incomplete", totalTokens: null } },
    });
    expect(digest.statusCode, digest.body).toBe(200);
    expect(digest.json().budget).toMatchObject({ status: "incomplete", estimatedUsd: null, remainingUsd: null });
    fs.unlinkSync(receipt);
    const settled = await app.inject({ method: "GET", url: "/v1/health" });
    expect(settled.json().llmSpend).toMatchObject({ status: "ok", estimatedUsd: 0 });
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
