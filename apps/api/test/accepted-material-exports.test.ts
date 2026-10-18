import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptedMaterialExportsSchema, ENDPOINTS } from "../src/contracts.js";
import {
  acceptedMaterialExports,
  DOCX_CONTENT_TYPE,
} from "../src/accepted-material-exports.js";
import {
  SubprocessJsonRpcAdapter,
  type JsonRpcDispatcher,
} from "../src/json-rpc-adapter.js";
import { AUTOMATION_PROJECT_DIR } from "../src/python-runtime.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB = "90000000-0000-4000-8000-000000001030";
const context = {
  tenantId: "local",
  jobId: JOB,
  expectedAppDir: "/tmp/owned-export",
  expectedDbPath: "/tmp/owned-export/jobctrl.db",
};
const empty = {
  tenantId: "local",
  jobId: JOB,
  sources: [],
  exports: [],
  exportedArtifactId: null,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
function worker(result: unknown = empty): JsonRpcDispatcher {
  return {
    call: vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result })),
    close: vi.fn(async () => {}),
  };
}

describe("accepted export RPC boundary", () => {
  it("binds history to the exact runtime and disables the demo capability", async () => {
    const dispatcher = worker();
    expect(
      await acceptedMaterialExports(dispatcher, context, {
        operation: "history",
      }),
    ).toEqual(empty);
    expect(dispatcher.call).toHaveBeenCalledWith("accepted_material_exports", {
      ...context,
      request: { operation: "history" },
    });
    expect(ENDPOINTS.acceptedMaterialExports.demo.class).toBe("unavailable");
  });
  it.each([
    {},
    { ...empty, path: "/private/file" },
    { ...empty, tenantId: "foreign" },
    { ...empty, jobId: "90000000-0000-4000-8000-000000009999" },
    { ...empty, exportedArtifactId: "1" },
  ])("refuses invalid or foreign history %#", async (result) => {
    await expect(
      acceptedMaterialExports(worker(result), context, {
        operation: "history",
      }),
    ).rejects.toThrow(/invalid_export_worker/);
  });
  it.each([
    "private provider text /private/user/resume",
    "__proto__",
    "constructor",
  ])("does not disclose unknown worker failures %#", async (message) => {
    const dispatcher: JsonRpcDispatcher = {
      call: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message },
      }),
      close: async () => {},
    };
    await expect(
      acceptedMaterialExports(dispatcher, context, { operation: "history" }),
    ).rejects.toMatchObject({ code: "export_worker_unavailable", status: 503 });
  });
});

async function nativeApp() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-1030-native-api-"),
  );
  const dbPath = path.join(root, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO jobs(tenant_id,job_id,url,title,company,apply_status) VALUES('local',?,'https://example.test/owned','Owned DOCX job','Synthetic Employer','applied')",
  ).run(JOB);
  db.prepare(
    "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'approved','2026-10-17','2026-10-17')",
  ).run(JOB);
  db.prepare(
    "INSERT INTO application_review_decisions(tenant_id,decision_id,job_id,decision,decided_at,materials_generation) VALUES('local','owned-review',?,'approved','2026-10-17',1)",
  ).run(JOB);
  const sourceText =
    "Zoë Example\nAccepted 25% achievement · €1.2M\t2020–2024\n";
  for (const kind of ["tailored_resume", "cover_letter"]) {
    const filename = path.join(root, `${kind}.txt`);
    fs.writeFileSync(filename, sourceText);
    db.prepare(
      "INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json) VALUES('local',?,1,?,?,'approved',?,'text','2026-10-17',?)",
    ).run(
      JOB,
      kind,
      kind,
      filename,
      JSON.stringify({ locale: "fr-FR", private_prompt: "never disclose" }),
    );
  }
  const python = path.join(AUTOMATION_PROJECT_DIR, ".venv/bin/python");
  expect(
    fs.existsSync(python),
    "Prepared locked interpreter is required; no skipped native gate",
  ).toBe(true);
  const dispatcher = new SubprocessJsonRpcAdapter({
    appDir: root,
    pythonRuntime: {
      id: "owned-accepted-docx-rpc",
      resolve: () => ({
        executable: python,
        argv: ["-m", "jobctrl", "rpc"],
        cwd: AUTOMATION_PROJECT_DIR,
        env: {
          ...process.env,
          JOBCTRL_DIR: root,
          JOBCTRL_DB_PATH: dbPath,
          JOBCTRL_CONFIG_PATH: path.join(root, "config.json"),
        },
      }),
    },
  });
  const app = buildApp({
    appDir: root,
    dbPath,
    configPath: path.join(root, "config.json"),
    providerDispatcher: dispatcher,
  });
  cleanup.push(async () => {
    await app.close();
    await dispatcher.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const operation = (body: object) =>
    app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/material-exports`,
      payload: body,
    });
  async function history() {
    const response = await operation({ operation: "history" });
    expect(response.statusCode, response.body).toBe(200);
    return AcceptedMaterialExportsSchema.parse(response.json());
  }
  const preserve = () =>
    JSON.stringify(
      [
        "jobs",
        "job_materials",
        "job_materials_artifacts",
        "application_review_decisions",
      ].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    );
  return { root, db, app, operation, history, preserve, python, sourceText };
}
function request(
  source: Awaited<
    ReturnType<Awaited<ReturnType<typeof nativeApp>>["history"]>
  >["sources"][number],
  paper: "A4" | "Letter" = "A4",
) {
  return {
    operation: "export",
    sourceArtifactId: source.artifactId,
    expectedGeneration: source.generation,
    expectedSourceSha256: source.sha256,
    expectedMetadataSha256: source.metadataSha256,
    paper,
  };
}

it("exports both accepted materials through HTTP and real Python RPC, downloads editable bytes and preserves approval", async () => {
  const env = await nativeApp();
  const before = env.preserve();
  const snapshot = await env.history();
  expect(snapshot.sources).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain(env.root);
  for (const source of snapshot.sources)
    for (const paper of ["A4", "Letter"] as const) {
      const response = await env.operation(request(source, paper));
      expect(response.statusCode, response.body).toBe(200);
      const exported = AcceptedMaterialExportsSchema.parse(response.json());
      const receipt = exported.exports.find(
        (row) => row.artifactId === exported.exportedArtifactId,
      )!;
      expect(receipt.settings).toMatchObject({ paper, locale: "fr-FR" });
      expect(response.body).not.toContain("never disclose");
      expect(response.body).not.toContain(env.root);
      const file = await env.app.inject({
        method: "GET",
        url: `/v1/artifacts/${receipt.artifactId}/download.docx`,
      });
      expect(file.statusCode, file.body).toBe(200);
      expect(file.headers["content-type"]).toBe(DOCX_CONTENT_TYPE);
      expect(file.headers["content-disposition"]).toContain(`g1-${paper}.docx`);
      expect(file.headers["cache-control"]).toBe("no-store");
      expect(digest(file.rawPayload)).toBe(receipt.sha256);
      const downloaded = path.join(env.root, "download.docx");
      fs.writeFileSync(downloaded, file.rawPayload);
      const read = spawnSync(
        env.python,
        [
          "-c",
          "import json,sys; from docx import Document; d=Document(sys.argv[1]); print(json.dumps({'text':'\\n'.join(p.text for p in d.paragraphs), 'width':round(d.sections[0].page_width.inches,2)}))",
          downloaded,
        ],
        { encoding: "utf8" },
      );
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toEqual({
        text: env.sourceText,
        width: paper === "A4" ? 8.27 : 8.5,
      });
    }
  expect(env.preserve()).toBe(before);
  expect((await env.history()).exports).toHaveLength(4);
  const invalid = await env.operation({
    operation: "history",
    tenantId: "foreign",
  });
  expect(invalid.statusCode).toBe(400);
  const absent = await env.app.inject({
    method: "POST",
    url: "/v1/jobs/90000000-0000-4000-8000-000000009999/material-exports",
    payload: { operation: "history" },
  });
  expect(absent.statusCode).toBe(404);
}, 30_000);

it("refuses changed/rejected sources and corrupt/missing/foreign/symlinked downloads while retaining successful history", async () => {
  const env = await nativeApp();
  const source = (await env.history()).sources[0]!;
  const result = await env.operation(request(source));
  expect(result.statusCode, result.body).toBe(200);
  const receipt = AcceptedMaterialExportsSchema.parse(result.json())
    .exports[0]!;
  const url = `/v1/artifacts/${receipt.artifactId}/download.docx`;
  const row = env.db
    .prepare("SELECT path,metadata_json FROM job_artifacts WHERE artifact_id=?")
    .get(receipt.artifactId) as { path: string; metadata_json: string };
  const bytes = fs.readFileSync(row.path);
  fs.writeFileSync(
    path.join(env.root, `${source.kind}.txt`),
    "A concurrent accepted edit",
  );
  expect((await env.operation(request(source))).statusCode).toBe(409);
  env.db
    .prepare(
      "UPDATE job_materials_artifacts SET status='rejected' WHERE artifact_id=?",
    )
    .run(source.artifactId);
  expect((await env.operation(request(source))).statusCode).toBe(409);
  // Existing exports survive later edits/rejection of their source.
  expect((await env.app.inject({ url })).statusCode).toBe(200);
  fs.writeFileSync(row.path, "corrupted bytes");
  expect((await env.app.inject({ url })).json()).toEqual({
    ok: false,
    error: "export_bytes_changed",
  });
  fs.unlinkSync(row.path);
  expect((await env.app.inject({ url })).statusCode).toBe(404);
  const target = path.join(env.root, "other-file.docx");
  fs.writeFileSync(target, bytes);
  fs.symlinkSync(target, row.path);
  expect((await env.app.inject({ url })).statusCode).toBe(403);
  fs.unlinkSync(row.path);
  fs.writeFileSync(row.path, bytes);
  env.db
    .prepare("UPDATE job_artifacts SET metadata_json=? WHERE artifact_id=?")
    .run(
      JSON.stringify({ ...JSON.parse(row.metadata_json), tenantId: "foreign" }),
      receipt.artifactId,
    );
  expect((await env.app.inject({ url })).statusCode).toBe(409);
  env.db
    .prepare(
      "INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('foreign',?,'https://example.test/foreign','Foreign synthetic job','Synthetic Employer')",
    )
    .run(JOB);
  env.db
    .prepare(
      "UPDATE job_artifacts SET metadata_json=?,tenant_id='foreign' WHERE artifact_id=?",
    )
    .run(row.metadata_json, receipt.artifactId);
  expect((await env.app.inject({ url })).statusCode).toBe(404);
  env.db
    .prepare("UPDATE job_artifacts SET tenant_id='local' WHERE artifact_id=?")
    .run(receipt.artifactId);
  expect((await env.history()).exports).toEqual([receipt]);
  expect((await env.app.inject({ url })).rawPayload).toEqual(bytes);
}, 30_000);
