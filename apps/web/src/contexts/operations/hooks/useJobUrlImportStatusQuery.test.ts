import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JobUrlImportStatusResponse } from "@jobctrl/contracts";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useJobUrlImportStatusQuery } from "./useJobUrlImportStatusQuery.js";

const execution = { workflowId: "job-url-import-owned", executionId: "11111111-1111-4111-8111-111111111111" };
const imported: JobUrlImportStatusResponse = { ok: true, status: "imported", jobKey: "22222222-2222-4222-8222-222222222222", importedAt: "2026-10-24T12:00:00Z", alreadyExisted: false };

describe("useJobUrlImportStatusQuery", () => {
  it("keeps an acknowledged import pending beyond two minutes and follows completion", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let complete = false;
    const status = vi.fn(async (): Promise<JobUrlImportStatusResponse> => complete ? imported : { ok: true, status: "pending", ...execution });
    const { result, unmount } = renderHookWithProviders(() => useJobUrlImportStatusQuery(execution), {
      ports: buildTestPorts({ api: { jobUrlImportStatus: status } }),
    });
    try {
      await vi.waitFor(() => expect(result.current.data?.status).toBe("pending"));
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
      expect(result.current.data?.status).toBe("pending");
      expect(result.current.isError).toBe(false);
      expect(status.mock.calls.length).toBeGreaterThan(1);
      complete = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      await vi.waitFor(() => expect(result.current.data?.status).toBe("imported"));
    } finally { unmount(); vi.useRealTimers(); }
  });

  it("stops polling a terminal canceled execution", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const status = vi.fn(async (): Promise<JobUrlImportStatusResponse> => ({ ok: true, status: "canceled", message: "Import canceled.", ...execution }));
    const { result, unmount } = renderHookWithProviders(() => useJobUrlImportStatusQuery(execution), { ports: buildTestPorts({ api: { jobUrlImportStatus: status } }) });
    try {
      await vi.waitFor(() => expect(result.current.data?.status).toBe("canceled"));
      const calls = status.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(status).toHaveBeenCalledTimes(calls);
    } finally { unmount(); vi.useRealTimers(); }
  });
});
