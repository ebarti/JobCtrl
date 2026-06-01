import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useApplicationOutcomesQuery } from "./useApplicationOutcomesQuery.js";
import { useApplyReviewQueueQuery } from "./useApplyReviewQueueQuery.js";
import { useJobApplicationOutcomesQuery } from "./useJobApplicationOutcomesQuery.js";

describe("apply review and outcome queries", () => {
  it("loads the application review queue", async () => {
    const { result } = renderHookWithProviders(() => useApplyReviewQueueQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.jobKey).toBe("job-2");
  });

  it("loads global outcome suggestions", async () => {
    const { result } = renderHookWithProviders(() => useApplicationOutcomesQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.suggestions[0]?.suggestionId).toBe("suggestion-1");
  });

  it("loads per-job outcomes", async () => {
    const { result } = renderHookWithProviders(() => useJobApplicationOutcomesQuery("job-2"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.jobKey).toBe("job-2");
    expect(result.current.data?.outcomes[0]?.jobKey).toBe("job-2");
  });

  it("surfaces per-job outcome query errors", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey/outcomes", () =>
        HttpResponse.json({ ok: false, error: "job_not_found" }, { status: 404 }),
      ),
    );

    const { result } = renderHookWithProviders(() => useJobApplicationOutcomesQuery("missing"));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
