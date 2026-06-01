import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleApplicationOutcomes } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  JobOutcomePanel,
  ManualOutcomeForm,
  OutcomeSuggestionsPanel,
} from "./ApplicationOutcomes.js";

describe("application outcome components", () => {
  it("renders the job outcome timeline and manual outcome form", async () => {
    renderWithProviders(<JobOutcomePanel jobId="job-2" />);

    const timeline = await screen.findByLabelText("Application outcome timeline");
    expect(within(timeline).getByText("Applied confirmation")).toBeInTheDocument();
    expect(screen.getByText("Confirmed in the ATS portal.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record outcome/i })).toBeInTheDocument();
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
      },
    }));

    renderWithProviders(<ManualOutcomeForm jobId="job-2" />, {
      ports: buildTestPorts({ api: { recordManualApplicationOutcome } }),
    });

    await user.selectOptions(screen.getByLabelText(/outcome/i), "interview");
    await user.type(screen.getByLabelText(/occurred at/i), "2026-05-06T08:35");
    await user.type(screen.getByLabelText(/local note/i), "Talked to recruiting.");
    await user.click(screen.getByRole("button", { name: /record outcome/i }));

    await waitFor(() => expect(recordManualApplicationOutcome).toHaveBeenCalledTimes(1));
    expect(recordManualApplicationOutcome).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({
        kind: "interview",
        note: "Talked to recruiting.",
        occurredAt: expect.stringMatching(/Z$/),
      }),
    );
  });

  it("accepts and ignores pending outcome suggestions", async () => {
    const user = userEvent.setup();
    const decideOutcomeSuggestion = vi.fn(async (_suggestionId: string, body: { decision: string }) => ({
      ok: true as const,
      suggestion: {
        ...sampleApplicationOutcomes.suggestions[0]!,
        status: body.decision === "ignore" ? ("ignored" as const) : ("accepted" as const),
        decidedAt: "2026-05-06T08:40:00Z",
        decisionReason: null,
        decidedOutcomeId: body.decision === "ignore" ? null : "outcome-suggestion-1",
      },
      outcome: null,
    }));

    renderWithProviders(
      <OutcomeSuggestionsPanel suggestions={sampleApplicationOutcomes.suggestions} />,
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
      },
    }));

    renderWithProviders(
      <OutcomeSuggestionsPanel suggestions={sampleApplicationOutcomes.suggestions} />,
      {
        ports: buildTestPorts({ api: { decideOutcomeSuggestion } }),
      },
    );

    const suggestion = screen.getByText("Recruiter reply indicates an interview request.").closest("article");
    expect(suggestion).not.toBeNull();
    const scope = within(suggestion as HTMLElement);
    await user.selectOptions(scope.getByLabelText(/correct to/i), "assessment");
    await user.type(scope.getByLabelText(/reason/i), "Assessment, not interview.");
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
