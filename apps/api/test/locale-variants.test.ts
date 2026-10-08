import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import {
  SubprocessJsonRpcAdapter,
  type JsonRpcDispatcher,
} from "../src/json-rpc-adapter.js";
import { LocaleVariantsParamsSchema, RpcMethods } from "../src/contracts.js";
import { initializeExactDatabase } from "./exact-schema.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const python = path.join(root, "workers/automation/.venv/bin/python");
const jobId = "90000000-0000-4000-8000-000000000039";
const owned: string[] = [];
afterEach(() => {
  for (const directory of owned.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function workspace() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-locale-api-"),
  );
  owned.push(directory);
  const dbPath = path.join(directory, "jobctrl.db");
  return { directory, dbPath, configPath: path.join(directory, "config.json") };
}

describe("locale API boundaries", () => {
  it("rejects extra/unsupported request fields before dispatch", async () => {
    const ws = workspace();
    initializeExactDatabase(ws.dbPath);
    let calls = 0;
    const dispatcher: JsonRpcDispatcher = {
      call: async () => {
        calls++;
        throw new Error("must not dispatch");
      },
      close: async () => {},
    };
    const app = buildApp({
      appDir: ws.directory,
      dbPath: ws.dbPath,
      configPath: ws.configPath,
      providerDispatcher: dispatcher,
    });
    try {
      for (const body of [
        {
          artifactId: "a",
          sourceLocale: "en",
          targetLocale: "xx",
          expectedRevision: 0,
        },
        {
          artifactId: "a",
          sourceLocale: "en",
          targetLocale: "es",
          expectedRevision: 0,
          editedText: "invented",
        },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/jobs/${jobId}/locale-variants`,
          payload: body,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(calls).toBe(0);
      expect(
        LocaleVariantsParamsSchema.safeParse({
          operation: "export",
          jobId,
          expectedAppDir: ws.directory,
          expectedDbPath: ws.dbPath,
          format: "exe",
        }).success,
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
  it("downloads hash-checked accepted bytes with safe headers and maps failed exports", async () => {
    const ws = workspace();
    initializeExactDatabase(ws.dbPath);
    const bytes = Buffer.from("Owned accepted claims");
    let fail = false;
    const dispatcher: JsonRpcDispatcher = {
      call: async (method, params) => {
        expect(method).toBe(RpcMethods.LocaleVariants);
        expect(params).toMatchObject({
          expectedAppDir: ws.directory,
          expectedDbPath: ws.dbPath,
          tenantId: "local",
          operation: "export",
        });
        return fail
          ? {
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32602, message: "locale_export_tampered" },
            }
          : {
              jsonrpc: "2.0",
              id: 1,
              result: {
                ok: true,
                data: bytes.toString("base64"),
                hash: createHash("sha256").update(bytes).digest("hex"),
                format: params["format"],
              },
            };
      },
      close: async () => {},
    };
    const app = buildApp({
      appDir: ws.directory,
      dbPath: ws.dbPath,
      configPath: ws.configPath,
      providerDispatcher: dispatcher,
    });
    try {
      const response = await app.inject(
        `/v1/jobs/${jobId}/locale-variants/download?variantId=locale:owned&format=html`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(bytes.toString());
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="locale-variant.html"',
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("sandbox");
      fail = true;
      expect(
        (
          await app.inject(
            `/v1/jobs/${jobId}/locale-variants/download?variantId=locale:owned&format=html`,
          )
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("runs production HTTP to registered Python RPC generation, acceptance, reload and four downloads", async () => {
    const ws = workspace();
    const seeded = JSON.parse(
      execFileSync(
        python,
        [
          "-c",
          "from pathlib import Path; import json,sys; from tests.test_locale_variants import setup_case; owner,command,*_=setup_case(Path(sys.argv[1])); print(json.dumps(command.model_dump(exclude_none=True))); owner.conn.close()",
          ws.directory,
        ],
        { cwd: path.join(root, "workers/automation"), encoding: "utf8" },
      ),
    );
    const program = [
      "import sys",
      "from pathlib import Path",
      "from jobctrl import config",
      "config.APP_DIR=Path(sys.argv[1]); config.DB_PATH=config.APP_DIR/'jobctrl.db'",
      "from tests.test_locale_variants import Model",
      "from jobctrl.infrastructure.determinations import determination_dependencies",
      "from jobctrl.infrastructure.materials import locale_variants",
      "locale_variants.determination_dependencies=lambda connection,**kwargs: determination_dependencies(connection,adapter=Model(),**kwargs)",
      "from jobctrl.infrastructure.rpc.server import JsonRpcServer",
      "from jobctrl.infrastructure.rpc.handlers import register_default_handlers",
      "async def canceler(*args): raise AssertionError('no workflow')",
      "server=JsonRpcServer(); register_default_handlers(server,canceler=canceler); server.serve()",
    ].join("\n");
    const dispatcher = new SubprocessJsonRpcAdapter({
      appDir: ws.directory,
      pythonRuntime: {
        id: "owned-locale-test",
        resolve: () => ({
          executable: python,
          argv: ["-c", program, ws.directory],
          cwd: path.join(root, "workers/automation"),
          env: { ...process.env, JOBCTRL_RUNTIME_MODE: "source", JOBCTRL_DIR: ws.directory, JOBCTRL_CONFIG_PATH: ws.configPath },
        }),
      },
    });
    const app = buildApp({
      appDir: ws.directory,
      dbPath: ws.dbPath,
      configPath: ws.configPath,
      providerDispatcher: dispatcher,
    });
    try {
      const source = fs.readFileSync(path.join(ws.directory, "source.txt"));
      const generated = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/locale-variants`,
        payload: {
          artifactId: seeded.artifactId,
          sourceLocale: "en",
          targetLocale: "es",
          expectedRevision: 0,
        },
      });
      expect(generated.statusCode, generated.body).toBe(200);
      const variant = generated.json().variants[0];
      expect(variant.determinations).toHaveLength(4);
      const reviewed = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/locale-variants/review`,
        payload: {
          variantId: variant.variantId,
          expectedRevision: 1,
          terminology: "confirmed",
          formatting: "confirmed",
          decision: "accepted",
        },
      });
      expect(reviewed.statusCode, reviewed.body).toBe(200);
      expect(reviewed.json().variants[0].status).toBe("accepted");
      expect(
        (await app.inject(`/v1/jobs/${jobId}/locale-variants`)).json(),
      ).toEqual(reviewed.json());
      for (const format of ["text", "html", "pdf", "docx"]) {
        const download = await app.inject(
          `/v1/jobs/${jobId}/locale-variants/download?variantId=${encodeURIComponent(variant.variantId)}&format=${format}`,
        );
        expect(download.statusCode, download.body).toBe(200);
        expect(
          createHash("sha256").update(download.rawPayload).digest("hex"),
        ).toBe(reviewed.json().variants[0].exports[format].hash);
      }
      expect(fs.readFileSync(path.join(ws.directory, "source.txt"))).toEqual(
        source,
      );
      const conflict = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/locale-variants/review`,
        payload: {
          variantId: variant.variantId,
          expectedRevision: 1,
          decision: "rejected",
        },
      });
      expect(conflict.statusCode).toBe(409);
    } finally {
      await dispatcher.close();
      await app.close();
    }
  }, 60000);
});
