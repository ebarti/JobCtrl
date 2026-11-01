import { createTenantId, LOCAL_TENANT } from "@jobctrl/domain-types";
import { afterEach, expect, it } from "vitest";

import { useToastStore } from "../../../shared/stores/toasts.js";
import { createTestQueryClient } from "../../../test/render.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { observeRetryDetailConfirmation, retryStatusScope } from "./retryStatusConfirmation.js";

const jobId = "synthetic-job";
const locator = "https://example.com/jobs/confirmation";
const detail = { job: { jobKey: jobId } };

afterEach(() => useToastStore.getState().clear());

it("confirms only a later non-manual read for the same tenant, locator, and job", async () => {
  const client = createTestQueryClient();
  const key = jobsKeys.detail(LOCAL_TENANT, locator);
  const otherKey = jobsKeys.detail(createTenantId("synthetic-other-tenant"), locator);
  let releaseOldRead!: () => void;
  const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
  const oldRead = client.fetchQuery({ queryKey: key, queryFn: async () => { await oldReadHeld; return detail; } });
  const noticeId = useToastStore.getState().toast({ variant: "warning", message: "Synthetic uncertainty",
    durationMs: 0, scope: retryStatusScope(LOCAL_TENANT, jobId, locator) });
  observeRetryDetailConfirmation(client, key, noticeId, jobId);
  try {
    releaseOldRead();
    await oldRead;
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
    await client.fetchQuery({ queryKey: otherKey, queryFn: async () => detail });
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
    await client.fetchQuery({ queryKey: key, staleTime: 0,
      queryFn: async () => ({ job: { jobKey: "another-synthetic-job" } }) });
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
    client.setQueryData(key, detail);
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
    await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async () => detail });
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(false);
  } finally {
    releaseOldRead();
    client.clear();
  }
});

it("does not let a removed query confirm its replacement", async () => {
  const client = createTestQueryClient();
  const key = jobsKeys.detail(LOCAL_TENANT, locator);
  client.setQueryData(key, detail);
  const noticeId = useToastStore.getState().toast({ variant: "warning", message: "Synthetic uncertainty",
    durationMs: 0, scope: retryStatusScope(LOCAL_TENANT, jobId, locator) });
  observeRetryDetailConfirmation(client, key, noticeId, jobId);
  let releaseRead!: () => void;
  const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
  const read = client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async () => { await readHeld; return detail; } });
  const settledRead = read.catch(() => undefined);
  try {
    client.removeQueries({ queryKey: key, exact: true });
    client.setQueryData(key, detail);
    releaseRead();
    await settledRead;
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
    await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async () => detail });
    expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(false);
  } finally {
    releaseRead();
    await settledRead;
    client.clear();
  }
});

it("does not use an earlier retry's in-flight confirmation for a later notice", async () => {
  const client = createTestQueryClient();
  const key = jobsKeys.detail(LOCAL_TENANT, locator);
  const addNotice = () => useToastStore.getState().toast({ variant: "warning", message: "Synthetic uncertainty",
    durationMs: 0, scope: retryStatusScope(LOCAL_TENANT, jobId, locator) });
  const firstId = addNotice();
  observeRetryDetailConfirmation(client, key, firstId, jobId);
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  const read = client.fetchQuery({ queryKey: key, queryFn: async () => { await held; return detail; } });
  const secondId = addNotice();
  observeRetryDetailConfirmation(client, key, secondId, jobId);
  try {
    releaseRead();
    await read;
    expect(useToastStore.getState().toasts.some((entry) => entry.id === firstId)).toBe(false);
    expect(useToastStore.getState().toasts.some((entry) => entry.id === secondId)).toBe(true);
    await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async () => detail });
    expect(useToastStore.getState().toasts.some((entry) => entry.id === secondId)).toBe(false);
  } finally {
    releaseRead();
    client.clear();
  }
});
