import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import type { FeatureFlagPort } from "../../../shared/ports/index.js";

import {
  sampleCredentialsResponse,
  sampleProviderStatusResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  CODEX_LOGIN_COMMANDS,
  removeClaudeProviderBatch,
  removeGoogleProviderBatch,
} from "../lib/provider-credential-plans.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

describe("<CredentialsPanel>", () => {
  it("renders three guided provider disclosures and no raw Codex secret field", async () => {
    renderPanel();

    const codex = await providerCard("Codex");
    const solver = await providerCard("Apply CAPTCHA solver");
    expect(within(codex).getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Google" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Apply CAPTCHA solver" })).toBeInTheDocument();
    expect(within(solver).getByLabelText("CapSolver API key")).toBeEnabled();
    expect(within(codex).getByText(CODEX_LOGIN_COMMANDS.subscription)).toBeInTheDocument();
    expect(within(codex).getByText(CODEX_LOGIN_COMMANDS.apiKey)).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI API key/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Restart JobCtrl after a change/i)).toBeInTheDocument();
  });

  it("keeps provider status and ownership visible in each collapsed summary", async () => {
    renderPanel();

    const heading = await screen.findByRole("heading", { name: "Claude" });
    const disclosure = heading.closest("section");
    if (!disclosure) throw new Error("Missing Claude provider disclosure");
    const trigger = within(disclosure).getByRole("button", { name: /Claude/i });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent(/Ready|Configured|Not configured/i);
    expect(trigger).toHaveTextContent(/Ownership:/i);
  });

  it("exposes provider privacy boundaries through the final disclosure ledger", async () => {
    const user = userEvent.setup();
    renderPanel();

    const privacy = await screen.findByRole("region", { name: "Credential privacy" });
    await user.click(within(privacy).getByRole("button", {
      name: /Your provider data stays private/i,
    }));

    expect(within(privacy).getByText("Local only")).toBeInTheDocument();
    expect(within(privacy).getByText("Claude and Google storage")).toBeInTheDocument();
    expect(within(privacy).getByText("Codex authentication")).toBeInTheDocument();
    expect(within(privacy).getByText("API and persistence")).toBeInTheDocument();
    expect(within(privacy).getByText("URLs, logs, traces, and artifacts")).toBeInTheDocument();
    expect(within(privacy).getByText("Worker restart required")).toBeInTheDocument();
  });

  it.each([
    ["Anthropic API key", /Anthropic API key \(required\)/i],
    ["Google Cloud Agent Platform", /Google Cloud project ID/i],
    ["Amazon Bedrock", /AWS profile \(optional\)/i],
    ["Claude Platform on AWS", /Workspace ID/i],
    ["Microsoft Foundry", /Microsoft Foundry resource name/i],
  ])("shows the %s Claude route fields", async (choice, expectedField) => {
    const user = userEvent.setup();
    renderPanel();
    const card = await providerCard("Claude");

    await selectProviderMode(user, card, "Choose how Claude authenticates", choice);

    expect(within(card).getByLabelText(expectedField)).toBeInTheDocument();
  });

  it.each([
    ["Gemini API key", /Gemini API key \(required\)/i],
    ["Vertex AI", /Google Cloud project ID/i],
  ])("shows the %s Google route fields", async (choice, expectedField) => {
    const user = userEvent.setup();
    renderPanel();
    const card = await providerCard("Google");

    await selectProviderMode(user, card, "Choose how Google authenticates", choice);

    expect(within(card).getByLabelText(expectedField)).toBeInTheDocument();
  });

  it("preselects sanitized provider modes without filling secret values", async () => {
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        credentials: sampleCredentialsResponse.credentials.map((credential) => ({
          ...credential,
          configured: false,
          effectiveSource: "absent" as const,
        })),
      })),
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          { provider: "claude" as const, configured: true, ready: true, mode: "bedrock" },
          { provider: "google" as const, configured: true, ready: true, mode: "vertex" },
        ],
      })),
    });

    const claude = await providerCard("Claude");
    const google = await providerCard("Google");
    await waitFor(() => expect(
      within(claude).getByRole("combobox", { name: /Choose how Claude authenticates/i }),
    ).toHaveTextContent("Amazon Bedrock"));
    expect(
      within(google).getByRole("combobox", { name: /Choose how Google authenticates/i }),
    ).toHaveTextContent("Vertex AI");
    expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
  });

  it("prefers exactly one fresh Keychain mode over stale live status until restart", async () => {
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        credentials: sampleCredentialsResponse.credentials.map((credential) => ({
          ...credential,
          configured: [
            "CLAUDE_CODE_USE_VERTEX",
            "GOOGLE_GENAI_USE_VERTEXAI",
          ].includes(credential.key),
          effectiveSource: [
            "CLAUDE_CODE_USE_VERTEX",
            "GOOGLE_GENAI_USE_VERTEXAI",
          ].includes(credential.key) ? "keychain" as const : "absent" as const,
        })),
      })),
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          { provider: "claude" as const, configured: false, ready: false, mode: "api_key" },
          { provider: "google" as const, configured: false, ready: false, mode: "gemini_api_key" },
        ],
      })),
    });

    const claude = await providerCard("Claude");
    const google = await providerCard("Google");
    await waitFor(() =>
      expect(
        within(claude).getByRole("combobox", { name: /Choose how Claude authenticates/i }),
      ).toHaveTextContent("Google Cloud Agent Platform"),
    );
    expect(
      within(google).getByRole("combobox", { name: /Choose how Google authenticates/i }),
    ).toHaveTextContent("Vertex AI");
    expect(within(claude).getAllByText("Configured · restart or verify").length).toBeGreaterThan(0);
    expect(within(google).getAllByText("Configured · restart or verify").length).toBeGreaterThan(0);
    expect(within(claude).queryByText("Ready")).not.toBeInTheDocument();
    expect(within(google).queryByText("Ready")).not.toBeInTheDocument();
  });

  it("allows a pasted API key to be revealed and hidden", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = await providerCard("Claude");
    const input = within(card).getByLabelText(/Anthropic API key \(required\)/i);

    await user.type(input, "sk-ant-test");
    expect(input).toHaveAttribute("type", "password");
    const visibility = within(card).getByRole("checkbox", { name: /Show anthropic api key/i });
    await user.click(visibility);
    expect(input).toHaveAttribute("type", "text");
    await user.click(visibility);
    expect(input).toHaveAttribute("type", "password");
  });

  it("announces Codex verification success and failure without account details", async () => {
    const user = userEvent.setup();
    const verifyCodexProvider = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        verification: {
          provider: "codex",
          ok: true,
          status: "connected",
          message: "Codex CLI authentication is ready.",
        },
      })
      .mockRejectedValueOnce(new Error("private-token-must-not-render"));
    renderPanel({ verifyCodexProvider });
    const card = await providerCard("Codex");
    const button = within(card).getByRole("button", { name: "Reuse existing login or verify" });

    await user.click(button);
    expect(await within(card).findByText("Codex CLI authentication is ready.")).toBeInTheDocument();
    await user.click(button);
    expect(await within(card).findByText(/verification could not be completed/i)).toBeInTheDocument();
    expect(card).not.toHaveTextContent("private-token-must-not-render");
  });

  it("confirms and removes every managed Claude setting with restart guidance", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderPanel({
      credentials: vi.fn(async () => configuredProvidersResponse()),
      updateCredentialsBatch,
    });
    const card = await providerCard("Claude");

    const removeTrigger = within(card).getByRole("button", { name: "Remove Claude setup" });
    await user.click(removeTrigger);
    const dialog = screen.getByRole("dialog", { name: "Remove Claude provider setup?" });
    expect(within(dialog).getByText(/External vendor CLI and cloud credentials are unchanged/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(updateCredentialsBatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Remove Claude provider setup?" })).not.toBeInTheDocument();
    expect(removeTrigger).toHaveFocus();

    await user.click(within(card).getByRole("button", { name: "Remove Claude setup" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Remove Claude provider setup?" })).getByRole(
        "button",
        { name: "Remove Claude setup" },
      ),
    );

    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledWith(removeClaudeProviderBatch()));
    expect(await within(card).findByText(/Claude provider settings removed\. Restart JobCtrl/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Remove Claude provider setup?" })).not.toBeInTheDocument();
  });

  it("keeps an environment-owned provider visibly read-only and never reports removal", async () => {
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        credentials: sampleCredentialsResponse.credentials.map((credential) =>
          credential.key === "GOOGLE_GENAI_USE_VERTEXAI"
            ? {
                ...credential,
                configured: false,
                effectiveSource: "environment" as const,
                editable: false,
              }
            : credential,
        ),
      })),
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          { provider: "google" as const, configured: true, ready: true, mode: "vertex" },
        ],
      })),
      updateCredentialsBatch,
    });

    const card = await providerCard("Google");
    expect(within(card).getByText(/effective mode is owned by the launch environment/i)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Save Google setup" })).toBeDisabled();
    expect(within(card).queryByRole("button", { name: "Remove Google setup" })).not.toBeInTheDocument();
    expect(
      within(card).getByRole("combobox", { name: /Choose how Google authenticates/i }),
    ).toBeDisabled();
    expect(updateCredentialsBatch).not.toHaveBeenCalled();
    expect(card).not.toHaveTextContent(/provider settings removed/i);
  });

  it("keeps an environment-owned CapSolver key visibly read-only", async () => {
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        credentials: sampleCredentialsResponse.credentials.map((credential) =>
          credential.key === "CAPSOLVER_API_KEY"
            ? {
                ...credential,
                configured: true,
                effectiveSource: "environment" as const,
                editable: false,
              }
            : credential,
        ),
      })),
    });

    const panel = await providerCard("Apply CAPTCHA solver");
    expect(within(panel).getByLabelText("CapSolver API key")).toBeDisabled();
    expect(within(panel).getByText(/managed by environment/i)).toBeInTheDocument();
  });

  it("keeps a sanitized Google removal error inside the confirmation dialog", async () => {
    const user = userEvent.setup();
    const privateFailure = "private-keychain-detail-must-not-render";
    let rejectRemoval!: (reason: unknown) => void;
    const updateCredentialsBatch = vi.fn(
      () => new Promise<never>((_resolve, reject) => {
        rejectRemoval = reject;
      }),
    );
    renderPanel({
      credentials: vi.fn(async () => configuredProvidersResponse()),
      updateCredentialsBatch,
    });
    const card = await providerCard("Google");

    await user.click(within(card).getByRole("button", { name: "Remove Google setup" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Google provider setup?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove Google setup" }));
    expect(within(dialog).getByRole("button", { name: "Removing Google setup…" })).toBeDisabled();
    rejectRemoval(new Error(privateFailure));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not remove Google provider settings. No successful removal was confirmed.",
    );
    expect(dialog).not.toHaveTextContent(privateFailure);
    expect(updateCredentialsBatch).toHaveBeenCalledWith(removeGoogleProviderBatch());
  });

  it("keeps non-secret cloud setup editable when secure secret storage is unsupported", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        store: {
          ...sampleCredentialsResponse.store,
          available: false,
          unavailableReason: "unsupported_platform" as const,
        },
        credentials: sampleCredentialsResponse.credentials.map((credential) =>
          credential.storage === "keychain"
            ? {
                ...credential,
                configured: null,
                effectiveSource: "inspection_unknown" as const,
                editable: false,
              }
            : credential,
        ),
      })),
      providerStatus: vi.fn(async () => ({ ok: true as const, providers: [] })),
      updateCredentialsBatch,
    });

    expect(await screen.findByText(/Non-secret provider settings remain editable in config\.json/i)).toBeInTheDocument();
    const claude = await providerCard("Claude");
    const google = await providerCard("Google");
    const claudeMode = within(claude).getByRole("combobox", {
      name: /Choose how Claude authenticates/i,
    });
    await user.click(claudeMode);
    expect(screen.getByRole("option", { name: /Anthropic API key/i })).toHaveAttribute("data-disabled");
    await user.keyboard("{Escape}");
    const googleMode = within(google).getByRole("combobox", {
      name: /Choose how Google authenticates/i,
    });
    await user.click(googleMode);
    expect(screen.getByRole("option", { name: /Gemini API key/i })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("option", { name: /Vertex AI/i })).not.toHaveAttribute("data-disabled");
    await user.click(screen.getByRole("option", { name: /Vertex AI/i }));
    expect(within(claude).queryByLabelText(/Anthropic API key \(required\)/i)).not.toBeInTheDocument();
    expect(within(google).queryByLabelText(/Gemini API key \(required\)/i)).not.toBeInTheDocument();
    expect(claudeMode).toHaveTextContent("Google Cloud Agent Platform");

    await user.type(within(google).getByLabelText(/Google Cloud project ID/i), "jobctrl-test-project");
    await user.click(within(google).getByRole("button", { name: "Save Google setup" }));

    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledWith({
      operations: [
        { operation: "set", key: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
        { operation: "set", key: "GOOGLE_CLOUD_PROJECT", value: "jobctrl-test-project" },
        { operation: "set", key: "GOOGLE_CLOUD_LOCATION", value: "us-central1" },
      ],
    }));
  });

  it("keeps guided provider editing fail-closed when Keychain inspection fails", async () => {
    const verifyCodexProvider = vi.fn(async () => ({
      ok: true as const,
      verification: {
        provider: "codex" as const,
        ok: false,
        status: "not_configured" as const,
        message: "Codex CLI is not authenticated.",
      },
    }));
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        store: {
          ...sampleCredentialsResponse.store,
          available: false,
          unavailableReason: "inspection_failed" as const,
        },
        credentials: sampleCredentialsResponse.credentials.map((credential) => ({
          ...credential,
          configured: null,
        })),
      })),
      verifyCodexProvider,
    });

    expect(await screen.findByText(/could not safely inspect Keychain/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Anthropic API key \(required\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Gemini API key \(required\)/i)).not.toBeInTheDocument();
    const capSolver = await providerCard("Apply CAPTCHA solver");
    expect(within(capSolver).getByLabelText("CapSolver API key")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save Claude setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Google setup" })).not.toBeInTheDocument();
    expect(screen.getByText(/Set GEMINI_API_KEY/i)).toBeInTheDocument();
    const codex = await providerCard("Codex");
    await userEvent.setup().click(
      within(codex).getByRole("button", { name: "Reuse existing login or verify" }),
    );
    expect(verifyCodexProvider).toHaveBeenCalledOnce();
    const privacy = within(screen.getByRole("region", { name: "Credential privacy" }));
    expect(screen.getByText(/guided Claude and Google editing/i)).toBeInTheDocument();
    expect(screen.getByText(/Codex verification remains available/i)).toBeInTheDocument();
    expect(privacy.getByText("Keychain status unavailable")).toBeInTheDocument();
  });

  it("labels isolated auth accurately when the managed SDK is unavailable", async () => {
    renderPanel({
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          {
            provider: "codex" as const,
            configured: true,
            ready: false,
            mode: "cli_auth",
            message: "Codex CLI auth is configured but the managed SDK runtime is unavailable",
          },
        ],
      })),
    });

    const codex = await providerCard("Codex");
    expect(within(codex).getByText("Authenticated · runtime unavailable")).toBeInTheDocument();
    expect(within(codex).getByRole("button", { name: "Verify isolated login" })).toBeEnabled();
    expect(within(codex).queryByRole("button", { name: /Use existing login/i })).not.toBeInTheDocument();
  });

  it("keeps the public demo read-only with no host verification action", async () => {
    renderPanel({}, { demo: true });

    expect(await screen.findByText(/public demo never accepts/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: /Reuse existing login or verify|Verify isolated login/i,
    })).not.toBeInTheDocument();
  });
});

class DemoFeatureFlags implements FeatureFlagPort {
  get<T extends boolean | number | string>(key: string, defaultValue: T): T {
    return (key === "demoMode" ? true : defaultValue) as T;
  }
}

function renderPanel(
  api: Partial<ApiClientPort> = {},
  options: { demo?: boolean } = {},
) {
  const ports = buildTestPorts({
    api: {
      credentials: vi.fn(async () => sampleCredentialsResponse),
      providerStatus: vi.fn(async () => sampleProviderStatusResponse),
      updateCredentialsBatch: vi.fn(async () => sampleCredentialsResponse),
      verifyCodexProvider: vi.fn(async () => ({
        ok: true as const,
        verification: {
          provider: "codex" as const,
          ok: true,
          status: "connected" as const,
          message: "Codex CLI authentication is ready.",
        },
      })),
      ...api,
    },
  });
  return renderWithProviders(<CredentialsPanel />, {
    ports: options.demo
      ? { ...ports, featureFlags: new DemoFeatureFlags() }
      : ports,
  });
}

function configuredProvidersResponse() {
  return {
    ...sampleCredentialsResponse,
    credentials: sampleCredentialsResponse.credentials.map((credential) => ({
      ...credential,
      configured: [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_VERTEX",
        "GEMINI_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
      ].includes(credential.key),
      effectiveSource: [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_VERTEX",
        "GEMINI_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
      ].includes(credential.key) ? "keychain" as const : credential.effectiveSource,
    })),
  };
}

async function providerCard(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name });
  const card = heading.closest("section");
  if (!card) throw new Error(`Missing ${name} provider card`);
  const trigger = within(card).getByRole("button", {
    name: new RegExp(escapeRegExp(name), "i"),
  });
  if (trigger.getAttribute("aria-expanded") === "false") {
    await userEvent.setup().click(trigger);
  }
  return card;
}

async function selectProviderMode(
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
  selectLabel: string,
  optionLabel: string,
) {
  await user.click(within(card).getByRole("combobox", {
    name: new RegExp(escapeRegExp(selectLabel), "i"),
  }));
  await user.click(screen.getByRole("option", {
    name: new RegExp(`^${escapeRegExp(optionLabel)}$`, "i"),
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
