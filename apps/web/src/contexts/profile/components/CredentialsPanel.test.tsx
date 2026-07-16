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
  removeClaudeProviderBatch,
  removeGoogleProviderBatch,
} from "../lib/provider-credential-plans.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

describe("<CredentialsPanel>", () => {
  it("renders three guided provider cards and no raw Codex secret field", async () => {
    renderPanel();

    const codex = await providerCard("Codex");
    expect(screen.queryByRole("note", { name: "Provider settings storage" })).not.toBeInTheDocument();
    expect(within(codex).getByText("Ready")).toBeInTheDocument();
    expect(within(codex).getByRole("link", { name: "JobCtrl Codex guide" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/configuration#codex",
    );
    expect(within(codex).queryByText(/Detected mode:/i)).not.toBeInTheDocument();
    expect(within(codex).queryByText(/Effective ownership:/i)).not.toBeInTheDocument();
    expect(within(codex).queryByText(/Use an existing Codex CLI login first/i)).not.toBeInTheDocument();
    expect(within(codex).queryByText(/Fallback: ChatGPT subscription/i)).not.toBeInTheDocument();
    expect(within(codex).queryByText(/Fallback: OpenAI API key enrollment/i)).not.toBeInTheDocument();
    expect(within(codex).queryByText(/prompt-readable/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Google" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Apply CAPTCHA solver" })).toBeInTheDocument();
    expect(screen.getByLabelText("CapSolver API key")).toBeEnabled();
    expect(screen.queryByLabelText(/OpenAI API key/i)).not.toBeInTheDocument();
  });

  it("shows provider storage guidance only while a provider edit is unsaved", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderPanel({ updateCredentialsBatch });
    const google = await providerCard("Google");

    expect(screen.queryByRole("note", { name: "Provider settings storage" })).not.toBeInTheDocument();

    await user.click(within(google).getByRole("radio", { name: /Vertex AI/i }));
    const storagePanel = screen.getByRole("note", { name: "Provider settings storage" });
    expect(storagePanel).toHaveAttribute("data-slot", "alert");
    expect(within(storagePanel).getByText("Provider settings storage")).toHaveAttribute(
      "data-slot",
      "alert-title",
    );
    expect(storagePanel.querySelector("svg")).toHaveClass("tabler-icon-info-circle");

    await user.type(
      within(google).getByLabelText(/Google Cloud project ID/i),
      "jobctrl-test-project",
    );
    await user.click(within(google).getByRole("button", { name: "Save Google setup" }));

    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("note", { name: "Provider settings storage" })).not.toBeInTheDocument(),
    );
  });

  it("preserves an unsaved provider draft across disclosure toggles", async () => {
    const user = userEvent.setup();
    renderPanel();
    const google = await providerCard("Google");

    await user.click(within(google).getByRole("radio", { name: /Vertex AI/i }));
    const projectId = within(google).getByLabelText(/Google Cloud project ID/i);
    await user.type(projectId, "jobctrl-draft-project");

    const trigger = within(google).getByRole("button", { name: /^Google\b/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(projectId).toBeInTheDocument();
    expect(projectId).toHaveValue("jobctrl-draft-project");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(google).getByLabelText(/Google Cloud project ID/i)).toBe(projectId);
    expect(projectId).toHaveValue("jobctrl-draft-project");
  });

  it("keeps provider storage guidance after an unsuccessful save", async () => {
    const user = userEvent.setup();
    renderPanel({
      updateCredentialsBatch: vi.fn(async () => {
        throw new Error("save unavailable");
      }),
    });
    const google = await providerCard("Google");

    await user.click(within(google).getByRole("radio", { name: /Vertex AI/i }));
    await user.type(
      within(google).getByLabelText(/Google Cloud project ID/i),
      "jobctrl-test-project",
    );
    await user.click(within(google).getByRole("button", { name: "Save Google setup" }));

    expect(await within(google).findByText(/Could not save provider settings/i)).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Provider settings storage" })).toBeInTheDocument();
  });

  it("preserves provider-status warnings without showing storage guidance by default", async () => {
    renderPanel({
      providerStatus: vi.fn(async () => {
        throw new Error("status unavailable");
      }),
    });

    expect(await screen.findByText(/Live provider status is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Provider settings storage" })).not.toBeInTheDocument();
  });

  it.each(["Claude", "Google"])(
    "renders the %s unconfigured state once without an empty ownership fact",
    async (title) => {
      renderPanel({
        credentials: vi.fn(async () => ({
          ...sampleCredentialsResponse,
          credentials: sampleCredentialsResponse.credentials.map((credential) => ({
            ...credential,
            configured: false,
            effectiveSource: "absent" as const,
          })),
        })),
        providerStatus: vi.fn(async () => ({ ok: true as const, providers: [] })),
      });

      const card = await providerCard(title);
      expect(within(card).getAllByText("Not configured")).toHaveLength(1);
      expect(within(card).queryByText("Effective ownership: not configured")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["Anthropic API key", /Anthropic API key \(required\)/i],
    ["Google Vertex AI", /Google Cloud project ID/i],
    ["Amazon Bedrock", /AWS profile \(optional\)/i],
    ["Claude Platform on AWS", /Workspace ID/i],
    ["Microsoft Foundry", /Microsoft Foundry resource name/i],
  ])("shows the %s Claude route fields", async (choice, expectedField) => {
    const user = userEvent.setup();
    renderPanel();
    const card = await providerCard("Claude");

    await user.click(within(card).getByRole("radio", { name: new RegExp(choice, "i") }));

    expect(within(card).getByLabelText(expectedField)).toBeInTheDocument();
  });

  it.each([
    ["Gemini API key", /Gemini API key \(required\)/i],
    ["Vertex AI", /Google Cloud project ID/i],
  ])("shows the %s Google route fields", async (choice, expectedField) => {
    const user = userEvent.setup();
    renderPanel();
    const card = await providerCard("Google");

    await user.click(within(card).getByRole("radio", { name: new RegExp(choice, "i") }));

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
    await waitFor(() => expect(within(claude).getByRole("radio", { name: /Amazon Bedrock/i })).toBeChecked());
    expect(within(google).getByRole("radio", { name: /Vertex AI/i })).toBeChecked();
    expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
  });

  it("uses the selected authentication labels for detected provider modes", async () => {
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
          { provider: "claude" as const, configured: true, ready: true, mode: "vertex" },
          { provider: "google" as const, configured: true, ready: true, mode: "api_key" },
        ],
      })),
    });

    const claude = await providerCard("Claude");
    const google = await providerCard("Google");

    expect(within(claude).getByText("Detected mode: Google Vertex AI")).toBeInTheDocument();
    expect(within(claude).getByRole("radio", { name: /Google Vertex AI/i })).toBeChecked();
    expect(within(google).getByText("Detected mode: Gemini API key")).toBeInTheDocument();
    expect(within(claude).queryByText("Detected mode: vertex")).not.toBeInTheDocument();
    expect(within(google).queryByText("Detected mode: api_key")).not.toBeInTheDocument();
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
      expect(within(claude).getByRole("radio", { name: /Google Vertex AI/i })).toBeChecked(),
    );
    expect(within(google).getByRole("radio", { name: /Vertex AI/i })).toBeChecked();
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
    await user.click(within(card).getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    await user.click(within(card).getByRole("button", { name: "Hide" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it.each([
    {
      title: "Codex",
      provider: "codex" as const,
      mode: "cli_auth",
      message: "Codex CLI authentication is ready",
    },
    {
      title: "Claude",
      provider: "claude" as const,
      mode: "api_key",
      message: "Claude provider is ready",
    },
    {
      title: "Google",
      provider: "google" as const,
      mode: "api_key",
      message: "Google provider is ready",
    },
  ])("suppresses the $title ready boilerplate beside its Ready badge", async ({
    title,
    provider,
    mode,
    message,
  }) => {
    renderPanel({
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [{ provider, configured: true, ready: true, mode, message }],
      })),
    });

    const card = await providerCard(title);
    expect(within(card).getByText("Ready")).toBeInTheDocument();
    expect(within(card).queryByText(message)).not.toBeInTheDocument();
  });

  it("preserves a meaningful ready-provider status message", async () => {
    const message = "Claude provider is ready, but the fallback region could not be verified.";
    renderPanel({
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          {
            provider: "claude" as const,
            configured: true,
            ready: true,
            mode: "bedrock",
            message,
          },
        ],
      })),
    });

    const card = await providerCard("Claude");
    expect(within(card).getByText("Ready")).toBeInTheDocument();
    expect(within(card).getByText(message)).toBeInTheDocument();
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
    renderPanel({
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          {
            provider: "codex" as const,
            configured: true,
            ready: true,
            mode: "subscription",
            message: "Codex CLI authentication is ready.",
          },
        ],
      })),
      verifyCodexProvider,
    });
    const card = await providerCard("Codex");
    const button = within(card).getByRole("button", { name: "Reuse existing login or verify" });

    expect(within(card).getByText("Ready")).toBeInTheDocument();
    expect(within(card).queryByText("Codex CLI authentication is ready.")).not.toBeInTheDocument();
    await user.click(button);
    expect(await within(card).findAllByText("Codex CLI authentication is ready.")).toHaveLength(1);
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

  it("protects an environment-owned active credential while allowing another auth mode", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        credentials: sampleCredentialsResponse.credentials.map((credential) =>
          credential.key === "GEMINI_API_KEY"
            ? {
                ...credential,
                configured: true,
                effectiveSource: "environment" as const,
                editable: false,
              }
            : credential,
        ),
      })),
      providerStatus: vi.fn(async () => ({
        ok: true as const,
        providers: [
          { provider: "google" as const, configured: true, ready: true, mode: "api_key" },
        ],
      })),
      updateCredentialsBatch,
    });

    const card = await providerCard("Google");
    const gemini = within(card).getByRole("radio", { name: /Gemini API key/i });
    const vertex = within(card).getByRole("radio", { name: /Vertex AI/i });
    expect(gemini).toBeChecked();
    expect(gemini).toBeDisabled();
    expect(within(card).getByLabelText(/Gemini API key \(required\)/i)).toBeDisabled();
    expect(vertex).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Save Google setup" })).toBeDisabled();
    expect(within(card).queryByRole("button", { name: "Remove Google setup" })).not.toBeInTheDocument();
    expect(within(card).getByText(/active setup includes values owned by the launch environment/i)).toBeInTheDocument();

    await user.click(vertex.closest("label")!);
    expect(vertex).toBeChecked();
    expect(within(card).getByLabelText(/Google Cloud project ID/i)).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Save Google setup" })).toBeEnabled();
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

    const solver = await screen.findByRole("heading", { name: "Apply CAPTCHA solver" });
    const panel = solver.closest("section");
    expect(panel).not.toBeNull();
    expect(within(panel!).getByLabelText("CapSolver API key")).toBeDisabled();
    expect(within(panel!).getByText("managed by environment")).toBeInTheDocument();
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
    expect(within(claude).getByRole("radio", { name: /Anthropic API key/i })).toBeDisabled();
    expect(within(google).getByRole("radio", { name: /Gemini API key/i })).toBeDisabled();
    expect(within(claude).queryByLabelText(/Anthropic API key \(required\)/i)).not.toBeInTheDocument();
    expect(within(google).queryByLabelText(/Gemini API key \(required\)/i)).not.toBeInTheDocument();
    expect(within(claude).getByRole("radio", { name: /Google Vertex AI/i })).toBeEnabled();
    await user.click(within(google).getByRole("radio", { name: /Vertex AI/i }));

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
    expect(screen.getByLabelText("CapSolver API key")).toBeDisabled();
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
    expect(privacy.getAllByText("Keychain status unavailable")).toHaveLength(2);
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
    expect(
      within(codex).getByText(/managed SDK runtime is unavailable/i),
    ).toBeInTheDocument();
    expect(within(codex).getByRole("button", { name: "Verify isolated login" })).toBeEnabled();
    expect(within(codex).queryByRole("button", { name: /Use existing login/i })).not.toBeInTheDocument();
  });

  it("keeps the public demo read-only with no host verification action", async () => {
    renderPanel({}, { demo: true });

    expect(await screen.findByText(/public demo never accepts/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /^(Reuse existing login or verify|Verify isolated login)$/i,
      }),
    ).not.toBeInTheDocument();
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
  const card = heading.closest("article");
  if (!card) throw new Error(`Missing ${name} provider card`);
  const trigger = within(card).getByRole("button", { name: new RegExp(`^${name}\\b`, "i") });
  if (trigger.getAttribute("aria-expanded") === "false") {
    await userEvent.setup().click(trigger);
  }
  return card;
}
