import type { PostingAvailability } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { useQuery } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { useCorrectScoreMutation } from "../../scoring/hooks/useCorrectScoreMutation.js";
import { makeJobDetail, sampleJob } from "../../../test/fixtures/projections.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useCheckAvailabilityMutation } from "./useCheckAvailabilityMutation.js";

const availability: PostingAvailability = {
  failureCode: null, determinations: [], jobId: sampleJob.jobKey, postingUrl: sampleJob.url,
  verdict: "unknown", reason: "http_error", method: "public_http", lastAttemptedAt: null,
  lastSuccessfullyVerifiedAt: null, lastSuccessfulState: null, lastSuccessfulEvidenceRef: null,
  nextDueAt: null, evidenceRef: null, overdue: true, checkInProgress: false, lineage: [],
};

describe("availability and score mutation ownership", () => {
  for (const startFirst of ["score", "availability"] as const) {
    for (const failFirst of ["score", "availability"] as const) {
      it(`preserves the other patch when ${startFirst} starts first and ${failFirst} fails first`, async () => {
        let rejectScore!: (error: Error) => void;
        let rejectAvailability!: (error: Error) => void;
        const correctScore = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectScore = reject; }));
        const checkPostingAvailability = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectAvailability = reject; }));
        let reads = 0;
        const queryClient = createTestQueryClient();
        const key = jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey);
        const baseline = makeJobDetail({ ...sampleJob, availability });
        queryClient.setQueryData(key, baseline);
        const { result } = renderHookWithProviders(() => ({
          score: useCorrectScoreMutation(),
          availability: useCheckAvailabilityMutation(),
          query: useQuery<ReturnType<typeof makeJobDetail>>({ queryKey: key, queryFn: async () => {
            reads += 1;
            throw new Error("Synthetic failed reconciliation");
          } }),
        }), { queryClient, ports: buildTestPorts({ api: { correctScore, checkPostingAvailability } }) });
        const start = async (operation: typeof startFirst) => {
          if (operation === "score") {
            act(() => result.current.score.mutate({ jobId: sampleJob.jobKey, correctedScore: 9, reason: "synthetic" }));
            await waitFor(() => expect(correctScore).toHaveBeenCalledTimes(1));
          } else {
            act(() => result.current.availability.mutate(sampleJob.jobKey));
            await waitFor(() => expect(checkPostingAvailability).toHaveBeenCalledTimes(1));
          }
        };
        await start(startFirst);
        await start(startFirst === "score" ? "availability" : "score");
        const fail = async (operation: typeof failFirst, waitForSettlement = true) => {
          if (operation === "score") {
            act(() => rejectScore(new Error("Synthetic score failure")));
            await waitFor(() => expect(result.current.score.isError).toBe(true));
          } else {
            act(() => rejectAvailability(new Error("Synthetic availability failure")));
            if (waitForSettlement) await waitFor(() => expect(result.current.availability.isError).toBe(true));
            else await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
          }
        };
        await fail(failFirst, failFirst !== "availability");
        const afterFirst = queryClient.getQueryData<typeof baseline>(key)!;
        expect(afterFirst.job.fitScore).toBe(failFirst === "score" ? sampleJob.fitScore : 9);
        expect(afterFirst.job.availability?.checkInProgress).toBe(failFirst === "score");
        await fail(failFirst === "score" ? "availability" : "score");
        if (failFirst === "availability") await waitFor(() => expect(result.current.availability.isError).toBe(true));
        await waitFor(() => expect(reads).toBeGreaterThan(0));
        expect(queryClient.getQueryData(key)).toEqual(baseline);
      });
    }
  }

  it("retains score ownership when availability cancels an in-flight reconciliation", async () => {
    let rejectScore!: (error: Error) => void;
    let rejectAvailability!: (error: Error) => void;
    const correctScore = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectScore = reject; }));
    const checkPostingAvailability = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectAvailability = reject; }));
    let reads = 0;
    const queryClient = createTestQueryClient();
    const key = jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey);
    const baseline = makeJobDetail({ ...sampleJob, availability });
    queryClient.setQueryData(key, baseline);
    const { result } = renderHookWithProviders(() => ({
      score: useCorrectScoreMutation(),
      availability: useCheckAvailabilityMutation(),
      query: useQuery<ReturnType<typeof makeJobDetail>>({ queryKey: key, queryFn: async () => {
        reads += 1;
        if (reads === 1) return new Promise<ReturnType<typeof makeJobDetail>>(() => {});
        throw new Error("Synthetic failed reconciliation");
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { correctScore, checkPostingAvailability } }) });
    act(() => result.current.score.mutate({ jobId: sampleJob.jobKey, correctedScore: 9, reason: "synthetic" }));
    await waitFor(() => expect(correctScore).toHaveBeenCalledTimes(1));
    void queryClient.refetchQueries({ queryKey: key, exact: true });
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.availability.mutate(sampleJob.jobKey));
    await waitFor(() => expect(checkPostingAvailability).toHaveBeenCalledTimes(1));
    act(() => rejectScore(new Error("Synthetic score failure")));
    await waitFor(() => expect(result.current.score.isError).toBe(true));
    expect(queryClient.getQueryData<typeof baseline>(key)?.job).toMatchObject({
      fitScore: sampleJob.fitScore, availability: { checkInProgress: true },
    });
    act(() => rejectAvailability(new Error("Synthetic availability failure")));
    await waitFor(() => expect(result.current.availability.isError).toBe(true));
    expect(queryClient.getQueryData(key)).toEqual(baseline);
  });

  it("keeps the availability mutation pending until targeted invalidations settle", async () => {
    let rejectRead!: (error: Error) => void;
    const queryClient = createTestQueryClient();
    const key = jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey);
    queryClient.setQueryData(key, makeJobDetail({ ...sampleJob, availability }));
    const descendant = [...key, "nested"] as const;
    queryClient.setQueryData(descendant, { untouched: true });
    const cancel = vi.spyOn(queryClient, "cancelQueries");
    const checkPostingAvailability = vi.fn(async () => ({ ok: true as const, status: "queued" as const, runId: "run", workflowId: "workflow" }));
    const read = vi.fn(() => new Promise<ReturnType<typeof makeJobDetail>>((_resolve, reject) => { rejectRead = reject; }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => ({
      mutation: useCheckAvailabilityMutation(),
      query: useQuery({ queryKey: key, queryFn: read }),
    }), { queryClient, ports: buildTestPorts({ api: { checkPostingAvailability } }) });
    act(() => result.current.mutation.mutate(sampleJob.jobKey));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(result.current.mutation.isPending).toBe(true);
    expect(cancel).toHaveBeenCalledWith({ queryKey: key, exact: false });
    expect(queryClient.getQueryData(descendant)).toEqual({ untouched: true });
    act(() => rejectRead(new Error("Synthetic failed reconciliation")));
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
  });

  it("finishes availability while an overlapping score write defers the stale detail read", async () => {
    let resolveAvailability!: (value: { ok: true; status: "queued"; runId: string; workflowId: string }) => void;
    let rejectScore!: (error: Error) => void;
    let rejectRead!: (error: Error) => void;
    const checkPostingAvailability = vi.fn(() => new Promise<{ ok: true; status: "queued"; runId: string; workflowId: string }>((resolve) => { resolveAvailability = resolve; }));
    const correctScore = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectScore = reject; }));
    const queryClient = createTestQueryClient();
    const key = jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey);
    queryClient.setQueryData(key, makeJobDetail({ ...sampleJob, availability }));
    let reads = 0;
    const { result } = renderHookWithProviders(() => ({
      availability: useCheckAvailabilityMutation(),
      score: useCorrectScoreMutation(),
      query: useQuery({ queryKey: key, queryFn: () => {
        reads += 1;
        return new Promise<ReturnType<typeof makeJobDetail>>((_resolve, reject) => { rejectRead = reject; });
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { checkPostingAvailability, correctScore } }) });
    act(() => result.current.availability.mutate(sampleJob.jobKey));
    await waitFor(() => expect(checkPostingAvailability).toHaveBeenCalledTimes(1));
    act(() => result.current.score.mutate({ jobId: sampleJob.jobKey, correctedScore: 9, reason: "synthetic" }));
    await waitFor(() => expect(correctScore).toHaveBeenCalledTimes(1));
    act(() => resolveAvailability({ ok: true, status: "queued", runId: "run", workflowId: "workflow" }));
    await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
    await waitFor(() => expect(result.current.availability.isSuccess).toBe(true));
    expect(result.current.score.isPending).toBe(true);
    expect(reads).toBe(0);
    act(() => rejectScore(new Error("Synthetic score failure")));
    await waitFor(() => expect(result.current.score.isError).toBe(true));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    act(() => rejectRead(new Error("Synthetic failed reconciliation")));
    await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
  });
});
