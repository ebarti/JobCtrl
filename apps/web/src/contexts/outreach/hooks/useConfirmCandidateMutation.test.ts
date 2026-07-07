import type { ContactResearchDetailResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { makeResearchDetailResponse } from "../../../test/fixtures/contact-research.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useConfirmCandidateMutation } from "./useConfirmCandidateMutation.js";

function detail(queryClient: import("@tanstack/react-query").QueryClient): ContactResearchDetailResponse {
  return queryClient.getQueryData(
    outreachKeys.researchTask(LOCAL_TENANT, "task-1"),
  ) as ContactResearchDetailResponse;
}

describe("useConfirmCandidateMutation", () => {
  it("optimistically marks the candidate confirmed and resolves on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useConfirmCandidateMutation("task-1"),
    );
    queryClient.setQueryData(
      outreachKeys.researchTask(LOCAL_TENANT, "task-1"),
      makeResearchDetailResponse(),
    );
    await act(async () => {
      result.current.mutate({ candidateId: "cand-1" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.task.status).toBe("completed");
    expect(detail(queryClient).task.candidates[0]?.status).toBe("confirmed");
  });

  it("rolls back the optimistic confirm when the POST fails (INV-4 preserved)", async () => {
    server.use(
      http.post("*/v1/contacts/research/:taskId/candidates/:candidateId/confirm", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useConfirmCandidateMutation("task-1"),
    );
    queryClient.setQueryData(
      outreachKeys.researchTask(LOCAL_TENANT, "task-1"),
      makeResearchDetailResponse(),
    );
    await act(async () => {
      result.current.mutate({ candidateId: "cand-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // The candidate is restored to needs_review — nothing was stored (INV-4).
    expect(detail(queryClient).task.candidates[0]?.status).toBe("needs_review");
    expect(detail(queryClient).task.needsReviewCount).toBe(1);
  });
});
