import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ENDPOINTS, RpcMethods, ScreeningCommandSchema } from "../src/contracts.js";
import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";
import { buildApp } from "../src/server.js";
import { screeningEventReferences } from "../src/screening-answers.js";
import { initializeExactDatabase } from "./exact-schema.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const binding = { profileVersion: 1, profileHash: "a".repeat(64), postingHash: "b".repeat(64), destination: "https://example.test/apply", posting: "Synthetic posting", materials: [], facts: [], sensitiveFactIds: [] };
const state = { questionId: "owned-question", jobId, applicationId: "owned-attempt", revision: 1, question: "Synthetic question", context: "Synthetic context", captureBinding: binding, draft: null, accepted: null, action: "capture", snapshotId: "owned-snapshot", recordedAt: "2026-10-08T00:00:00Z" };
const read = { ok: true, jobId, questions: [state], history: [state], library: [], facts: [], sourceBinding: binding, sourceFailure: null, determinations: [], failures: [] };

it("dispatches real HTTP reads and commands with API-derived identity and rejects foreign completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-owned-screening-"));
  const filename = path.join(root, "synthetic.db");
  initializeExactDatabase(filename);
  const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({ jsonrpc: "2.0", id: 1, result: read }));
  const app = buildApp({ dbPath: filename, configPath: path.join(root, "config.json"), providerDispatcher: { call, close: async () => {} } });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}/screening-answers` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(read);
    expect(call).toHaveBeenLastCalledWith(RpcMethods.ScreeningAnswers, { tenantId: "local", jobId, expectedAppDir: root, expectedDbPath: filename });
    call.mockResolvedValueOnce({ jsonrpc: "2.0", id: 1, result: { ok: true, jobId, state } });
    const command = { action: "capture", expectedRevision: 0, idempotencyKey: "capture", question: state.question, context: state.context, applicationId: state.applicationId };
    const written = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/screening-answers`, payload: command });
    expect(written.statusCode, written.body).toBe(200);
    expect(call.mock.calls.at(-1)).toEqual([RpcMethods.ScreeningAnswers, expect.objectContaining({ command: ScreeningCommandSchema.parse(command) })]);
    call.mockResolvedValueOnce({ jsonrpc: "2.0", id: 1, result: { ok: true, jobId, state: { ...state, jobId: "foreign-job" } } });
    const foreign = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/screening-answers`, payload: command });
    expect(foreign.statusCode).toBe(502);
    const injectedIdentity = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/screening-answers`, payload: { ...command, expectedDbPath: "/foreign" } });
    expect(injectedIdentity.statusCode).toBe(400);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

describe("private screening contract", () => {
  it("keeps demo generation/review unavailable and rejects form authority", () => {
    expect(ENDPOINTS.screeningAnswers.demo.class).toBe("unavailable");
    expect(ENDPOINTS.writeScreeningAnswer.demo.class).toBe("unavailable");
    expect(ScreeningCommandSchema.safeParse({ action: "use", expectedRevision: 1, idempotencyKey: "x", submit: true }).success).toBe(false);
  });
  it("reduces general event payloads to references without private text", () => {
    expect(screeningEventReferences({ state: { ...state, accepted: { text: "private answer", binding: { facts: ["private fact"] } } } })).toEqual({ questionId: state.questionId, snapshotId: state.snapshotId, revision: 1 });
    expect(screeningEventReferences({ entry: { libraryId: "entry", snapshotId: "snapshot", answer: { text: "private" } } })).toEqual({ libraryId: "entry", snapshotId: "snapshot" });
  });
});
