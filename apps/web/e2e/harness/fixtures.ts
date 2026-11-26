import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Request,
  type Response,
} from "@playwright/test";

// JavaScript owns native processes. It is used only by the E2E harness.
// @ts-expect-error Node harness modules do not ship with application declarations.
import { applicationStack, postgresStack } from "./runtime.mjs";

export type ExternalCall = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  closed?: boolean;
  respond(value: unknown, status?: number): void;
  reply(value: unknown): void;
  disconnect(): void;
  invalidJson(): void;
  raw(
    body: string,
    options?: { status?: number; headers?: Record<string, string> },
  ): void;
};

export type ApplicationStack = {
  baseURL: string;
  workspace: string;
  directory: string;
  workerPid: number;
  setupMs: number;
  external: {
    calls: ExternalCall[];
    sends: ExternalCall[];
    setCatalog(value: { providers: Record<string, unknown>[] }): void;
    next(options?: { timeout?: number; match?: (call: ExternalCall) => boolean }): Promise<ExternalCall>;
  };
  discoveryCheckpoint(runId: string): Promise<{
    adapters: { unitId: string; site: string; state: Record<string, unknown>; emittedCount: number; completed: boolean; requestFingerprint: string; acknowledgedKeys: string[] }[];
    received: { unitId: string; site: string; jobKey: string; status: string }[];
    receipts: Record<string, number>;
    receiptKeys: { unitId: string; site: string; jobKey: string; isNew: boolean }[];
    request: { fingerprint: string; sourceFetchPolicy?: string; settings: { resultsPerSite: number; newJobLimit: number } };
    units: { unitId: string; status: string; resultsPerSite: number | null; sdkFingerprint: string; sdkResultsWanted: number | null; sdkMaxPages: number; result: { termination?: string; sourceTerminations?: Record<string, string> } | null }[];
  }>;
  restartWorker(features?: string, afterExit?: () => Promise<void>): Promise<{ previous: number; current: number }>;
  restartApi(options?: { freshWorkspace?: boolean }): Promise<void>;
  upgradeSqliteToPostgres(): Promise<{ first: { state: string; rows: number; receipt_sha256: string }; repeated: { state: string; rows: number; receipt_sha256: string } }>;
  upgradeSource(): Promise<{ previous: number; current: number; backup: string; candidateOrigin: string; mode: "source" | "installed" }>;
  armFitRecoveryPause(operation: "fit.catalog-impact" | "fit.qualification-batch"): Promise<void>;
  waitForFitRecoveryPause(): Promise<void>;
  armCohortBoundaryPause(): Promise<void>;
  waitForCohortBoundaryPause(boundary?: "final-currentness-guard" | "fit-receipt"): Promise<void>;
  resumeCohortBoundary(): Promise<void>;
  armModelReceiptPause(): Promise<void>;
  waitForModelReceiptPause(): Promise<string>;
  fitProviderReceipts(): Promise<{ receiptId: string; ownerKey: string | null; status: string; inputFingerprint: string; costUsd: number | null }[]>;
  requirementsExtractionReceipts(): ReturnType<ApplicationStack["fitProviderReceipts"]>;
  fitRefreshCheckpoint(operationId: string): Promise<{ calls: Record<string, { kind: string; status: string; result?: { value: unknown; provenance: Record<string, unknown> } }>; checkpoints: Record<string, unknown>; impact_selection_scope_version?: string; qualification_transport_version?: string }>;
  databaseSchemaFingerprint(): Promise<string>;
  databaseSchemaInventory(): Promise<{ type: string; name: string; table: string; sql: string | null }[]>;
  requirementsReconciliation(operationId: string): Promise<{
    operation_id: string; action_fingerprint: string; input_fingerprint: string;
    captured_catalog_revision: number; published_catalog_revision: number; selection: unknown;
    authority_receipt: { value?: unknown; [key: string]: unknown };
    stored_report: { storage_version?: string; report?: unknown; intermediate_selection?: unknown; partition_binding?: unknown; derived_decision?: unknown;
      citation_binding?: unknown; [key: string]: unknown };
  }>;
  failRendering(): Promise<void>;
  restoreRendering(): Promise<void>;
  inspectLogicalBackup(archiveName: string, runId: string): Promise<{
    archived: [string, string];
    afterTrial: [string, string];
    cli: { exitCode: number; stderr: string };
    api: { exitCode: number; stderr: string };
    worker: { exitCode: number; stderr: string };
  }>;
  cli(
    args: string[],
    options?: { input?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  inspectPdf(
    bytes: Buffer,
    options?: { selectWithPdfKit?: boolean },
  ): Promise<{ pages: number; text: string; images: Buffer[]; pdfKitSelection?: string }>;
  inspectDocx(bytes: Buffer): Promise<string>;
  file(relative: string): Promise<Buffer>;
  close(options?: { retainState?: boolean }): Promise<void>;
};

type WorkerFixtures = {
  postgres: {
    createDatabase(): Promise<string>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    retainForDiagnosis(): void;
    close(): Promise<void>;
  };
};
type Fixtures = {
  app: ApplicationStack;
  api: APIRequestContext;
  consoleErrors: string[];
  features: string | undefined;
  discoveryTransport: "jobstreaming" | "jobstreaming-indeed-missing" | "jobstreaming-tls-failure";
  nativeAccountingPreflight: boolean;
  sourceRevision: string | undefined;
  sqlitePredecessor: boolean;
  fitRecoveryDebugger: boolean;
  cohortBoundaryDebugger: boolean;
  modelReceiptDebugger: boolean;
  expectedTransportFailures: {
    request: Request;
    errorText: "net::ERR_FAILED";
  }[];
  allowRequestFailure: (request: Request, errorText: "net::ERR_FAILED", forwardedResponse?: APIResponse) => void;
  expectedResponseErrors: Response[];
  allowResponseError: (
    response: Response,
    expected:
      | { method: "GET" | "POST"; status: 409; code: string }
      | { method: "PATCH"; status: 409; code: "revision_conflict" }
      | { method: "PATCH"; status: 409; code: "workspace_changed"; databaseInstanceId: string }
      | { method: "GET"; status: 404; code: "not_found"; action: "preparation.run" | "preparation.retry" | "requirements.consolidate"; idempotencyKey: string; databaseInstanceId: string },
    forwardedResponse?: APIResponse,
  ) => Promise<void>;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  features: [undefined, { option: true }],
  discoveryTransport: ["jobstreaming", { option: true }],
  nativeAccountingPreflight: [false, { option: true }],
  sourceRevision: [undefined, { option: true }],
  sqlitePredecessor: [false, { option: true }],
  fitRecoveryDebugger: [false, { option: true }],
  cohortBoundaryDebugger: [false, { option: true }],
  modelReceiptDebugger: [false, { option: true }],
  expectedTransportFailures: async ({}, use) => {
    await use([]);
  },
  expectedResponseErrors: async ({}, use) => {
    await use([]);
  },
  allowResponseError: async ({ api, app, expectedResponseErrors }, use) => {
    await use(async (response, expected, forwardedResponse) => {
      expect(response.status()).toBe(expected.status);
      expect(response.request().method()).toBe(expected.method);
      const url = new URL(response.url());
      expect(url.origin).toBe(app.baseURL);
      if (expected.status === 404) {
        expect(expected.method).toBe("GET");
        expect(expected.code).toBe("not_found");
        expect(url.pathname).toBe("/v1/action-runs/by-idempotency-key");
        expect([...url.searchParams.entries()]).toEqual([["action", expected.action]]);
        expect(expected.idempotencyKey).toBeTruthy();
        expect(expected.databaseInstanceId).toBeTruthy();
        const headers = response.request().headers();
        expect(headers["idempotency-key"]).toBe(expected.idempotencyKey);
        expect(headers["expected-database-instance-id"]).toBe(expected.databaseInstanceId);
      } else {
        expect(expected.status).toBe(409);
        if (expected.method === "PATCH") {
          expect(url.pathname).toBe("/v1/profile");
          expect(url.search).toBe("");
          if (expected.code === "workspace_changed") {
            const headers = await response.request().allHeaders();
            expect(expected.databaseInstanceId).toMatch(/^[a-f0-9]{64}$/);
            expect(headers["expected-database-instance-id"]).toBe(expected.databaseInstanceId);
            const health = await api.get("/v1/health");
            expect(health.ok()).toBe(true);
            const current = (await health.json() as { databaseInstanceId?: string }).databaseInstanceId;
            expect(current).toMatch(/^[a-f0-9]{64}$/);
            expect(current).not.toBe(expected.databaseInstanceId);
          } else {
            expect(expected.code).toBe("revision_conflict");
          }
        }
      }
      if (forwardedResponse) {
        expect(expected.status).toBe(404);
        expect(forwardedResponse.url()).toBe(response.url());
        expect(forwardedResponse.status()).toBe(response.status());
      }
      const body = (await (forwardedResponse ?? response).json()) as { error?: { code?: unknown } };
      expect(
        body.error?.code,
        "Only the explicitly expected domain refusal may allow its native console entry",
      ).toBe(expected.code);
      expect(expectedResponseErrors.includes(response)).toBe(false);
      expectedResponseErrors.push(response);
    });
  },
  allowRequestFailure: async ({ app, expectedTransportFailures }, use) => {
    await use((request, errorText, forwardedResponse) => {
      expect(errorText).toBe("net::ERR_FAILED");
      expect(
        request.method() === "POST" ||
          (request.method() === "PATCH" &&
            new URL(request.url()).origin === app.baseURL &&
            ["/v1/credentials/batch", "/v1/profile"].includes(new URL(request.url()).pathname)),
        "Only an observed admitted POST, credential batch or Profile acknowledgement may be severed",
      ).toBe(true);
      if (request.method() === "PATCH" && new URL(request.url()).pathname === "/v1/profile") {
        expect(forwardedResponse, "A Profile acknowledgement allowance needs its actual forwarded response").toBeDefined();
        expect(forwardedResponse!.status()).toBe(200);
        expect(forwardedResponse!.url()).toBe(request.url());
      }
      expect(
        request.failure()?.errorText,
        "Only an actually failed browser Request may allow its native transport console entry",
      ).toBe(errorText);
      expect(
        expectedTransportFailures.some((entry) => entry.request === request),
      ).toBe(false);
      expectedTransportFailures.push({ request, errorText });
    });
  },
  postgres: [
    async ({}, use) => {
      const runtime = await postgresStack();
      try {
        await use(runtime);
      } finally {
        await runtime.close();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
  app: [
    async ({ postgres, features, discoveryTransport, nativeAccountingPreflight, sourceRevision, sqlitePredecessor, fitRecoveryDebugger, cohortBoundaryDebugger, modelReceiptDebugger }, use, testInfo) => {
      const runtime: ApplicationStack = await applicationStack(
        await postgres.createDatabase(),
        { features, discoveryTransport, nativeAccountingPreflight, sourceRevision, sqlitePredecessor, fitRecoveryDebugger, cohortBoundaryDebugger, modelReceiptDebugger, createDatabase: () => postgres.createDatabase() },
      );
      await testInfo.attach("runtime-setup", {
        contentType: "application/json",
        body: JSON.stringify({
          setupMs: runtime.setupMs,
          workerPid: runtime.workerPid,
          directory: runtime.directory,
          baseURL: runtime.baseURL,
        }),
      });
      try {
        await use(runtime);
      } finally {
        const retainState = testInfo.status !== testInfo.expectedStatus;
        if (retainState) postgres.retainForDiagnosis();
        await runtime.close({ retainState });
      }
    },
    { timeout: 240_000 },
  ],
  api: async ({ playwright, app }, use) => {
    const request = await playwright.request.newContext({
      baseURL: app.baseURL,
      extraHTTPHeaders: { Origin: app.baseURL },
      timeout: 20_000,
    });
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
  baseURL: async ({ app }, use) => {
    await use(app.baseURL);
  },
  consoleErrors: [
    async (
      { page, expectedTransportFailures, expectedResponseErrors },
      use,
    ) => {
      const errors: string[] = [];
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
        errors.push(error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error")
          errors.push(`${message.text()} at ${message.location().url}`);
      });
      await use(errors);
      expect(pageErrors, "browser page exceptions").toEqual([]);
      const unexpected = [...errors];
      for (const { request, errorText } of expectedTransportFailures) {
        // At most one browser-native resource error for this exact observed
        // aborted Request; no application message or HTTP status is allowed.
        const native = `Failed to load resource: ${errorText} at ${request.url()}`;
        const index = unexpected.indexOf(native);
        if (index !== -1) unexpected.splice(index, 1);
      }
      for (const response of expectedResponseErrors) {
        // Intentional conflict controls require a real response, exact method,
        // status and domain code. Allow one native resource entry for its full
        // URL, keeping extra requests and application errors visible.
        const native = `Failed to load resource: the server responded with a status of ${response.status()} (${response.statusText()}) at ${response.url()}`;
        const index = unexpected.indexOf(native);
        if (index !== -1) unexpected.splice(index, 1);
      }
      expect(unexpected, "browser runtime errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function json<T = Record<string, unknown>>(
  api: APIRequestContext,
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  data?: unknown,
): Promise<T> {
  const result = await api[method](url, data === undefined ? {} : { data });
  expect(
    result.ok(),
    `${method.toUpperCase()} ${url}: ${await result.text()}`,
  ).toBe(true);
  return result.json() as Promise<T>;
}

export async function modelCall(
  app: ApplicationStack,
  operation: string,
): Promise<ExternalCall> {
  const call = await app.external.next();
  expect(call.method).toBe("POST");
  expect(call.path).toBe("/model");
  expect(call.body["operation"]).toBe(operation);
  expect(call.body["lane"]).toBeTruthy();
  expect(call.body["prompt_version"]).toBeTruthy();
  expect(call.body["sources"]).toBeTruthy();
  return call;
}

export async function action(
  api: APIRequestContext,
  name: string,
  payload: unknown,
) {
  const result = await api.post(`/v1/actions/${name}`, { data: payload });
  expect(result.status(), await result.text()).toBe(202);
  return result.json() as Promise<{ runId: string; status: string }>;
}

export async function completed(api: APIRequestContext, runId: string) {
  const result = await terminal(api, runId);
  expect(
    result["status"],
    `Durable action ${runId}: ${JSON.stringify(result)}`,
  ).toBe("succeeded");
  return result;
}

export async function terminal(api: APIRequestContext, runId: string) {
  let result: Record<string, unknown> = {};
  const path = `/v1/action-runs/${runId}`;
  await expect
    .poll(
      async () => {
        // Recover an idle connection reset on this idempotent status read.
        const response = await api.get(path, { maxRetries: 1 });
        expect(response.ok(), `GET ${path}: ${await response.text()}`).toBe(true);
        result = await response.json() as Record<string, unknown>;
        return ["succeeded", "failed", "cancelled"].includes(
          String(result["status"]),
        );
      },
      // Production heartbeat timeout is 30s; allow its bounded retry and
      // canonical terminal reconciliation on the declared runner.
      { timeout: 45_000, message: `Durable action ${runId} must terminalize` },
    )
    .toBe(true);
  return result;
}
