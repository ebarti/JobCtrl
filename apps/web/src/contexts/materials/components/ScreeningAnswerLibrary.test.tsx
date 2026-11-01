import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import { renderHookWithProviders, renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { materialsKeys } from "../queryKeys.js";
import { useScreeningAnswerMutation } from "../hooks/useResumeTemplateMaterialMutations.js";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { ScreeningAnswerLibrary } from "./ScreeningAnswerLibrary.js";

type Read = Awaited<ReturnType<ApiClientPort["screeningAnswers"]>>;
type Write = Awaited<ReturnType<ApiClientPort["writeScreeningAnswer"]>>;
export function screeningRead(): Read {
  const binding = { profileVersion: 1, profileHash: "a".repeat(64), postingHash: "b".repeat(64), destination: "https://example.test/apply", posting: "Synthetic posting", materials: [], facts: [], sensitiveFactIds: [] };
  const answer = { answerId: "answer", text: "Reviewed synthetic answer", uncertainty: "", binding: { ...binding, question: "Synthetic question", context: "Synthetic context", applicationId: "attempt" }, question: "Synthetic question", context: "Synthetic context", determinationIds: ["a".repeat(64), "b".repeat(64), "c".repeat(64)], libraryId: null, reviewId: "review", staleReason: null };
  const state = { questionId: "question", jobId: "job-1", applicationId: "attempt", revision: 3, question: "Synthetic question", context: "Synthetic context", captureBinding: binding, accepted: answer, draft: answer, action: "review" as const, snapshotId: "snapshot", recordedAt: "2026-10-08T00:00:00Z", decision: "approved" as const };
  return { ok: true, jobId: "job-1", questions: [state], history: [state], library: [], facts: [{ id: "profile:/compensation/salary_expectation", text: "\"Synthetic deliberate value\"", sensitive: true }], sourceBinding: binding, sourceFailure: null, determinations: [], failures: [] };
}

export function screeningPorts(read: Read = screeningRead()) {
  return buildTestPorts({ api: { screeningAnswers: vi.fn(async () => read), writeScreeningAnswer: vi.fn(async (_jobId, command) => ({ ok: true as const, jobId: "job-1", state: { ...read.questions[0]!, revision: command.expectedRevision + 1, action: command.action } })) } });
}

describe("Screening answers", () => {
  it("copy failures record no use; actual changed text needs deliberate attestation", async () => {
    const ports = screeningPorts();
    ports.clipboard.write = vi.fn(async () => { throw new Error("Owned copy failure"); });
    const user = userEvent.setup();
    renderWithProviders(<ScreeningAnswerLibrary jobId="job-1" />, { ports });
    fireEvent.click(screen.getByRole("button", { name: "Open screening answers" }));
    await user.click(await screen.findByRole("button", { name: "Copy reviewed answer" }));
    expect(await screen.findByText("Copy failed; no manual use recorded.")).toBeVisible();
    expect(ports.api.writeScreeningAnswer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record manual use" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Actual manually used text"));
    await user.type(screen.getByLabelText("Actual manually used text"), "Changed manually used answer");
    await user.click(screen.getByLabelText("I manually used the exact text above for this application attempt"));
    await user.click(screen.getByRole("button", { name: "Record manual use" }));
    await waitFor(() => expect(ports.api.writeScreeningAnswer).toHaveBeenCalledWith("job-1", expect.objectContaining({ action: "use", attested: true, text: "Changed manually used answer", expectedRevision: 3 })));
  });

  it("keeps accepted content and unsaved edits after failed refresh, including navigation", async () => {
    const ports = screeningPorts();
    ports.api.writeScreeningAnswer = vi.fn(async () => { throw new Error("Owned provider failure"); });
    const user = userEvent.setup();
    const view = renderWithProviders(<ScreeningAnswerLibrary jobId="job-1" />, { ports });
    fireEvent.click(screen.getByRole("button", { name: "Open screening answers" }));
    const input = await screen.findByLabelText("Edit answer draft");
    await user.type(input, "Unsaved local text");
    await user.click(screen.getByRole("button", { name: "Generate answer draft" }));
    expect(await screen.findByText(/Answer operation failed/)).toBeVisible();
    expect(input).toHaveValue("Unsaved local text");
    expect(screen.getAllByText("Reviewed synthetic answer").length).toBeGreaterThan(0);
    view.unmount();
    renderWithProviders(<ScreeningAnswerLibrary jobId="job-1" />, { ports });
    fireEvent.click(screen.getByRole("button", { name: "Open screening answers" }));
    expect(await screen.findByLabelText("Edit answer draft")).toHaveValue("Unsaved local text");
  });

  it("refuses a newly stale source before clipboard access and displays the stale accepted answer", async () => {
    const read = screeningRead();
    const ports = screeningPorts(read);
    ports.clipboard.write = vi.fn();
    const user = userEvent.setup();
    const view = renderWithProviders(<ScreeningAnswerLibrary jobId="job-1" />, { ports });
    fireEvent.click(screen.getByRole("button", { name: "Open screening answers" }));
    await screen.findByRole("button", { name: "Copy reviewed answer" });
    const stale = screeningRead();
    stale.questions[0]!.accepted!.staleReason = "screening_sources_changed";
    ports.api.screeningAnswers = vi.fn(async () => stale);
    await user.click(screen.getByRole("button", { name: "Copy reviewed answer" }));
    expect(await screen.findByText("Copy failed; no manual use recorded.")).toBeVisible();
    expect(ports.clipboard.write).not.toHaveBeenCalled();
    view.unmount();
    renderWithProviders(<ScreeningAnswerLibrary jobId="job-1" />, { ports });
    fireEvent.click(screen.getByRole("button", { name: "Open screening answers" }));
    expect(await screen.findByRole("button", { name: "Copy reviewed answer" })).toBeDisabled();
  });

  it("sends sensitive consent only after a separate deliberate selection and retains exact question versions", async () => {
    const ports = screeningPorts();
    renderWithProviders(<ScreeningAnswerLibrary jobId="job-1" />, { ports });
    fireEvent.click(screen.getByRole("button", { name: "Open screening answers" }));
    const fact = await screen.findByLabelText(/profile:\/compensation\/salary_expectation:/);
    fireEvent.click(fact);
    fireEvent.click(screen.getByLabelText("I deliberately authorize this sensitive value for this answer"));
    fireEvent.click(screen.getByRole("button", { name: "Generate answer draft" }));
    await waitFor(() => expect(ports.api.writeScreeningAnswer).toHaveBeenCalledWith("job-1", expect.objectContaining({ selectedFactIds: ["profile:/compensation/salary_expectation"], sensitiveFactIds: ["profile:/compensation/salary_expectation"] })));
  });
});


it("rolls back optimistic question edits after a failed saved revision", async () => {
  const read = screeningRead();
  const ports = screeningPorts(read);
  let rejectWrite: (reason: Error) => void = () => {};
  ports.api.writeScreeningAnswer = vi.fn<ApiClientPort["writeScreeningAnswer"]>(() => new Promise<Write>((_resolve, reject) => { rejectWrite = reject; }));
  const view = renderHookWithProviders(() => useScreeningAnswerMutation("job-1"), { ports });
  const key = materialsKeys.screening(LOCAL_TENANT, "job-1");
  view.queryClient.setQueryData(key, read);
  act(() => view.result.current.mutate({ action: "capture", questionId: "question", question: "Optimistic authored question", context: "Context", applicationId: "attempt", expectedRevision: 3, idempotencyKey: "capture", selectedFactIds: [], sensitiveFactIds: [], attested: false }));
  await waitFor(() => expect(view.queryClient.getQueryData<Read>(key)?.questions[0]?.question).toBe("Optimistic authored question"));
  act(() => rejectWrite(new Error("Owned revision conflict")));
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.queryClient.getQueryData<Read>(key)?.questions[0]?.question).toBe("Synthetic question");
  expect(view.queryClient.getQueryData<Read>(key)?.questions[0]?.accepted?.text).toBe("Reviewed synthetic answer");
});

it("does not roll back a newer canonical answer when an old optimistic edit fails", async () => {
  const read = screeningRead();
  const ports = screeningPorts(read);
  let rejectWrite: (reason: Error) => void = () => {};
  ports.api.writeScreeningAnswer = vi.fn<ApiClientPort["writeScreeningAnswer"]>(() => new Promise<Write>((_resolve, reject) => { rejectWrite = reject; }));
  const view = renderHookWithProviders(() => useScreeningAnswerMutation("job-1"), { ports });
  const key = materialsKeys.screening(LOCAL_TENANT, "job-1");
  view.queryClient.setQueryData(key, read);
  act(() => view.result.current.mutate({ action: "capture", questionId: "question", question: "Optimistic question", context: "Context", applicationId: "attempt", expectedRevision: 3, idempotencyKey: "older", selectedFactIds: [], sensitiveFactIds: [], attested: false }));
  await waitFor(() => expect(view.queryClient.getQueryData<Read>(key)?.questions[0]?.question).toBe("Optimistic question"));
  const newer = screeningRead();
  newer.questions[0]!.revision = 10;
  newer.questions[0]!.accepted!.text = "Newer canonical answer";
  view.queryClient.setQueryData(key, newer);
  act(() => rejectWrite(new Error("Owned stale completion")));
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.queryClient.getQueryData<Read>(key)?.questions[0]?.accepted?.text).toBe("Newer canonical answer");
});
