import { test as base, expect } from "@playwright/test";
// @ts-expect-error Node-only process harness does not ship application declarations.
import { demoStack } from "./runtime.mjs";

type Demo = { baseURL: string; directory: string; buildMs: number; setupMs: number; close(): Promise<void> };
export const test = base.extend<{}, { demo: Demo }>({
  extraHTTPHeaders: { "CF-Connecting-IP": "127.0.0.1" },
  demo: [async ({}, use, workerInfo) => {
    const runtime: Demo = await demoStack();
    console.log(JSON.stringify({ mode: "demo", worker: workerInfo.workerIndex, buildMs: runtime.buildMs, setupMs: runtime.setupMs }));
    try { await use(runtime); } finally { await runtime.close(); }
  }, { scope: "worker", timeout: 120_000 }],
  baseURL: async ({ demo }, use) => { await use(demo.baseURL); },
});
export { expect };
