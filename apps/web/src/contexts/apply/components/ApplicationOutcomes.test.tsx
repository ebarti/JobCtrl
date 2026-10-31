import { act } from "react";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import type { JobApplicationOutcomeListResponse, ManualApplicationOutcomeRequest } from "@jobctrl/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { JobCtrlApiError } from "@jobctrl/api-client";
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
  it("keeps one offer panel and the unsaved manual form while refreshed outcomes reconcile", async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<JobOutcomePanel jobId="job-2" />);
    const note = await screen.findByLabelText("Local note", { selector: "#manual-outcome-note" });
    await user.type(note, "Unsaved synthetic observation");
    const key = outcomesKeys.detail(LOCAL_TENANT, "job-2");
    const current = view.queryClient.getQueryData<JobApplicationOutcomeListResponse>(key)!;
    for (let index = 0; index < 2; index += 1) {
      await act(async () => { view.queryClient.setQueryData(key, { ...current, outcomes: [...current.outcomes, { ...current.outcomes[0]!, outcomeId: `refresh-${index}` }] }); });
      expect(screen.getAllByRole("region", { name: "Offer terms and decisions" })).toHaveLength(1);
      expect(screen.getAllByLabelText("Local note", { selector: "#manual-outcome-note" })).toHaveLength(1);
      expect(screen.getByLabelText("Local note", { selector: "#manual-outcome-note" })).toBe(note);
      expect(note).toHaveValue("Unsaved synthetic observation");
    }
  });

  it.each(["manual", "reflection"] as const)("keeps %s identity and frozen input through uncertain retry/conflict, and rotates for explicit and acknowledged new actions", async (family) => {
    const user = userEvent.setup();
    const recordManualApplicationOutcome = vi.fn(async (jobId: string, body: ManualApplicationOutcomeRequest) => {
      if (recordManualApplicationOutcome.mock.calls.length <= 2) throw new Error("Original action may have committed; retry or start a new action.");
      return { ok: true as const, outcome: { ...sampleApplicationOutcomes.outcomes[0]!, jobKey: jobId, outcomeId: body.requestId, note: body.note ?? null } };
    });
    renderWithProviders(family === "manual" ? <ManualOutcomeForm jobId="job-2" /> : <InterviewReflectionForm jobId="job-2" prepGeneration={2} />, {
      ports: buildTestPorts({ api: { recordManualApplicationOutcome } }),
    });
    const note = screen.getByLabelText(family === "manual" ? "Local note" : "Reflection note");
    const submit = screen.getByRole("button", { name: family === "manual" ? "Record outcome" : "Record reflection" });
    await user.type(note, "Private synthetic attempted input");
    await user.click(submit);
    await screen.findByRole("alert");
    expect(note).toHaveValue("Private synthetic attempted input");
    expect(note).toBeDisabled();
    const original = recordManualApplicationOutcome.mock.calls[0]![1];
    expect(original.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(original.occurredAt).toBeUndefined();
    await user.click(submit);
    await waitFor(() => expect(recordManualApplicationOutcome).toHaveBeenCalledTimes(2));
    expect(recordManualApplicationOutcome.mock.calls[1]![1]).toEqual(original);
    expect(note).toHaveValue("Private synthetic attempted input");
    await user.click(screen.getByRole("button", { name: "Start a new action" }));
    expect(note).toBeEnabled();
    await user.type(note, " deliberately new");
    await user.click(submit);
    await waitFor(() => expect(recordManualApplicationOutcome).toHaveBeenCalledTimes(3));
    expect(recordManualApplicationOutcome.mock.calls[2]![1].requestId).not.toBe(original.requestId);
    await waitFor(() => expect(note).toHaveValue(""));
    await user.click(submit);
    await waitFor(() => expect(recordManualApplicationOutcome).toHaveBeenCalledTimes(4));
    expect(recordManualApplicationOutcome.mock.calls[3]![1].requestId).not.toBe(recordManualApplicationOutcome.mock.calls[2]![1].requestId);
  });

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
    const submitButton = screen.getByRole("button", {
      name: /record outcome/i,
    });
    expect(submitButton).toHaveAttribute("data-slot", "button");
    const manualForm = submitButton.closest("form");
    expect(manualForm).not.toBeNull();
    expect(manualForm?.querySelectorAll('[data-slot="field"]')).toHaveLength(3);
    expect(
      manualForm?.querySelectorAll('input[data-slot="input"]'),
    ).toHaveLength(1);
    expect(
      manualForm?.querySelectorAll('textarea[data-slot="textarea"]'),
    ).toHaveLength(1);
  });

  it("uses shared primitives for visible reflection fields and keeps named metadata hidden", () => {
    const { container } = renderWithProviders(
      <InterviewReflectionForm jobId="job-2" prepGeneration={2} />,
    );

    expect(container.querySelectorAll('[data-slot="field"]')).toHaveLength(2);
    expect(container.querySelectorAll('input[data-slot="input"]')).toHaveLength(
      1,
    );
    expect(
      container.querySelectorAll('textarea[data-slot="textarea"]'),
    ).toHaveLength(1);
    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(2);
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
    expect(
      await screen.findByText("Outcome recorded"),
    ).toHaveAttribute("role", "status");
    expect(await screen.findByText("Outcome recorded")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("announces manual outcome save failures assertively", async () => {
    const user = userEvent.setup();
    const recordManualApplicationOutcome = vi.fn(async () => {
      throw new Error("Save failed");
    });

    renderWithProviders(<ManualOutcomeForm jobId="job-2" />, {
      ports: buildTestPorts({ api: { recordManualApplicationOutcome } }),
    });

    await user.type(screen.getByLabelText(/occurred at/i), "2026-05-06T08:35");
    await user.click(screen.getByRole("button", { name: /record outcome/i }));

    expect(
      await screen.findByText("Save failed"),
    ).toHaveAttribute("role", "alert");
    expect(await screen.findByText("Save failed")).toHaveAttribute(
      "aria-live",
      "assertive",
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
    expect(
      await screen.findByText("Reflection recorded"),
    ).toHaveAttribute("role", "status");
    expect(await screen.findByText("Reflection recorded")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("accepts and ignores pending outcome suggestions", async () => {
    const user = userEvent.setup();
    const decideOutcomeSuggestion = vi.fn(
      async (_suggestionId: string, body: { decision: string }) => ({
        ok: true as const,
        disposition: "applied" as const,
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

    expect(screen.getAllByText("Pending")[0]).toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(screen.getAllByText("Pending")[0]).toHaveAttribute(
      "data-status-tone",
      "info",
    );

    await user.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() =>
      expect(decideOutcomeSuggestion).toHaveBeenCalledWith(
        "suggestion-1",
        expect.objectContaining({ decision: "accept" }),
      ),
    );
    expect(
      await screen.findByText("Suggestion accepted"),
    ).toHaveAttribute("role", "status");
    expect(await screen.findByText("Suggestion accepted")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await user.click(screen.getByRole("button", { name: /ignore/i }));
    await waitFor(() =>
      expect(decideOutcomeSuggestion).toHaveBeenCalledWith(
        "suggestion-1",
        expect.objectContaining({ decision: "ignore" }),
      ),
    );
    expect(
      await screen.findByText("Suggestion ignored"),
    ).toHaveAttribute("role", "status");
    expect(await screen.findByText("Suggestion ignored")).toHaveAttribute(
      "aria-live",
      "polite",
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
            determination: null, citations: [],
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

  it("retains a correction across refresh and shows the saved decision on conflict", async () => {
    const user = userEvent.setup();
    let rejectDecision!: (error: Error) => void;
    const decideOutcomeSuggestion = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectDecision = reject; }));
    const { rerender } = renderWithProviders(
      <OutcomeSuggestionsPanel suggestions={sampleApplicationOutcomes.suggestions} />,
      { ports: buildTestPorts({ api: { decideOutcomeSuggestion } }) },
    );
    const reason = screen.getByLabelText(/reason/i);
    const note = screen.getByLabelText(/local note/i);
    await user.type(reason, "Attempted correction");
    await user.type(note, "Keep this draft");
    await user.click(screen.getByRole("button", { name: /^correct suggestion/i }));
    await waitFor(() => expect(decideOutcomeSuggestion).toHaveBeenCalledTimes(1));
    rerender(<OutcomeSuggestionsPanel suggestions={[]} />);
    expect(screen.getByLabelText(/local note/i)).toHaveValue("Keep this draft");
    const saved = {
      ...sampleApplicationOutcomes.suggestions[0]!, status: "corrected", decisionReason: "Earlier reason",
      decidedAt: "2026-05-06T08:40:00Z", decidedOutcomeId: "outcome-1",
    };
    const outcome = { outcomeId: "outcome-1", jobKey: saved.jobKey, kind: "offer", source: "email_suggestion",
      note: "Earlier saved note", occurredAt: "2026-05-06T08:40:00Z", recordedAt: "2026-05-06T08:40:00Z",
      suggestionId: saved.suggestionId, evidenceId: saved.evidenceId, interviewPrepGeneration: null };
    await act(async () => rejectDecision(new JobCtrlApiError(409, "Conflict", undefined, {
      ok: false, error: "outcome_suggestion_conflict", suggestion: saved, outcome,
    })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your requested decision was not applied");
    expect(screen.getByRole("alert")).toHaveTextContent("Requested decision: correct");
    expect(screen.getByRole("alert")).toHaveTextContent("Saved decision: corrected · Offer");
    expect(screen.getByRole("alert")).toHaveTextContent("Earlier saved note");
    expect(screen.getByLabelText(/reason/i)).toHaveValue("Attempted correction");
    expect(screen.getByLabelText(/local note/i)).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: /^correct suggestion/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText("No pending outcome suggestions.")).toBeInTheDocument();
    expect(decideOutcomeSuggestion).toHaveBeenCalledTimes(1);
  });

  it("corrects pending outcome suggestions with a selected outcome kind", async () => {
    const user = userEvent.setup();
    const decideOutcomeSuggestion = vi.fn(async () => ({
      ok: true as const,
      disposition: "applied" as const,
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
    expect(
      await screen.findByText("Suggestion corrected"),
    ).toHaveAttribute("role", "status");
    expect(await screen.findByText("Suggestion corrected")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});
