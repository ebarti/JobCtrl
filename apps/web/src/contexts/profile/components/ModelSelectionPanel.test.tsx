import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { FeatureFlagPort } from "../../../shared/ports/index.js";
import {
  sampleProviderModelsResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ModelSelectionPanel } from "./ModelSelectionPanel.js";

async function providerCard(name: "Claude" | "Codex" | "Google") {
  const heading = await screen.findByRole("heading", { name });
  const card = heading.closest("article");
  if (!card) throw new Error(`${name} provider card was not rendered`);
  const queries = within(card);
  const trigger = queries.getByRole("button", { name: new RegExp(`^${name}\\b`, "i") });
  if (trigger.getAttribute("aria-expanded") === "false") {
    await userEvent.setup().click(trigger);
  }
  return queries;
}

class DemoFeatureFlags implements FeatureFlagPort {
  get<T extends boolean | number | string>(key: string, defaultValue: T): T {
    return (key === "demoMode" ? true : defaultValue) as T;
  }
}

describe("<ModelSelectionPanel>", () => {
  it("renders the three-provider catalog and requires configuration before selection", async () => {
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Model selection" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    await screen.findByText("Configuration required");
    expect(screen.getByRole("heading", { name: "Google" }).closest("article")).toHaveAttribute("data-model-state", "unconfigured");
    const claude = await providerCard("Claude");
    const codex = await providerCard("Codex");
    const google = await providerCard("Google");
    expect(claude.getByText(/live provider availability/i)).toBeInTheDocument();
    expect(codex.getByText(/live provider availability/i)).toBeInTheDocument();
    expect(claude.getByText("Ready to select")).toHaveAttribute("data-slot", "status-badge");
    expect(google.getByRole("link", { name: "Configure Google" })).toHaveAttribute(
      "href",
      "/settings/credentials",
    );
    expect(google.queryByRole("combobox", { name: /Preferred model/ })).not.toBeInTheDocument();
  });

  it("saves one ready provider without changing provider priority", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async () => ({
        ...sampleSettingsResponse,
        settings: {
          ...sampleSettingsResponse.settings,
          preferredModels: { claude: "claude-opus-4-8" },
        },
      }));
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
          updateSettings,
        },
      }),
    });

    const claude = await providerCard("Claude");
    const select = await claude.findByRole("combobox", { name: /Preferred model/ });
    expect(select).toHaveTextContent("Sonnet 5");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /Opus 4\.8/ }));
    await user.click(claude.getByRole("button", { name: "Save model" }));

    expect(updateSettings).toHaveBeenCalledWith({ preferredModels: { claude: "claude-opus-4-8" } });
    expect(await claude.findByRole("status")).toHaveTextContent(
      "Claude preference saved for newly started work.",
    );
  });

  it("initializes the draft when an uncached saved preference arrives asynchronously", async () => {
    let resolveSettings!: (value: typeof sampleSettingsResponse) => void;
    const settings = vi.fn(
      () => new Promise<typeof sampleSettingsResponse>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings,
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
        },
      }),
    });

    const claude = await providerCard("Claude");
    const select = await claude.findByRole("combobox", { name: /Preferred model/ });
    expect(select).toHaveTextContent("Provider default");
    await act(async () => resolveSettings(sampleSettingsResponse));
    await waitFor(() => expect(select).toHaveTextContent("Sonnet 5"));
  });

  it("clears a saved choice back to the provider default", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async () => ({
      ...sampleSettingsResponse,
      settings: { ...sampleSettingsResponse.settings, preferredModels: {} },
    }));
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
          updateSettings,
        },
      }),
    });

    const claude = await providerCard("Claude");
    await user.click(await claude.findByRole("combobox", { name: /Preferred model/ }));
    await user.click(await screen.findByRole("option", { name: "Provider default" }));
    await user.click(claude.getByRole("button", { name: "Save model" }));

    expect(updateSettings).toHaveBeenCalledWith({ preferredModels: { claude: null } });
  });

  it("clears a saved preference even when that provider is no longer ready", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async () => ({
      ...sampleSettingsResponse,
      settings: { ...sampleSettingsResponse.settings, preferredModels: {} },
    }));
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => ({
            ...sampleSettingsResponse,
            settings: {
              ...sampleSettingsResponse.settings,
              preferredModels: { google: "gemini-retired" },
            },
          })),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
          updateSettings,
        },
      }),
    });

    const google = await providerCard("Google");
    await user.click(await google.findByRole("button", { name: "Clear saved model" }));
    expect(updateSettings).toHaveBeenCalledWith({ preferredModels: { google: null } });
  });

  it("clears a saved preference while the catalog endpoint is unavailable", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async () => ({
      ...sampleSettingsResponse,
      settings: { ...sampleSettingsResponse.settings, preferredModels: {} },
    }));
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn().mockRejectedValue(new Error("catalog unavailable")),
          updateSettings,
        },
      }),
    });

    const claude = await providerCard("Claude");
    await user.click(await claude.findByRole("button", { name: "Clear saved model" }));
    expect(updateSettings).toHaveBeenCalledWith({ preferredModels: { claude: null } });
  });

  it("keeps the synthetic demo catalog visibly read-only", async () => {
    const updateSettings = vi.fn();
    const ports = {
      ...buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
          updateSettings,
        },
      }),
      featureFlags: new DemoFeatureFlags(),
    };
    renderWithProviders(<ModelSelectionPanel />, { withRouter: true, ports });

    expect(await screen.findByText(/synthetic model catalog for preview only/i)).toBeInTheDocument();
    const claude = await providerCard("Claude");
    expect(claude.getByRole("combobox", { name: /Preferred model/ })).toBeDisabled();
    expect(claude.getByRole("button", { name: "Save model" })).toBeDisabled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps a stale saved model visible until the user chooses a current option", async () => {
    renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => ({
            ...sampleSettingsResponse,
            settings: {
              ...sampleSettingsResponse.settings,
              preferredModels: { codex: "retired-codex-model" },
            },
          })),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
        },
      }),
    });

    const codex = await providerCard("Codex");
    const select = await codex.findByRole("combobox", { name: /Preferred model/ });
    expect(select).toHaveTextContent("retired-codex-model (no longer available)");
    await userEvent.setup().click(select);
    expect(await screen.findByRole("option", {
      name: "retired-codex-model (no longer available)",
    })).toHaveAttribute("aria-disabled", "true");
  });
});
