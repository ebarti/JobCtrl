import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";

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
  it("renders three guided provider cards and no raw Codex secret field", async () => {
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Google" })).toBeInTheDocument();
    expect(screen.getByText(CODEX_LOGIN_COMMANDS.subscription)).toBeInTheDocument();
    expect(screen.getByText(CODEX_LOGIN_COMMANDS.apiKey)).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI API key/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Restart JobCtrl after a change/i)).toBeInTheDocument();
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
      expect(within(claude).getByRole("radio", { name: /Google Cloud Agent Platform/i })).toBeChecked(),
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
    const button = within(card).getByRole("button", { name: "Verify connection" });

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

  it("renders guidance without secret inputs when Keychain is unavailable", async () => {
    renderPanel({
      credentials: vi.fn(async () => ({
        ...sampleCredentialsResponse,
        store: {
          ...sampleCredentialsResponse.store,
          available: false,
          unavailableReason: "unsupported_platform" as const,
        },
      })),
    });

    expect(await screen.findByText(/available only with macOS Keychain/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Set GEMINI_API_KEY/i)).toBeInTheDocument();
    expect(screen.getByText(/jobctrl doctor/i)).toBeInTheDocument();
  });
});

function renderPanel(api: Partial<ApiClientPort> = {}) {
  return renderWithProviders(<CredentialsPanel />, {
    ports: buildTestPorts({
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
    }),
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
    })),
  };
}

async function providerCard(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name });
  const card = heading.closest("article");
  if (!card) throw new Error(`Missing ${name} provider card`);
  return card;
}
