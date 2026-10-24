import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { sampleProviderModelsResponse, sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

describe("<AiExecutionPolicyPanel>", () => {
  it.each([true, false])("saves extra resume polish %s independently of the model catalog", async (enabled) => {
    const user = userEvent.setup();
    const settings = { ...sampleSettingsResponse, settings: { ...sampleSettingsResponse.settings, defaultLlmModel: "codex:saved-model", resumeVoicePolish: !enabled } };
    const updateSettings = vi.fn(async () => ({ ...settings, settings: { ...settings.settings, resumeVoicePolish: enabled } }));
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: vi.fn(async () => settings),
      providerModels: vi.fn(async () => { throw new Error("Synthetic catalog outage"); }), updateSettings,
    } }) });
    const polish = await screen.findByRole("checkbox", { name: "Extra résumé polish" });
    expect(polish).toHaveAttribute("aria-checked", String(!enabled));
    await user.click(polish);
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ resumeVoicePolish: enabled }));
  });

  it.each([
    [true, true], [false, true], [true, false], [false, false],
  ])("preserves undisplayed generator fallbacks on a polish-only save (%s, catalog ready: %s)", async (enabled, catalogReady) => {
    const user = userEvent.setup();
    const settings = { ...sampleSettingsResponse, settings: {
      ...sampleSettingsResponse.settings,
      resumeVoicePolish: !enabled,
      tailoringGeneratorModels: ["codex:gpt-6.1-sol", "codex:gpt-6-sol", "codex:gpt-5.6-sol"],
    } };
    const updateSettings = vi.fn(async () => ({ ...settings, settings: { ...settings.settings, resumeVoicePolish: enabled } }));
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: vi.fn(async () => settings),
      providerModels: vi.fn(async () => {
        if (!catalogReady) throw new Error("Synthetic catalog outage");
        return sampleProviderModelsResponse;
      }),
      updateSettings,
    } }) });
    await user.click(await screen.findByRole("checkbox", { name: "Extra résumé polish" }));
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ resumeVoicePolish: enabled }));
  });

  it("rolls back extra-polish cache state while keeping the failed-save draft editable", async () => {
    const user = userEvent.setup();
    let rejectSave: (reason: Error) => void = () => undefined;
    const updateSettings = vi.fn(() => new Promise<typeof sampleSettingsResponse>((_resolve, reject) => { rejectSave = reject; }));
    const { queryClient } = renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: vi.fn(async () => sampleSettingsResponse), providerModels: vi.fn(async () => sampleProviderModelsResponse), updateSettings,
    } }) });
    const polish = await screen.findByRole("checkbox", { name: "Extra résumé polish" });
    expect(polish).not.toBeChecked();
    await user.click(polish);
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    const cached = () => queryClient.getQueryCache().getAll().find(query => (query.state.data as typeof sampleSettingsResponse | undefined)?.settings)?.state.data as typeof sampleSettingsResponse;
    await waitFor(() => expect(cached().settings.resumeVoicePolish).toBe(true));
    await act(async () => rejectSave(new Error("Synthetic save failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI execution policy could not be saved");
    expect(cached().settings.resumeVoicePolish).toBe(false);
    expect(cached().effectiveSettings.resumeVoicePolish.source).toBe("default");
    expect(polish).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(polish).not.toBeChecked();
  });


  it.each([true, false])("saves cover-letter generation %s independently of the model catalog", async (enabled) => {
    const user = userEvent.setup();
    const settings = { ...sampleSettingsResponse, settings: { ...sampleSettingsResponse.settings, defaultLlmModel: "codex:saved-model", coverLetterGeneration: !enabled } };
    const updateSettings = vi.fn(async () => ({ ...settings, settings: { ...settings.settings, coverLetterGeneration: enabled } }));
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: vi.fn(async () => settings),
      providerModels: vi.fn(async () => { throw new Error("Synthetic catalog outage"); }), updateSettings,
    } }) });
    const polish = await screen.findByRole("checkbox", { name: "Generate cover letters" });
    expect(polish).toHaveAttribute("aria-checked", String(!enabled));
    await user.click(polish);
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ coverLetterGeneration: enabled }));
  });

  it.each([
    [true, true], [false, true], [true, false], [false, false],
  ])("preserves undisplayed generator fallbacks on a cover-letter-only save (%s, catalog ready: %s)", async (enabled, catalogReady) => {
    const user = userEvent.setup();
    const settings = { ...sampleSettingsResponse, settings: {
      ...sampleSettingsResponse.settings,
      coverLetterGeneration: !enabled,
      tailoringGeneratorModels: ["codex:gpt-6.1-sol", "codex:gpt-6-sol", "codex:gpt-5.6-sol"],
    } };
    const updateSettings = vi.fn(async () => ({ ...settings, settings: { ...settings.settings, coverLetterGeneration: enabled } }));
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: vi.fn(async () => settings),
      providerModels: vi.fn(async () => {
        if (!catalogReady) throw new Error("Synthetic catalog outage");
        return sampleProviderModelsResponse;
      }),
      updateSettings,
    } }) });
    await user.click(await screen.findByRole("checkbox", { name: "Generate cover letters" }));
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ coverLetterGeneration: enabled }));
  });

  it("rolls back cover-letter cache state while keeping the failed-save draft editable", async () => {
    const user = userEvent.setup();
    let rejectSave: (reason: Error) => void = () => undefined;
    const updateSettings = vi.fn(() => new Promise<typeof sampleSettingsResponse>((_resolve, reject) => { rejectSave = reject; }));
    const { queryClient } = renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: vi.fn(async () => sampleSettingsResponse), providerModels: vi.fn(async () => sampleProviderModelsResponse), updateSettings,
    } }) });
    const polish = await screen.findByRole("checkbox", { name: "Generate cover letters" });
    expect(polish).not.toBeChecked();
    await user.click(polish);
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    const cached = () => queryClient.getQueryCache().getAll().find(query => (query.state.data as typeof sampleSettingsResponse | undefined)?.settings)?.state.data as typeof sampleSettingsResponse;
    await waitFor(() => expect(cached().settings.coverLetterGeneration).toBe(true));
    await act(async () => rejectSave(new Error("Synthetic save failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI execution policy could not be saved");
    expect(cached().settings.coverLetterGeneration).toBe(false);
    expect(cached().effectiveSettings.coverLetterGeneration.source).toBe("default");
    expect(polish).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(polish).not.toBeChecked();
  });


  it("offers only model-reported effort options and saves the model-specific choice", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async () => sampleSettingsResponse);
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: { settings: vi.fn(async () => sampleSettingsResponse), providerModels: vi.fn(async () => sampleProviderModelsResponse), updateSettings } }) });
    const effort = await screen.findByRole("combobox", { name: "Reasoning effort · GPT-5.5" });
    expect(effort).toHaveTextContent("Existing call settings");
    await user.click(effort);
    expect(await screen.findByRole("option", { name: "Max" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Ultra" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Max" }));
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ codexReasoningEfforts: { "gpt-5.5": "max" } })));
  });

  it("shows unlisted saved efforts as status and never as options", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: { settings: vi.fn(async () => ({ ...sampleSettingsResponse, settings: { ...sampleSettingsResponse.settings, codexReasoningEfforts: { "gpt-5.5": "retired-effort" } } })), providerModels: vi.fn(async () => sampleProviderModelsResponse) } }) });
    const effort = await screen.findByRole("combobox", { name: "Reasoning effort · GPT-5.5" });
    expect(effort).toHaveTextContent("Select a currently supported effort");
    expect(screen.getByText(/Saved effort retired-effort is not in the current provider catalog/)).toBeInTheDocument();
    await user.click(effort);
    await screen.findAllByRole("option");
    expect(screen.queryByRole("option", { name: /retired-effort/ })).not.toBeInTheDocument();
  });

  it("rolls back the saved effort after a failed save while retaining the editable draft", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: { settings: vi.fn(async () => sampleSettingsResponse), providerModels: vi.fn(async () => sampleProviderModelsResponse), updateSettings: vi.fn(async () => { throw new Error("Synthetic save failure"); }) } }) });
    const effort = await screen.findByRole("combobox", { name: "Reasoning effort · GPT-5.5" });
    await user.click(effort);
    await user.click(await screen.findByRole("option", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI execution policy could not be saved");
    expect(effort).toHaveTextContent("High");
    const settings = queryClient.getQueryCache().getAll().find(query => (query.state.data as typeof sampleSettingsResponse | undefined)?.settings)?.state.data as typeof sampleSettingsResponse;
    expect(settings.settings.codexReasoningEfforts).toEqual({});
  });

  it("only offers current provider models and updates choices after catalog refresh", async () => {
    const user = userEvent.setup();
    let models = sampleProviderModelsResponse;
    const catalog = vi.fn(async () => models);
    const { queryClient } = renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      providerModels: catalog,
      settings: vi.fn(async () => ({ ...sampleSettingsResponse, settings: { ...sampleSettingsResponse.settings, tailoringJudgeModel: "codex:retired-model" } })),
    } }) });
    const judge = await screen.findByRole("combobox", { name: "Tailoring judge" });
    expect(judge).toHaveTextContent("Select a currently offered model");
    expect(screen.getByText(/Saved choice codex:retired-model is not in the current provider catalog/)).toBeInTheDocument();
    await user.click(judge);
    await screen.findAllByRole("option");
    expect(screen.queryByRole("option", { name: /retired-model/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    models = { ...sampleProviderModelsResponse, providers: sampleProviderModelsResponse.providers.map(provider => provider.provider === "codex" ? { ...provider, models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }] } : provider) };
    await act(async () => { await queryClient.invalidateQueries(); });
    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
    await user.click(judge);
    expect(await screen.findByRole("option", { name: "Codex — GPT-6.1-Sol" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Codex — GPT-5.5" })).not.toBeInTheDocument();
  });

  it("saves the selected default model through the settings mutation", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async () => sampleSettingsResponse);
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      providerModels: vi.fn(async () => sampleProviderModelsResponse), settings: vi.fn(async () => sampleSettingsResponse), updateSettings,
    } }) });
    await user.click(await screen.findByRole("combobox", { name: "Default model" }));
    await user.click(await screen.findByRole("option", { name: "Codex — GPT-5.5" }));
    await user.click(screen.getByRole("button", { name: "Save AI policy" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultLlmModel: "codex:gpt-5.5" })));
  });

  it("does not expose the internal materials context as card metadata", async () => {
    renderWithProviders(<AiExecutionPolicyPanel />);
    expect(screen.queryByText("materials", { selector: ".meta" })).not.toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Employer analysis perspectives" })).toBeInTheDocument();
    expect(screen.queryByText("materials", { selector: ".meta" })).not.toBeInTheDocument();
  });

  it("uses product provider names and catalog-backed model choices", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiExecutionPolicyPanel />);
    expect(await screen.findByRole("group", { name: "Employer analysis perspectives" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Google" })).toBeChecked();
    expect(screen.queryByText(/Antigravity/i)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Primary tailoring generator"));
    expect((await screen.findAllByRole("option")).some((option) => option.textContent?.includes("Claude"))).toBe(true);
  });

  it("uses the shared field, checkbox, input, and button primitives", async () => {
    renderWithProviders(<AiExecutionPolicyPanel />);

    await screen.findByRole("group", { name: "Employer analysis perspectives" });

    expect(screen.getByRole("checkbox", { name: "Claude" })).toHaveAttribute("data-slot", "checkbox");
    expect(screen.getByRole("button", { name: "Save AI policy" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.getByRole("button", { name: "Save AI policy" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Google" }));
    expect(screen.getByRole("button", { name: "Save AI policy" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });
});
