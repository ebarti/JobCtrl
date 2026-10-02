import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterviewCatalogReader } from "../src/interview-catalog.js";
import { InterviewCatalogAssetError } from "../src/interview-catalog-asset.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import { syntheticInterviewCatalogAsset } from "./interview-fixture.js";

describe("global interview catalog", () => {
  let directory: string;
  let options: BuildAppOptions;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-catalog-http-"));
    options = { appDir: directory, dbPath: path.join(directory, "absent.db"), configPath: path.join(directory, "absent.json"),
      interviewCatalogAssetLoader: syntheticInterviewCatalogAsset };
  });
  afterEach(() => { fs.rmSync(directory, { force: true, recursive: true }); });

  it("exposes the complete committed research catalog with its immutable guidance", async () => {
    const { interviewCatalogAssetLoader: _loader, ...sourceOptions } = options;
    const app = buildApp(sourceOptions);
    const response = await app.inject({ method: "GET", url: "/v1/interviews/catalog" });
    expect(response.statusCode, response.body).toBe(200);
    const catalog = response.json().catalog;
    expect(catalog.questions).toHaveLength(121);
    expect(catalog.topics).toHaveLength(15);
    expect(catalog.sources).toHaveLength(57);
    expect(catalog.authors).toHaveLength(20);
    expect(catalog.relationships).toHaveLength(31);
    expect(catalog.retiredQuestions).toEqual([expect.objectContaining({ id: "C08", replacementId: null })]);
    for (const id of ["B11", "TS09"]) expect(catalog.questions.find((card: { id: string }) => card.id === id).defaultAnswerFormat).toBe("principle");
    const c07 = await app.inject({ method: "GET", url: "/v1/interviews/questions/C07" });
    expect(c07.json().question.answer).toContain("budgeted range");
    await app.close();
  });

  it("browses offline with no SQLite database, job, worker or provider", async () => {
    const dispatch = vi.fn();
    const app = buildApp({ ...options, actionDispatcher: dispatch, providerDispatcher: { call: dispatch, close: async () => {} } });
    const response = await app.inject({ method: "GET", url: "/v1/interviews/catalog" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, page: 1, pageSize: 121, total: 2, catalog: { maturity: "research_draft" } });
    expect(fs.existsSync(options.dbPath)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("filters explicit metadata/source links and bounds pagination", async () => {
    const app = buildApp(options);
    const first = await app.inject({ method: "GET", url: "/v1/interviews/catalog?role=staff_principal&answerFormat=principle&topic=technical-strategy&source=S01&pageSize=1" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ total: 1, catalog: { questions: [{ id: "TS09" }] } });
    const second = await app.inject({ method: "GET", url: "/v1/interviews/catalog?page=2&pageSize=1" });
    expect(second.json()).toMatchObject({ total: 2, catalog: { questions: [{ id: "TS10" }] } });
    const search = await app.inject({ method: "GET", url: "/v1/interviews/catalog?search=boundary" });
    expect(search.json().catalog.questions.map((q: { id: string }) => q.id)).toEqual(["TS10"]);
    for (const query of ["pageSize=122", "page=1001", "search=" + "x".repeat(201), "role=executive-ish", "unknown=1"]) {
      expect((await app.inject({ method: "GET", url: `/v1/interviews/catalog?${query}` })).statusCode).toBe(400);
    }
    await app.close();
  });

  it("returns explicit unknown and retired semantics and bounded question IDs", async () => {
    const app = buildApp(options);
    const detail = await app.inject({ method: "GET", url: "/v1/interviews/questions/TS09" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ question: { id: "TS09", alternatives: "Sound alternatives are valid" } });
    const retired = await app.inject({ method: "GET", url: "/v1/interviews/questions/C08" });
    expect(retired.statusCode).toBe(410);
    expect(retired.json()).toMatchObject({ error: "retired_question", questionId: "C08" });
    expect((await app.inject({ method: "GET", url: "/v1/interviews/questions/ZZ99" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/interviews/questions/bad" })).statusCode).toBe(400);
    await app.close();
  });

  it("keeps normal loopback peer and origin security on global reads", async () => {
    const app = buildApp(options);
    const remote = await app.inject({ method: "GET", url: "/v1/interviews/catalog", remoteAddress: "192.0.2.10" });
    expect(remote.statusCode).toBe(403);
    const hostile = await app.inject({ method: "GET", url: "/v1/interviews/catalog", headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } });
    // Normal GET semantics deny cross-origin browser access through CORS.
    expect(hostile.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("fails closed on missing or invalid assets without exposing parser/path details", async () => {
    const app = buildApp({ ...options, interviewCatalogAssetLoader: () => { throw new Error("private path"); } });
    const response = await app.inject({ method: "GET", url: "/v1/interviews/catalog" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("interview_catalog_unavailable");
    expect(response.body).not.toContain("private path");
    await app.close();
    const asset = syntheticInterviewCatalogAsset();
    (asset.data as { catalogDigest: string }).catalogDigest = "0".repeat(64);
    expect(() => createInterviewCatalogReader(() => asset)()).toThrow(InterviewCatalogAssetError);
  });

  it("rejects invalid generation selection before database access or worker spend", async () => {
    const dispatch = vi.fn();
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    for (const [payload, status] of [
      [{ selectedQuestionIds: ["ZZ99"] }, 404], [{ selectedQuestionIds: ["C08"] }, 410],
      [{ selectedQuestionIds: ["TS09", "TS09"] }, 400], [{ selectedQuestionIds: Array(17).fill("TS09") }, 400],
      [{ catalogBinding: { catalogRevision: "obsolete", catalogDigest: "0".repeat(64) } }, 409],
      [{ knownCriteria: ["x".repeat(1001)] }, 400],
    ] as const) {
      const response = await app.inject({ method: "POST", url: "/v1/jobs/11111111-1111-4111-8111-111111111111/actions/generate-interview-prep", payload });
      expect(response.statusCode, response.body).toBe(status);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(fs.existsSync(options.dbPath)).toBe(false);
    await app.close();
  });
});
