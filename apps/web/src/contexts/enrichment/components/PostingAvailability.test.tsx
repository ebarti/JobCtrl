import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PostingAvailability as Availability } from "../../operations/types.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { makeJobDetail, sampleJob } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { PostingAvailability } from "./PostingAvailability.js";

const evidence: Availability = {
  failureCode: null, determinations: [],
  jobId: sampleJob.jobKey, postingUrl: sampleJob.url, verdict: "unknown", reason: "http_error",
  method: "public_http", lastAttemptedAt: "2026-10-04T10:00:00Z",
  lastSuccessfullyVerifiedAt: "2026-10-01T10:00:00Z", lastSuccessfulState: "active",
  lastSuccessfulEvidenceRef: "availability:previous", nextDueAt: "2026-10-04T10:05:00Z",
  evidenceRef: "availability:latest", overdue: true, checkInProgress: false,
  lineage: [{ sourceUrl: sampleJob.url, finalUrl: sampleJob.url, status: 429,
    method: "public_http", rawHash: "a".repeat(64), signals: [] }],
};

describe("posting availability", () => {
  it("replaces queued feedback with persisted coalescing or cooldown feedback without inventing an attempt", async () => {
    const checkPostingAvailability = vi.fn(async () => ({ ok: true as const, status: "queued" as const, runId: "run", workflowId: "workflow" }));
    const view = renderWithProviders(<PostingAvailability jobId={sampleJob.jobKey} postingUrl={sampleJob.url} availability={evidence} />,
      { ports: buildTestPorts({ api: { checkPostingAvailability } }) });
    fireEvent.click(screen.getByRole("button", { name: "Check availability" }));
    await screen.findByText(/Check requested/);
    for (const reason of ["check_in_progress", "retry_backoff"]) {
      view.rerender(<PostingAvailability jobId={sampleJob.jobKey} postingUrl={sampleJob.url} availability={{ ...evidence,
        request: { status: "deferred", reason, requestedAt: new Date(Date.now() + 1000).toISOString(), retryAt: "2026-10-04T10:05:00Z" } }} />);
      expect(screen.getByText(new RegExp(`Check deferred: ${reason.replaceAll("_", " ")}`))).toHaveTextContent(/Retry after/);
      expect(screen.queryByText(/Check requested/)).not.toBeInTheDocument();
      expect(screen.getByText(/Last attempt:/)).toHaveTextContent(/Last successful verification/);
    }
  });

  it("keeps latest uncertainty, earlier success and offline freshness visible and accessible", async () => {
    const view = renderWithProviders(<PostingAvailability jobId={sampleJob.jobKey} postingUrl={sampleJob.url} availability={evidence} />);
    expect(screen.getByText(/Availability unverified.*Check overdue/)).toBeVisible();
    expect(screen.getByText(/Last successful verification:.*\(active\)/)).toBeVisible();
    expect(screen.getByText(/Sleep or offline time/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Inspect employer posting" })).toHaveAttribute("href", sampleJob.url);
    fireEvent.click(screen.getByText("Availability evidence"));
    expect(screen.getByText(/429.*SHA-256/)).toBeVisible();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("requests a check through its port and invalidates tenant-scoped reads", async () => {
    const checkPostingAvailability = vi.fn(async () => ({ ok: true as const, status: "queued" as const, runId: "run", workflowId: "workflow" }));
    const { queryClient } = renderWithProviders(<PostingAvailability jobId={sampleJob.jobKey} postingUrl={sampleJob.url} availability={evidence} />,
      { ports: buildTestPorts({ api: { checkPostingAvailability } }) });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Check availability" }));
    await screen.findByText(/Check requested/);
    expect(checkPostingAvailability).toHaveBeenCalledWith(sampleJob.jobKey, {});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
  });

  it("rolls back the optimistic claim and offers retry when the worker is unavailable", async () => {
    let reject!: (error: Error) => void;
    const checkPostingAvailability = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    const { queryClient } = renderWithProviders(<PostingAvailability jobId={sampleJob.jobKey} postingUrl={sampleJob.url} availability={evidence} />,
      { ports: buildTestPorts({ api: { checkPostingAvailability } }) });
    const key = jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey);
    const previous = makeJobDetail({ ...sampleJob, availability: evidence });
    queryClient.setQueryData(key, previous);
    fireEvent.click(screen.getByRole("button", { name: "Check availability" }));
    await waitFor(() => expect(queryClient.getQueryData<typeof previous>(key)?.job.availability?.checkInProgress).toBe(true));
    await act(async () => reject(new Error("Worker offline")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker offline");
    expect(queryClient.getQueryData(key)).toEqual(previous);
    expect(screen.getByRole("button", { name: "Check availability" })).toBeEnabled();
  });
});
