import {
  test as base,
  expect,
  type APIRequestContext,
  type Request,
  type Response,
} from "@playwright/test";

// JavaScript owns native processes. It is used only by the E2E harness.
// @ts-expect-error Node harness modules do not ship with application declarations.
import { applicationStack, temporalStack } from "./runtime.mjs";

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
    next(options?: { timeout?: number }): Promise<ExternalCall>;
  };
  discoveryCheckpoint(runId: string): Promise<{ adapters: { site: string; state: Record<string, unknown>; emittedCount: number; completed: boolean }[]; receipts: Record<string, number> }>;
  restartWorker(): Promise<{ previous: number; current: number }>;
  failRendering(): Promise<void>;
  restoreRendering(): Promise<void>;
  cli(
    args: string[],
    options?: { input?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  inspectPdf(
    bytes: Buffer,
  ): Promise<{ pages: number; text: string; images: Buffer[] }>;
  file(relative: string): Promise<Buffer>;
  close(options?: { retainState?: boolean }): Promise<void>;
};

type WorkerFixtures = {
  temporal: {
    address: string;
    retainForDiagnosis(): void;
    close(): Promise<void>;
  };
};
type Fixtures = {
  app: ApplicationStack;
  api: APIRequestContext;
  consoleErrors: string[];
  features: string | undefined;
  discoveryTransport: "http" | "jobstreaming";
  expectedTransportFailures: {
    request: Request;
    errorText: "net::ERR_FAILED";
  }[];
  allowRequestFailure: (request: Request, errorText: "net::ERR_FAILED") => void;
  expectedResponseErrors: Response[];
  allowResponseError: (
    response: Response,
    expected: { method: "GET" | "POST"; status: 409; code: string },
  ) => Promise<void>;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  features: [undefined, { option: true }],
  discoveryTransport: ["http", { option: true }],
  expectedTransportFailures: async ({}, use) => {
    await use([]);
  },
  expectedResponseErrors: async ({}, use) => {
    await use([]);
  },
  allowResponseError: async ({ app, expectedResponseErrors }, use) => {
    await use(async (response, expected) => {
      expect(expected.status).toBe(409);
      expect(response.status()).toBe(expected.status);
      expect(response.request().method()).toBe(expected.method);
      expect(new URL(response.url()).origin).toBe(app.baseURL);
      const body = (await response.json()) as { error?: { code?: unknown } };
      expect(
        body.error?.code,
        "Only the explicitly expected domain refusal may allow its native console entry",
      ).toBe(expected.code);
      expect(expectedResponseErrors.includes(response)).toBe(false);
      expectedResponseErrors.push(response);
    });
  },
  allowRequestFailure: async ({ app, expectedTransportFailures }, use) => {
    await use((request, errorText) => {
      expect(errorText).toBe("net::ERR_FAILED");
      expect(
        request.method() === "POST" ||
          (request.method() === "PATCH" &&
            new URL(request.url()).origin === app.baseURL &&
            new URL(request.url()).pathname === "/v1/credentials/batch"),
        "Only an observed admitted POST or credential batch acknowledgement may be severed",
      ).toBe(true);
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
  temporal: [
    async ({}, use) => {
      const runtime = await temporalStack();
      try {
        await use(runtime);
      } finally {
        await runtime.close();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
  app: [
    async ({ temporal, features, discoveryTransport }, use, testInfo) => {
      const runtime: ApplicationStack = await applicationStack(
        temporal.address,
        { features, discoveryTransport },
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
        if (retainState) temporal.retainForDiagnosis();
        await runtime.close({ retainState });
      }
    },
    { timeout: 60_000 },
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
    `Temporal action ${runId}: ${JSON.stringify(result)}`,
  ).toBe("succeeded");
  return result;
}

export async function terminal(api: APIRequestContext, runId: string) {
  let result: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        result = await json(api, "get", `/v1/action-runs/${runId}`);
        return ["succeeded", "failed", "cancelled"].includes(
          String(result["status"]),
        );
      },
      // Production heartbeat timeout is 30s; allow its bounded retry and
      // canonical terminal reconciliation on the declared runner.
      { timeout: 45_000, message: `Temporal action ${runId} must terminalize` },
    )
    .toBe(true);
  return result;
}
