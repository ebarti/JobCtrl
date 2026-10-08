import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENDPOINTS,
  MaterialLocaleMutationSchema,
  MaterialLocaleStateSchema,
  type MaterialLocaleState,
} from "../src/contracts.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import {
  AUTOMATION_PROJECT_DIR,
  type PythonRuntimeCommandResolver,
} from "../src/python-runtime.js";
import { buildApp } from "../src/server.js";
import { ensureCurrentResumeTemplateMaterials } from "../src/resume-templates.js";

const JOB = "90000000-0000-4000-8000-000000000055";
let root: string;
let adapter: SubprocessJsonRpcAdapter;
let runtime: PythonRuntimeCommandResolver;
let app: ReturnType<typeof buildApp>;
const python = path.join(AUTOMATION_PROJECT_DIR, ".venv", "bin", "python");

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-owned-locale-")),
  );
  const env = {
    ...process.env,
    JOBCTRL_DIR: root,
    PYTHONPATH: `${path.join(AUTOMATION_PROJECT_DIR, "src")}${path.delimiter}${AUTOMATION_PROJECT_DIR}`,
  };
  const seed = spawnSync(
    python,
    [
      "-c",
      "import json,sys; from tests.test_locale_variants_integration import prepare_api_fixture; print(json.dumps(prepare_api_fixture(sys.argv[1])))",
      root,
    ],
    { env, encoding: "utf8" },
  );
  expect(seed.status, seed.stdout + seed.stderr).toBe(0);
  runtime = {
    id: `owned-locale:${root}`,
    resolve: () => ({
      executable: python,
      argv: [
        "-c",
        "from tests.test_locale_variants_integration import serve_product_probe; serve_product_probe()",
      ],
      cwd: root,
      env,
    }),
  };
  adapter = new SubprocessJsonRpcAdapter({
    appDir: root,
    pythonRuntime: runtime,
    requestTimeoutMs: 60000,
  });
  app = buildApp({
    dbPath: path.join(root, "jobctrl.db"),
    configPath: path.join(root, "config.json"),
    providerDispatcher: adapter,
    pythonRuntime: runtime,
  });
});
afterEach(async () => {
  await app?.close();
  await adapter?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function mutate(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/jobs/${JOB}/locale-variants`,
    payload,
  });
}
async function generation(
  kind: "resume" | "cover_letter" = "resume",
): Promise<MaterialLocaleState> {
  const response = await mutate({
    operation: "generate",
    kind,
    source_locale: "en",
    target_locale: "es",
    expected_revision: 0,
    request_id: randomUUID(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return MaterialLocaleStateSchema.parse(response.json());
}

describe("reviewed material locale variants through real API-to-Python dispatch", () => {
  it.each([
    { kind: "resume", workspace: "canonical" },
    { kind: "cover_letter", workspace: "canonical" },
    { kind: "resume", workspace: "alias" },
    { kind: "cover_letter", workspace: "alias" },
  ] as const)(
    "persists $kind in a $workspace workspace, independently reviews, reloads and exports every accepted format",
    async ({ kind, workspace }) => {
      if (workspace === "alias") {
        const alias = path.join(root, "workspace-alias");
        fs.symlinkSync(root, alias, "dir");
        await app.close();
        app = buildApp({
          appDir: alias,
          dbPath: path.join(alias, "jobctrl.db"),
          configPath: path.join(alias, "config.json"),
          providerDispatcher: adapter,
          pythonRuntime: runtime,
        });
      }
      let state = await generation(kind);
      expect(
        state.variants[0]?.determinations.map((item) => item.kind),
      ).toEqual([
        "material_locale_translation",
        "material_locale_terminology",
        "claim_verification",
        "artifact_quality",
      ]);
      const first = state.variants[0]!;
      const original = fs.readFileSync(
        path.join(
          root,
          kind === "resume" ? "tailored_resumes" : "cover_letters",
          "owned.txt",
        ),
      );
      for (const review_kind of ["terminology", "formatting"] as const) {
        const response = await mutate({
          operation: "review",
          variant_id: first.variant_id,
          expected_revision: state.revision,
          expected_variant_revision: state.variants[0]!.revision,
          review_kind,
          decision: "accepted",
        });
        expect(response.statusCode, response.body).toBe(200);
        state = MaterialLocaleStateSchema.parse(response.json());
      }
      expect(state.variants[0]!.status).toBe("accepted");
      const reload = await app.inject({
        method: "GET",
        url: `/v1/jobs/${JOB}/locale-variants`,
      });
      expect(reload.statusCode, reload.body).toBe(200);
      expect(reload.json().variants[0].accepted_revision).toBe(
        state.variants[0]!.accepted_revision,
      );
      for (const export_format of ["text", "html", "pdf", "docx"] as const) {
        const response = await mutate({
          operation: "export",
          variant_id: first.variant_id,
          expected_revision: state.revision,
          expected_variant_revision: state.variants[0]!.revision,
          export_format,
        });
        expect(response.statusCode, response.body).toBe(200);
        state = MaterialLocaleStateSchema.parse(response.json());
        const exported = state.variants[0]!.exports.at(-1)!;
        const download = await app.inject({
          method: "GET",
          url: `/v1/jobs/${JOB}/locale-variants/exports/${exported.export_id}`,
        });
        expect(download.statusCode, download.body).toBe(200);
        expect(
          createHash("sha256").update(download.rawPayload).digest("hex"),
        ).toBe(exported.sha256);
        expect(exported.document_sha256).toBe(
          state.variants[0]!.document_sha256,
        );
        if (export_format === "pdf")
          expect(download.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
        if (export_format === "docx")
          expect(download.rawPayload.subarray(0, 2).toString()).toBe("PK");
        if (export_format === "text")
          expect(download.body).toContain("Éloï Synthetic");
      }
      const detail = await app.inject({
        method: "GET",
        url: `/v1/jobs/${JOB}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().localeVariants.variants[0].exports).toHaveLength(4);
      const textExport = state.variants[0]!.exports.find(
        (item) => item.format === "text",
      )!;
      const downloadText = () => app.inject({
        method: "GET",
        url: `/v1/jobs/${JOB}/locale-variants/exports/${textExport.export_id}`,
      });
      // Identical bytes elsewhere cannot grant authority to a redirected file.
      const redirected = path.join(root, "unregistered-copy.txt");
      fs.copyFileSync(textExport.path, redirected);
      fs.renameSync(textExport.path, textExport.path + ".original");
      try {
        fs.symlinkSync(redirected, textExport.path);
        expect((await downloadText()).statusCode).toBe(409);
      } finally {
        fs.unlinkSync(textExport.path);
        fs.renameSync(textExport.path + ".original", textExport.path);
      }
      // Canonicalizing the workspace must not canonicalize an escaping export root.
      const exportRoot = path.dirname(textExport.path);
      const movedRoot = path.join(root, "redirected-exports");
      fs.renameSync(exportRoot, movedRoot);
      try {
        fs.symlinkSync(movedRoot, exportRoot, "dir");
        expect((await downloadText()).statusCode).toBe(409);
      } finally {
        fs.unlinkSync(exportRoot);
        fs.renameSync(movedRoot, exportRoot);
      }
      const restored = await downloadText();
      expect(restored.statusCode, restored.body).toBe(200);
      expect(createHash("sha256").update(restored.rawPayload).digest("hex")).toBe(
        textExport.sha256,
      );
      expect(
        fs.readFileSync(
          path.join(
            root,
            kind === "resume" ? "tailored_resumes" : "cover_letters",
            "owned.txt",
          ),
        ),
      ).toEqual(original);
    },
    60000,
  );

  it("rejects stale review fences and source-byte drift while preserving accepted history", async () => {
    const state = await generation();
    const variant = state.variants[0]!;
    const stale = await mutate({
      operation: "review",
      variant_id: variant.variant_id,
      expected_revision: 0,
      expected_variant_revision: 1,
      review_kind: "terminology",
      decision: "accepted",
    });
    expect(stale.statusCode).toBe(409);
    fs.appendFileSync(
      path.join(root, "tailored_resumes", "owned.txt"),
      "changed",
    );
    const failure = await mutate({
      operation: "generate",
      kind: "resume",
      source_locale: "en",
      target_locale: "fr",
      expected_revision: state.revision,
      request_id: randomUUID(),
    });
    expect(failure.statusCode).toBe(409);
    const reload = await app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}/locale-variants`,
    });
    expect(reload.json().variants[0].lines).toEqual(variant.lines);
  });

  it("contains ID-bound downloads and refuses foreign tenants, malformed requests and unknown files", async () => {
    const bad = await mutate({
      operation: "generate",
      kind: "resume",
      source_locale: "en",
      target_locale: "es",
      expected_revision: 0,
      request_id: randomUUID(),
      tenant_id: "foreign",
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}/locale-variants/exports/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(409);
    const foreign = await app.inject({
      method: "POST",
      url: `/v1/jobs/${randomUUID()}/locale-variants`,
      payload: {
        operation: "generate",
        kind: "resume",
        source_locale: "en",
        target_locale: "es",
        expected_revision: 0,
        request_id: randomUUID(),
      },
    });
    expect(foreign.statusCode).toBe(409);
    const db = new Database(path.join(root, "jobctrl.db"));
    expect(
      db.prepare("SELECT count(*) AS count FROM job_materials_artifacts").get(),
    ).toEqual({ count: 2 });
    db.close();
  });

  it("publishes additive strict contracts and makes the offline demo unavailable", () => {
    expect(ENDPOINTS.mutateMaterialLocaleVariants.demo.class).toBe(
      "unavailable",
    );
    expect(ENDPOINTS.mutateMaterialLocaleVariants.dispatch.rpcMethod).toBe(
      "material_locale_variants",
    );
    expect(
      MaterialLocaleMutationSchema.safeParse({
        operation: "export",
        variant_id: randomUUID(),
        expected_revision: true,
        expected_variant_revision: 1,
        export_format: "pdf",
      }).success,
    ).toBe(false);
  });

  it("joins the recorded original source acceptance ID instead of substituting a locale decision", async () => {
    const state = await generation();
    const db = new Database(path.join(root, "jobctrl.db"));
    try {
      db.prepare(
        "UPDATE job_materials SET metadata_json=json_set(metadata_json,'$.locale_variants_v1.variants[0].verification_id',?)",
      ).run(state.variants[0]!.determinations[0]!.determination_id);
    } finally {
      db.close();
    }
    const history = await app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}/locale-variants`,
    });
    expect(history.statusCode).toBe(409);
    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${JOB}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().localeVariantsError).toBe(
      "locale_history_unavailable",
    );
    expect(detail.json().artifacts).toHaveLength(2);
  });

  it("retains exact source authority during a render-only template refresh and keeps locale history", async () => {
    const state = await generation();
    const db = new Database(path.join(root, "jobctrl.db"));
    try {
      const refreshed = await ensureCurrentResumeTemplateMaterials(
        db,
        JOB,
        { force: true },
        async ({ pdfPath }) => {
          fs.writeFileSync(pdfPath, "%PDF structural template renderer");
        },
      );
      expect(refreshed.status, JSON.stringify(refreshed)).toBe("completed");
      const source = db
        .prepare(
          "SELECT artifact_id,generation,metadata_json FROM job_materials_artifacts WHERE artifact_type='tailored_resume' ORDER BY generation DESC LIMIT 1",
        )
        .get() as {
        artifact_id: string;
        generation: number;
        metadata_json: string;
      };
      const binding = db
        .prepare(
          "SELECT determination_id FROM semantic_entity_bindings WHERE entity_kind='artifact' AND entity_id=? AND entity_version=? AND determination_kind='claim_verification'",
        )
        .get(source.artifact_id, String(source.generation));
      expect(binding).toEqual({
        determination_id: JSON.parse(source.metadata_json)
          .claim_verification_id,
      });
      const response = await mutate({
        operation: "generate",
        kind: "resume",
        source_locale: "en",
        target_locale: "es",
        expected_revision: state.revision,
        request_id: randomUUID(),
      });
      expect(response.statusCode, response.body).toBe(200);
      const current = MaterialLocaleStateSchema.parse(response.json());
      expect(current.variants[0]).toEqual(state.variants[0]);
      expect(current.variants[1]!.artifact_id).toBe(source.artifact_id);
      expect(current.variants[1]!.generation).toBe(source.generation);
      expect(current.variants[1]!.sha256).toBe(state.variants[0]!.sha256);
    } finally {
      db.close();
    }
  });

  it("rejects altered registered export bytes and foreign determination bindings on reads", async () => {
    let state = await generation();
    for (const review_kind of ["terminology", "formatting"] as const) {
      const response = await mutate({
        operation: "review",
        variant_id: state.variants[0]!.variant_id,
        expected_revision: state.revision,
        expected_variant_revision: state.variants[0]!.revision,
        review_kind,
        decision: "accepted",
      });
      expect(response.statusCode, response.body).toBe(200);
      state = MaterialLocaleStateSchema.parse(response.json());
    }
    const response = await mutate({
      operation: "export",
      variant_id: state.variants[0]!.variant_id,
      expected_revision: state.revision,
      expected_variant_revision: state.variants[0]!.revision,
      export_format: "text",
    });
    expect(response.statusCode, response.body).toBe(200);
    state = MaterialLocaleStateSchema.parse(response.json());
    const record = state.variants[0]!.exports[0]!;
    fs.appendFileSync(record.path, "Extra claims");
    const changed = await app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}/locale-variants/exports/${record.export_id}`,
    });
    expect(changed.statusCode).toBe(409);
    const db = new Database(path.join(root, "jobctrl.db"));
    try {
      db.prepare(
        "UPDATE job_materials SET metadata_json=json_set(metadata_json,'$.locale_variants_v1.variants[0].semantic_entity_id','foreign')",
      ).run();
    } finally {
      db.close();
    }
    const foreign = await app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}/locale-variants`,
    });
    expect(foreign.statusCode).toBe(409);
    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${JOB}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().localeVariantsError).toBe(
      "locale_history_unavailable",
    );
    expect(detail.json().artifacts).toHaveLength(2);
  });
});
