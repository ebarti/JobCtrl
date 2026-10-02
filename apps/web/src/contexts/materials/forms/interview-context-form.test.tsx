import { JobCtrlApiError } from "@jobctrl/api-client";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateInterviewPrepRequest } from "../../operations/types.js";
import { profileKeys } from "../../operations/queryKeys.js";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { sampleInterviewCatalogResponse } from "../../../test/fixtures/interviews.js";
import { sampleEvidenceMapResponse, sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { useInterviewDraftStore } from "../stores/interview-drafts.js";
import { InterviewContextForm } from "./interview-context-form.js";

const catalog = sampleInterviewCatalogResponse.catalog;
const queued = { ok: true as const, runId: "run-prep", actionId: "act-prep", action: "generate_interview_prep" as const, status: "queued", jobKey: "job-1", command: { action: "generate_interview_prep" as const, jobKey: "job-1" } };
beforeEach(() => useInterviewDraftStore.setState({ selections: new Map(), notes: new Map() }));

async function selectQuestion() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add question to preparation" }));
  await user.click(screen.getByText("Evidence for B11: automatic selection"));
  await screen.findByText(/Saved Profile version 3/);
  return user;
}

describe("question selection and canonical evidence choices", () => {
  it("dispatches ordered explicit facts and an explicit empty choice; retains them across question navigation", async () => {
    const generate = vi.fn(async (_jobId: string, _body?: GenerateInterviewPrepRequest) => queued);
    const view = renderWithProviders(<InterviewContextForm jobId="job-1" catalog={catalog} questionId="B11" />, { ports: buildTestPorts({ api: { generateInterviewPrep: generate } }) });
    const user = await selectQuestion();
    const title = sampleEvidenceMapResponse.entries[0]!.title;
    await user.click(screen.getByRole("checkbox", { name: `Use ${title} for B11` }));
    view.rerender(<InterviewContextForm jobId="job-1" catalog={catalog} questionId="TS09" />);
    await user.click(screen.getByRole("button", { name: "Add question to preparation" }));
    await user.click(screen.getByText("Evidence for TS09: automatic selection"));
    await user.click(screen.getByRole("button", { name: "Use no evidence for TS09" }));
    await user.click(screen.getByRole("button", { name: "Generate selected preparation" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0]?.[1]).toMatchObject({ selectedQuestionIds: ["B11", "TS09"], evidenceSelections: [{ questionId: "B11", evidenceIds: ["ev-platform-reliability"] }, { questionId: "TS09", evidenceIds: [] }], evidenceProfileVersion: 3, interviewStage: "unknown" });
    expect(screen.getByRole("checkbox", { name: `Use ${title} for B11` })).toBeChecked();
  });

  it("retains stale choices and requires explicit review at the new saved Profile version", async () => {
    const generate = vi.fn(async () => queued);
    const view = renderWithProviders(<InterviewContextForm jobId="job-1" catalog={catalog} questionId="B11" />, { ports: buildTestPorts({ api: { generateInterviewPrep: generate } }) });
    const user = await selectQuestion();
    await user.click(screen.getByRole("button", { name: "Use no evidence for B11" }));
    act(() => view.queryClient.setQueryData(profileKeys.profile(LOCAL_TENANT), { ...sampleProfileResponse, profileVersion: 4 }));
    await screen.findByText(/Your choices are retained at version 3/);
    expect(screen.getByRole("button", { name: "Generate selected preparation" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Confirm reviewed evidence at Profile version 4" }));
    expect(screen.getByRole("button", { name: "Generate selected preparation" })).toBeEnabled();
  });

  it("keeps choices after server stale-version rejection and exposes no skills, draft or unconfirmed achievements", async () => {
    const title = sampleEvidenceMapResponse.entries[0]!.title;
    const excluded = { ...sampleEvidenceMapResponse.entries[0]!, entryId: "unconfirmed", evidenceId: "unconfirmed", title: "Unconfirmed fact", freshness: { ...sampleEvidenceMapResponse.entries[0]!.freshness, userConfirmed: false } };
    const generate = vi.fn(async () => { throw new JobCtrlApiError(409, "Conflict", "evidence_profile_changed", { error: "evidence_profile_changed" }); });
    renderWithProviders(<InterviewContextForm jobId="job-1" catalog={catalog} questionId="B11" />, { ports: buildTestPorts({ api: { generateInterviewPrep: generate, evidenceMap: async () => ({ ...sampleEvidenceMapResponse, entries: [...sampleEvidenceMapResponse.entries, excluded] }) } }) });
    const user = await selectQuestion();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryByRole("checkbox", { name: /Unconfirmed fact|Python/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: `Use ${title} for B11` }));
    await user.click(screen.getByRole("button", { name: "Generate selected preparation" }));
    await screen.findByText(/Preparation failed:/);
    expect(screen.getByRole("checkbox", { name: `Use ${title} for B11` })).toBeChecked();
    expect(screen.getByRole("button", { name: "Generate selected preparation" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Confirm reviewed evidence at Profile version 3" }));
    expect(screen.getByRole("button", { name: "Generate selected preparation" })).toBeEnabled();
  });
});
