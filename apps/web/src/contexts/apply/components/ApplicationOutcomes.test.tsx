import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleApplicationOutcomes } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  JobOutcomePanel,
  InterviewReflectionForm,
  ManualOutcomeForm,
  OutcomeSuggestionsPanel,
} from "./ApplicationOutcomes.js";

describe("application outcome components", () => {
  it("renders the job outcome timeline and manual outcome form", async () => {
    renderWithProviders(<JobOutcomePanel jobId="job-2" />);

    const timeline = await screen.findByLabelText(
      "Application outcome timeline",
    );
    expect(
      within(timeline).getByText("Applied confirmation"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Confirmed in the ATS portal."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /record outcome/i }),
    ).toBeInTheDocument();
  });

  it("records a manual outcome with a canonical timestamp payload", async () => {
    const user = userEvent.setup();
    const recordManualApplicationOutcome = vi.fn(async () => ({
      ok: true as const,
      outcome: {
        outcomeId: "outcome-new",
        jobKey: "job-2",
        kind: "interview" as const,
        source: "manual" as const,
        note: "Talked to recruiting.",
        occurredAt: "2026-05-06T08:35:00.000Z",
        recordedAt: "2026-05-06T08:36:00.000Z",
        suggestionId: null,
        evidenceId: null,
        interviewPrepGeneration: null,
      },
    }));

    renderWithProviders(<ManualOutcomeForm jobId="job-2" />, {
      ports: buildTestPorts({ api: { recordManualApplicationOutcome } }),
    });

    await user.click(screen.getByRole("combobox", { name: /outcome/i }));
    await user.click(await screen.findByRole("option", { name: "Interview" }));
    await user.type(screen.getByLabelText(/occurred at/i), "2026-05-06T08:35");
    await user.type(
      screen.getByLabelText(/local note/i),
      "Talked to recruiting.",
    );
    await user.click(screen.getByRole("button", { name: /record outcome/i }));

    await waitFor(() =>
      expect(recordManualApplicationOutcome).toHaveBeenCalledTimes(1),
    );
    expect(recordManualApplicationOutcome).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({
        kind: "interview",
        note: "Talked to recruiting.",
        occurredAt: expect.stringMatching(/Z$/),
      }),
    );
  });

  it("records an interview reflection linked to the prep generation", async () => {
    const user = userEvent.setup();
    const recordManualApplicationOutcome = vi.fn(async () => ({
      ok: true as const,
      outcome: {
        outcomeId: "outcome-reflection",
        jobKey: "job-2",
        kind: "interview" as const,
        source: "manual" as const,
        note: "Asked about platform migration tradeoffs.",
        occurredAt: "2026-05-06T09:35:00.000Z",
        recordedAt: "2026-05-06T09:36:00.000Z",
        suggestionId: null,
        evidenceId: null,
        interviewPrepGeneration: 2,
      },
    }));

    renderWithProviders(
      <InterviewReflectionForm jobId="job-2" prepGeneration={2} />,
      {
        ports: buildTestPorts({ api: { recordManualApplicationOutcome } }),
      },
    );

    await user.type(
      screen.getByLabelText(/interview date/i),
      "2026-05-06T09:35",
    );
    await user.type(
      screen.getByLabelText(/reflection note/i),
      "Asked about platform migration tradeoffs.",
    );
    await user.click(
      screen.getByRole("button", { name: /record reflection/i }),
    );

    await waitFor(() =>
      expect(recordManualApplicationOutcome).toHaveBeenCalledTimes(1),
    );
    expect(recordManualApplicationOutcome).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({
        kind: "interview",
        interviewPrepGeneration: 2,
        note: "Asked about platform migration tradeoffs.",
        occurredAt: expect.stringMatching(/Z$/),
      }),
    );
  });

  it("accepts and ignores pending outcome suggestions", async () => {
    const user = userEvent.setup();
    const decideOutcomeSuggestion = vi.fn(
      async (_suggestionId: string, body: { decision: string }) => ({
        ok: true as const,
        suggestion: {
          ...sampleApplicationOutcomes.suggestions[0]!,
          status:
            body.decision === "ignore"
              ? ("ignored" as const)
              : ("accepted" as const),
          decidedAt: "2026-05-06T08:40:00Z",
          decisionReason: null,
          decidedOutcomeId:
            body.decision === "ignore" ? null : "outcome-suggestion-1",
        },
        outcome: null,
      }),
    );

    renderWithProviders(
      <OutcomeSuggestionsPanel
        suggestions={sampleApplicationOutcomes.suggestions}
      />,
      {
        ports: buildTestPorts({ api: { decideOutcomeSuggestion } }),
      },
    );

    await user.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() =>
      expect(decideOutcomeSuggestion).toHaveBeenCalledWith(
        "suggestion-1",
        expect.objectContaining({ decision: "accept" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: /ignore/i }));
    await waitFor(() =>
      expect(decideOutcomeSuggestion).toHaveBeenCalledWith(
        "suggestion-1",
        expect.objectContaining({ decision: "ignore" }),
      ),
    );
  });

  it("names repeated suggestion actions with the suggestion and job context", () => {
    renderWithProviders(
      <OutcomeSuggestionsPanel
        suggestions={[
          sampleApplicationOutcomes.suggestions[0]!,
          {
            ...sampleApplicationOutcomes.suggestions[0]!,
            suggestionId: "suggestion-2",
            jobKey: "job-7",
            evidenceId: "evidence-2",
            suggestedKind: "rejection",
            rationale: "Employer reply indicates a rejection.",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /accept suggestion suggestion-1 \(interview\) for job-2/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /ignore suggestion suggestion-2 \(rejection\) for job-7/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", {
        name: /correct suggestion suggestion-2 \(rejection\) for job-7/i,
      }),
    ).toBeInTheDocument();
  });

  it("corrects pending outcome suggestions with a selected outcome kind", async () => {
    const user = userEvent.setup();
    const decideOutcomeSuggestion = vi.fn(async () => ({
      ok: true as const,
      suggestion: {
        ...sampleApplicationOutcomes.suggestions[0]!,
        status: "corrected" as const,
        decidedAt: "2026-05-06T08:40:00Z",
        decisionReason: "Assessment, not interview.",
        decidedOutcomeId: "outcome-suggestion-1",
      },
      outcome: {
        outcomeId: "outcome-suggestion-1",
        jobKey: "job-2",
        kind: "assessment" as const,
        source: "email_suggestion" as const,
        note: null,
        occurredAt: "2026-05-06T08:40:00Z",
        recordedAt: "2026-05-06T08:40:00Z",
        suggestionId: "suggestion-1",
        evidenceId: "evidence-1",
        interviewPrepGeneration: null,
      },
    }));

    renderWithProviders(
      <OutcomeSuggestionsPanel
        suggestions={sampleApplicationOutcomes.suggestions}
      />,
      {
        ports: buildTestPorts({ api: { decideOutcomeSuggestion } }),
      },
    );

    const suggestion = screen
      .getByText("Recruiter reply indicates an interview request.")
      .closest("article");
    expect(suggestion).not.toBeNull();
    const scope = within(suggestion as HTMLElement);
    await user.click(scope.getByRole("combobox", { name: /correct to/i }));
    await user.click(await screen.findByRole("option", { name: "Assessment" }));
    await user.type(
      scope.getByLabelText(/reason/i),
      "Assessment, not interview.",
    );
    await user.click(scope.getByRole("button", { name: /correct/i }));

    await waitFor(() =>
      expect(decideOutcomeSuggestion).toHaveBeenCalledWith(
        "suggestion-1",
        expect.objectContaining({
          decision: "correct",
          outcomeKind: "assessment",
          reason: "Assessment, not interview.",
        }),
      ),
    );
  });
});
