import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS, MaterialLocaleRequestSchema, MaterialLocaleParamsSchema } from "../src/contracts.js";
import { materialLocaleVariants, LocaleVariantError } from "../src/locale-variants.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";
import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";

const JOB = "90000000-0000-4000-8000-000000000039";
const result = { supportedLocales: ["en", "es"], variants: [], sources: [], profileVersion: 1 };
const context = { tenantId: "local", expectedAppDir: "/tmp/owned-locale", expectedDbPath: "/tmp/owned-locale/owned.db", jobId: JOB };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function dispatcher(value: unknown = result): JsonRpcDispatcher {
  return { call: vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: value })), close: vi.fn(async () => {}) };
}

describe("locale worker boundary", () => {
  it("binds canonical job and exact runtime, and keeps demo model work unavailable", async () => {
    const worker = dispatcher();
    await expect(materialLocaleVariants(worker, context, { operation: "history" })).resolves.toEqual(result);
    expect(worker.call).toHaveBeenCalledWith("material_locale_variants", { ...context, request: { operation: "history" } });
    expect(ENDPOINTS.materialLocaleVariants.demo.class).toBe("unavailable");
  });
  it.each([{}, { ...result, foreign: true }, { ...result, variants: [{ sourceLocale: "en" }] }])("rejects malformed worker result %#", async value => {
    await expect(materialLocaleVariants(dispatcher(value), context, { operation: "history" })).rejects.toThrow("invalid_locale_worker_result");
  });
  it.each(["stale_locale_revision", "stale_locale_source", "provider_unavailable", "budget_denied", "unsupported_language"]) ("preserves actionable failure %s", async code => {
    const worker: JsonRpcDispatcher = { call: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: code } }), close: async () => {} };
    await expect(materialLocaleVariants(worker, context, { operation: "history" })).rejects.toMatchObject({ code, status: code.startsWith("stale_") ? 409 : code === "provider_unavailable" ? 503 : code === "budget_denied" ? 429 : 400 });
  });
  it("rejects unsupported operations, unsafe shapes and URL job locators", () => {
    expect(MaterialLocaleRequestSchema.safeParse({ operation: "translate_and_submit" }).success).toBe(false);
    expect(MaterialLocaleRequestSchema.safeParse({ operation: "history", ignored: true }).success).toBe(false);
    expect(MaterialLocaleParamsSchema.safeParse({ ...context, jobId: "https://example.test/job", request: { operation: "history" } }).success).toBe(false);
  });
  it("maps transport failure without raw exceptions", async () => {
    const worker: JsonRpcDispatcher = { call: async () => { throw new Error("private diagnostic"); }, close: async () => {} };
    await expect(materialLocaleVariants(worker, context, { operation: "history" })).rejects.toThrow(LocaleVariantError);
  });
  it("executes the registered production HTTP route with its strict RPC contract", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-owned-locale-api-"));
    const dbPath = path.join(root, "owned.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,'https://example.test/owned','Owned job','Synthetic Employer')").run(JOB);
    db.close();
    const worker = dispatcher();
    const app = buildApp({ appDir: root, dbPath, configPath: path.join(root, "config.json"), providerDispatcher: worker });
    cleanups.push(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/material-locales`, payload: { operation: "history" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(worker.call).toHaveBeenCalledWith("material_locale_variants", { tenantId: "local", jobId: JOB, expectedAppDir: root, expectedDbPath: dbPath, request: { operation: "history" } });
    const invalid = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/material-locales`, payload: { operation: "history", extra: true } });
    expect(invalid.statusCode).toBe(400);
    const absent = await app.inject({ method: "POST", url: `/v1/jobs/90000000-0000-4000-8000-000000000038/material-locales`, payload: { operation: "history" } });
    expect(absent.statusCode).toBe(404);
    expect(worker.call).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch model work when the API database is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-owned-locale-api-"));
    const worker = dispatcher();
    const app = buildApp({ appDir: root, dbPath: path.join(root, "absent.db"), configPath: path.join(root, "config.json"), providerDispatcher: worker });
    cleanups.push(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/material-locales`, payload: { operation: "history" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("db_not_found");
    expect(worker.call).not.toHaveBeenCalled();
  });
});

it("runs locale generation/reviews/accepted exports through production HTTP and real registered Python RPC", async () => {
  const { AUTOMATION_PROJECT_DIR } = await import("../src/python-runtime.js");
  const { SubprocessJsonRpcAdapter } = await import("../src/json-rpc-adapter.js");
  const { MaterialLocaleHistorySchema } = await import("../src/contracts.js");
  const python = path.join(AUTOMATION_PROJECT_DIR, ".venv/bin/python");
  expect(fs.existsSync(python), "Controller-prepared locked worker interpreter must exist; this required case cannot skip").toBe(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-native-locale-api-"));
  const dbPath = path.join(root, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const text = "Synthetic Name · Historical Title · 2020\nDelivered 25%";
  const sourcePath = path.join(root, "accepted-source.txt");
  fs.writeFileSync(sourcePath, text);
  fs.writeFileSync(path.join(root, ".locale-variants-test"), "Owned native API model port fixture");
  const db = new Database(dbPath);
  db.prepare("INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,'https://example.test/locale','Owned job','Synthetic Employer')").run(JOB);
  db.exec("INSERT INTO candidate_profiles(tenant_id,profile_id,version,personal_full_name,updated_at) VALUES('local','default',1,'Synthetic Name','2026-10-09')");
  db.exec("INSERT INTO candidate_profile_experience_entries(tenant_id,profile_id,entry_id,position_index,title,company,date_range) VALUES('local','default','entry',0,'Historical Title','Synthetic Employer','2020')");
  db.exec("INSERT INTO candidate_profile_experience_bullets VALUES('local','default','entry',0,'Delivered 25%')");
  db.exec("INSERT INTO candidate_profile_education_entries(tenant_id,profile_id,entry_id,position_index,degree) VALUES('local','default','education',0,'Credential Original')");
  db.prepare("INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'approved','2026-10-09','2026-10-09')").run(JOB);
  db.prepare("INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES('local',?,1,'tailored_resume','native-source','approved',?,'text','2026-10-09')").run(JOB, sourcePath);
  db.close();
  const worker = new SubprocessJsonRpcAdapter({ appDir: root, pythonRuntime: {
    id: "owned-native-locale-rpc-model-port",
    resolve: () => ({ executable: python, argv: ["-m", "tests.test_locale_variants_integration"], cwd: AUTOMATION_PROJECT_DIR,
      env: { ...process.env, JOBCTRL_DIR: root, JOBCTRL_DB_PATH: dbPath, JOBCTRL_CONFIG_PATH: path.join(root, "config.json") } }),
  } });
  const opener = vi.fn(async (_path: string) => {});
  const app = buildApp({ appDir: root, dbPath, configPath: path.join(root, "config.json"), providerDispatcher: worker, artifactOpener: opener });
  cleanups.push(async () => { await app.close(); await worker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function operation(request: Record<string, unknown>) {
    const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/material-locales`, payload: request });
    expect(response.statusCode, response.body).toBe(200);
    return MaterialLocaleHistorySchema.parse(response.json());
  }
  let snapshot = (await operation({ operation: "generate", sourceArtifactId: "native-source", sourceLocale: "en", targetLocale: "es", expectedGeneration: 1, expectedProfileVersion: 1 })).variants[0]!;
  for (const dimension of ["terminology", "formatting"]) snapshot = (await operation({ operation: "review", revisionId: snapshot.revisionId, expectedVersion: snapshot.version, dimension, decision: "accepted", note: "Native API review" })).variants[0]!;
  snapshot = (await operation({ operation: "accept", revisionId: snapshot.revisionId, expectedVersion: snapshot.version })).variants[0]!;
  for (const format of ["txt", "html", "docx"]) snapshot = (await operation({ operation: "export", revisionId: snapshot.revisionId, expectedVersion: snapshot.version, format })).variants[0]!;
  expect(snapshot.accepted).toBe(true);
  expect(snapshot.authorityStatus).toBe("recorded");
  expect(snapshot.exports.map(item => item.format)).toEqual(["txt", "html", "docx"]);
  for (const item of snapshot.exports) {
    const detail = await app.inject({ method: "GET", url: `/v1/artifacts/${item.artifactId}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().artifact.resumeTemplate).toBeNull();
    const open = await app.inject({ method: "POST", url: `/v1/artifacts/${item.artifactId}/open` });
    expect(open.statusCode, open.body).toBe(200);
  }
  expect(opener).toHaveBeenCalledTimes(3);
  expect(fs.readFileSync(sourcePath, "utf8")).toBe(text);
  const prior = snapshot;
  const stale = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/material-locales`, payload: { operation: "export", revisionId: snapshot.revisionId, expectedVersion: 1, format: "txt" } });
  expect(stale.statusCode).toBe(409);
  expect((await operation({ operation: "history" })).variants[0]).toEqual(prior);
}, 30_000);
