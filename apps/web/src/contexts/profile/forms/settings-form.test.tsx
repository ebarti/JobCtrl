import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import {
  buildScoreCriteriaText,
  buildTargetCriteriaText,
  parseScoringRubric,
  SettingsForm,
} from "./settings-form.js";
import type { SettingsResponse } from "../../operations/types.js";

describe("<SettingsForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("autosaves edited settings after five seconds", async () => {
    vi.useFakeTimers();
    const updateSettings = vi.fn(async (request): Promise<SettingsResponse> => ({
      ok: true,
      settings: { ...sampleSettingsResponse.settings, ...request },
      paths: sampleSettingsResponse.paths,
    }));
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    expect(screen.queryByLabelText("Location filter")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Target role"), {
      target: { value: "Engineering Director" },
    });

    act(() => vi.advanceTimersByTime(4_999));
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ targetRole: "Engineering Director" }),
    );
  });

  it("renders scoring criteria as bounded controls", () => {
    const { container } = renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);

    expect(screen.getByRole("group", { name: "Scoring rubric" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Score criteria")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Targeting criteria")).not.toBeInTheDocument();
    expect(container.querySelector("textarea")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Platform reliability")).toBeChecked();
    expect(screen.getByLabelText("Leadership scope")).toBeChecked();
    expect(screen.getByLabelText("Seniority bar")).toHaveValue("director_plus");
  });

  it("saves selected scoring controls as generated criteria text", async () => {
    const updateSettings = vi.fn(async (request): Promise<SettingsResponse> => ({
      ok: true,
      settings: { ...sampleSettingsResponse.settings, ...request },
      paths: sampleSettingsResponse.paths,
    }));
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    fireEvent.click(screen.getByLabelText("Security and compliance"));
    fireEvent.change(screen.getByLabelText("Company context"), {
      target: { value: "regulated" },
    });
    fireEvent.click(screen.getByLabelText("Exclude sales quota roles"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        scoreCriteria: expect.stringContaining("Prioritize security, privacy, compliance"),
        targetCriteria: expect.stringContaining("Exclude quota-carrying sales"),
      }),
    );
    const request = updateSettings.mock.calls[0]?.[0];
    expect(request?.scoreCriteria).toContain("Favor regulated, high-security");
  });

  it("keeps newer edits when an autosave response returns for an older snapshot", async () => {
    vi.useFakeTimers();
    let resolveUpdate: ((response: SettingsResponse) => void) | undefined;
    const updateSettings = vi.fn(
      (request) =>
        new Promise<SettingsResponse>((resolve) => {
          void request;
          resolveUpdate = resolve;
        }),
    );
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    const targetRole = screen.getByLabelText("Target role");
    fireEvent.change(targetRole, {
      target: { value: "Engineering Director" },
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);

    fireEvent.change(targetRole, {
      target: { value: "VP Engineering" },
    });
    const request = updateSettings.mock.calls[0]?.[0];
    await act(async () => {
      resolveUpdate?.({
        ok: true,
        settings: { ...sampleSettingsResponse.settings, ...request },
        paths: sampleSettingsResponse.paths,
      });
      await Promise.resolve();
    });

    expect(targetRole).toHaveValue("VP Engineering");
    expect(screen.getByText("saved; newer changes pending")).toBeInTheDocument();
  });

  it("does not reset dirty edits when a saved autosave snapshot reaches the initial props", async () => {
    const { rerender } = renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);

    const targetRole = screen.getByLabelText("Target role");
    fireEvent.change(targetRole, {
      target: { value: "VP Engineering" },
    });

    rerender(
      <SettingsForm
        initial={{
          ...sampleSettingsResponse.settings,
          targetRole: "Engineering Director",
        }}
      />,
    );

    expect(targetRole).toHaveValue("VP Engineering");
  });

  it("undos checkbox setting changes with the keyboard shortcut", async () => {
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);

    const autoApply = screen.getByLabelText("Auto apply");
    fireEvent.click(autoApply);
    await waitFor(() => expect(autoApply).toBeChecked());

    fireEvent.keyDown(autoApply, { key: "z", metaKey: true });

    await waitFor(() => expect(autoApply).not.toBeChecked());
  });
});

describe("scoring rubric serialization", () => {
  it("maps legacy criteria text into controlled rubric values", () => {
    const rubric = parseScoringRubric(
      "Prioritize platform reliability, security, and engineering leadership.",
      "Director-plus infrastructure roles.",
    );

    expect(rubric.priorities).toEqual(["leadership_scope", "platform_reliability", "security_compliance"]);
    expect(rubric.seniority).toBe("director_plus");
  });

  it("builds deterministic score and target criteria from selected controls", () => {
    const rubric = parseScoringRubric("", "");
    rubric.company = "startup_scaleup";
    rubric.exclusions = ["junior_roles"];
    rubric.priorities = ["technical_depth", "business_impact"];
    rubric.seniority = "current_or_above";
    rubric.stretch = "conservative";

    expect(buildScoreCriteriaText(rubric)).toContain("Prioritize hands-on technical depth");
    expect(buildScoreCriteriaText(rubric)).toContain("Favor startup or scale-up");
    expect(buildTargetCriteriaText(rubric)).toContain("Exclude junior, entry-level");
  });

  it("round-trips generated criteria without broad alias matches", () => {
    const rubric = parseScoringRubric("", "");
    rubric.company = "regulated";
    rubric.exclusions = ["onsite_only"];
    rubric.priorities = ["security_compliance"];
    rubric.seniority = "executive";

    const generatedRubric = parseScoringRubric(
      buildScoreCriteriaText(rubric),
      buildTargetCriteriaText(rubric),
    );

    expect(generatedRubric).toEqual(rubric);
  });
});
