import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { act } from "react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import {
  useApplyReviewDecisionMutation,
  useOutcomeSuggestionDecisionMutation,
  useRecordManualApplicationOutcomeMutation,
} from "./useApplyReviewMutations.js";

describe("apply review mutations", () => {
  it("records review decisions and invalidates review surfaces", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useApplyReviewDecisionMutation());
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: { decision: "approve_submit", reason: "approved", decidedBy: "user" },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.decision.decision).toBe("approve_submit");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: applyReviewKeys.queue(LOCAL_TENANT),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.detail(LOCAL_TENANT, "job-2"),
    });
  });

  it("leaves cache data intact when review decisions fail", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/apply-review/decision", () =>
        HttpResponse.json({ ok: false, error: "failed" }, { status: 500 }),
      ),
    );
    const initialQueue = { ok: true, items: [] };
    const { result, queryClient } = renderHookWithProviders(() => useApplyReviewDecisionMutation());
    queryClient.setQueryData(applyReviewKeys.queue(LOCAL_TENANT), initialQueue);

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: { decision: "defer", reason: "later", decidedBy: "user" },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(applyReviewKeys.queue(LOCAL_TENANT))).toEqual(initialQueue);
  });

  it("records manual outcomes and invalidates outcome surfaces", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useRecordManualApplicationOutcomeMutation(),
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: {
          kind: "interview",
          occurredAt: "2026-05-06T08:35:00.000Z",
          note: "Local note",
        },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome.kind).toBe("interview");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.detail(LOCAL_TENANT, "job-2"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.list(LOCAL_TENANT),
    });
  });

  it("leaves outcome cache data intact when manual outcome recording fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/outcomes", () =>
        HttpResponse.json({ ok: false, error: "failed" }, { status: 500 }),
      ),
    );
    const initialOutcomes = { ok: true, jobKey: "job-2", outcomes: [], suggestions: [] };
    const { result, queryClient } = renderHookWithProviders(() =>
      useRecordManualApplicationOutcomeMutation(),
    );
    queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"), initialOutcomes);

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: {
          kind: "interview",
          occurredAt: "2026-05-06T08:35:00.000Z",
        },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"))).toEqual(
      initialOutcomes,
    );
  });

  it("decides outcome suggestions and invalidates job outcome surfaces", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useOutcomeSuggestionDecisionMutation(),
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        suggestionId: "suggestion-1",
        jobId: "job-2",
        body: { decision: "accept", reason: "accepted" },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.suggestion.status).toBe("accepted");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.detail(LOCAL_TENANT, "job-2"),
    });
  });

  it("leaves outcome cache data intact when suggestion decisions fail", async () => {
    server.use(
      http.post("*/v1/outcome-suggestions/:suggestionId/decision", () =>
        HttpResponse.json({ ok: false, error: "failed" }, { status: 500 }),
      ),
    );
    const initialOutcomes = { ok: true, jobKey: "job-2", outcomes: [], suggestions: [] };
    const { result, queryClient } = renderHookWithProviders(() =>
      useOutcomeSuggestionDecisionMutation(),
    );
    queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"), initialOutcomes);

    await act(async () => {
      result.current.mutate({
        suggestionId: "suggestion-1",
        jobId: "job-2",
        body: { decision: "ignore", reason: "not useful" },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"))).toEqual(
      initialOutcomes,
    );
  });
});
