import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useJobDetailQuery } from "./useJobDetailQuery.js";

describe("useJobDetailQuery", () => {
  it("returns the job detail with stages", async () => {
    const { result } = renderHookWithProviders(() => useJobDetailQuery("job-7"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.job.jobKey).toBe("job-7");
    expect(result.current.data?.stages.length).toBeGreaterThan(0);
  });

  it("surfaces 404 errors as a thrown error", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useJobDetailQuery("missing"));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
