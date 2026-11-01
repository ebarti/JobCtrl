import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import { sampleCredentialsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { removeGoogleProviderBatch } from "../lib/provider-credential-plans.js";
import {
  ClaudeProviderForm,
  GoogleProviderForm,
} from "./provider-setup-forms.js";

describe("provider setup forms", () => {
  it.each([
    { provider: "Claude", component: <ClaudeProviderForm configured={false} />, input: "Anthropic API key (required)", key: "ANTHROPIC_API_KEY" },
    { provider: "Google", component: <GoogleProviderForm configured={false} />, input: "Gemini API key (required)", key: "GEMINI_API_KEY" },
  ])("keeps newer synthetic input after a pending $provider setup save", async ({ provider, component, input, key }) => {
    const user = userEvent.setup();
    let resolveSave!: (value: typeof sampleCredentialsResponse) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }))
      .mockResolvedValue(sampleCredentialsResponse);
    renderWithProviders(component, { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    const field = screen.getByLabelText(input);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    expect(field).toBeEnabled();
    await user.clear(field);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_B");
    await act(async () => resolveSave(sampleCredentialsResponse));
    await waitFor(() => expect(field).toHaveValue("SYNTHETIC_PLACEHOLDER_B"));
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledTimes(2));
    expect(updateCredentialsBatch.mock.calls[1]?.[0].operations).toEqual(expect.arrayContaining([
      { operation: "set", key, value: "SYNTHETIC_PLACEHOLDER_B" },
    ]));
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it.each([
    { provider: "Claude", component: <ClaudeProviderForm configured={false} />, input: "Anthropic API key (required)", key: "ANTHROPIC_API_KEY" },
    { provider: "Google", component: <GoogleProviderForm configured={false} />, input: "Gemini API key (required)", key: "GEMINI_API_KEY" },
  ])("retains newer synthetic $provider input after a failed save and retries it deliberately", async ({ provider, component, input, key }) => {
    const user = userEvent.setup();
    let rejectSave!: (reason: Error) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }))
      .mockResolvedValue(sampleCredentialsResponse);
    renderWithProviders(component, { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    const field = screen.getByLabelText(input);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    await user.clear(field);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_B");
    await act(async () => rejectSave(new Error("Synthetic save failure")));
    expect(field).toHaveValue("SYNTHETIC_PLACEHOLDER_B");
    expect(updateCredentialsBatch).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledTimes(2));
    expect(updateCredentialsBatch.mock.calls[1]?.[0].operations).toEqual(expect.arrayContaining([
      { operation: "set", key, value: "SYNTHETIC_PLACEHOLDER_B" },
    ]));
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it.each([
    { provider: "Claude", component: <ClaudeProviderForm configured={false} />, input: "Anthropic API key (required)" },
    { provider: "Google", component: <GoogleProviderForm configured={false} />, input: "Gemini API key (required)" },
  ].flatMap((provider) => [
    { ...provider, reason: "busy", message: "Another credential update is in progress. Retry after it finishes." },
    { ...provider, reason: "ownership_unverified", message: "Credential update ownership could not be verified. Restore process inspection or verify the previous helper has exited before clearing its coordination record." },
    { ...provider, reason: "partial_failure", message: "Credential update failed and native-store recovery was incomplete. Provider credentials may be partially updated; inspect the native credential store before retrying." },
  ]))("retains newer $provider input after credential $reason", async ({ provider, component, input, reason, message }) => {
    const user = userEvent.setup();
    let rejectSave!: (reason: Error) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }))
      .mockResolvedValue(sampleCredentialsResponse);
    renderWithProviders(component, { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    const field = screen.getByLabelText(input);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    await user.clear(field);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_B");
    await act(async () => rejectSave(new JobCtrlApiError(503, "Service Unavailable", message, {
      ok: false, error: "credential_store_unavailable", reason, message,
    }, true)));
    expect(await screen.findByText(`Could not save provider settings. ${message}`)).toBeInTheDocument();
    expect(field).toHaveValue("SYNTHETIC_PLACEHOLDER_B");
    expect(updateCredentialsBatch).toHaveBeenCalledOnce();
  });

  it.each([
    { provider: "Claude", input: "Anthropic API key (required)", vertex: /Google Vertex AI/i },
    { provider: "Google", input: "Gemini API key (required)", vertex: /^Vertex AI\b/i },
  ])("keeps a newer $provider mode when saved status arrives during a pending save", async ({ provider, input, vertex }) => {
    const user = userEvent.setup();
    let resolveSave!: (value: typeof sampleCredentialsResponse) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const component = (currentMode?: string) => provider === "Claude"
      ? <ClaudeProviderForm configured={false} currentMode={currentMode} />
      : <GoogleProviderForm configured={false} currentMode={currentMode} />;
    const view = renderWithProviders(component(), { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    await user.type(screen.getByLabelText(input), "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    const vertexChoice = screen.getByRole("radio", { name: vertex });
    await user.click(vertexChoice);
    expect(vertexChoice).toBeChecked();
    view.rerender(component("api_key"));
    expect(vertexChoice).toBeChecked();
    await act(async () => resolveSave(sampleCredentialsResponse));
    expect(vertexChoice).toBeChecked();
    expect(screen.getByLabelText(/Google Cloud project ID/i)).toBeInTheDocument();
  });

  it.each([
    { provider: "Claude", input: "Anthropic API key (required)", apiKey: /Anthropic API key/i },
    { provider: "Google", input: "Gemini API key (required)", apiKey: /Gemini API key/i },
  ])("keeps a newer synthetic $provider key visible when provider status switches modes", async ({ provider, input, apiKey }) => {
    const user = userEvent.setup();
    let resolveSave!: (value: typeof sampleCredentialsResponse) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const component = (currentMode: string) => provider === "Claude"
      ? <ClaudeProviderForm configured={false} currentMode={currentMode} />
      : <GoogleProviderForm configured={false} currentMode={currentMode} />;
    const view = renderWithProviders(component("api_key"), { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    const field = screen.getByLabelText(input);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    await user.clear(field);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_B");
    view.rerender(component("vertex"));
    expect(screen.getByRole("radio", { name: apiKey })).toBeChecked();
    expect(field).toHaveValue("SYNTHETIC_PLACEHOLDER_B");
    await act(async () => resolveSave(sampleCredentialsResponse));
    expect(screen.getByRole("radio", { name: apiKey })).toBeChecked();
    expect(field).toHaveValue("SYNTHETIC_PLACEHOLDER_B");
  });

  it.each([
    { provider: "Claude", input: "Anthropic API key (required)", vertex: /Google Vertex AI/i },
    { provider: "Google", input: "Gemini API key (required)", vertex: /^Vertex AI\b/i },
  ])("adopts changed $provider status after acknowledgement when there are no newer edits", async ({ provider, input, vertex }) => {
    const user = userEvent.setup();
    let resolveSave!: (value: typeof sampleCredentialsResponse) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const component = (currentMode: string) => provider === "Claude"
      ? <ClaudeProviderForm configured={false} currentMode={currentMode} />
      : <GoogleProviderForm configured={false} currentMode={currentMode} />;
    const view = renderWithProviders(component("api_key"), { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    await user.type(screen.getByLabelText(input), "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    view.rerender(component("vertex"));
    await act(async () => resolveSave(sampleCredentialsResponse));
    expect(screen.getByRole("radio", { name: vertex })).toBeChecked();
    expect(screen.queryByLabelText(input)).not.toBeInTheDocument();
  });

  it.each([
    { provider: "Claude", component: <ClaudeProviderForm configured={false} />, vertex: /Google Vertex AI/i },
    { provider: "Google", component: <GoogleProviderForm configured={false} />, vertex: /^Vertex AI\b/i },
  ])("preserves newer synthetic $provider service-account input until its own save", async ({ provider, component, vertex }) => {
    const user = userEvent.setup();
    let resolveSave!: (value: typeof sampleCredentialsResponse) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }))
      .mockResolvedValue(sampleCredentialsResponse);
    renderWithProviders(component, { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    await user.click(screen.getByRole("radio", { name: vertex }));
    await user.type(screen.getByLabelText(/Google Cloud project ID/i), "synthetic-project");
    const field = screen.getByLabelText("Existing service-account JSON path (optional)");
    await user.type(field, "SYNTHETIC_PATH_A");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    expect(field).toHaveValue("SYNTHETIC_PATH_A");
    await user.clear(field);
    await user.type(field, "SYNTHETIC_PATH_B");
    await act(async () => resolveSave(sampleCredentialsResponse));
    await waitFor(() => expect(field).toHaveValue("SYNTHETIC_PATH_B"));
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledTimes(2));
    expect(updateCredentialsBatch.mock.calls[1]?.[0].operations).toEqual(expect.arrayContaining([
      { operation: "set", key: "GOOGLE_APPLICATION_CREDENTIALS", value: "SYNTHETIC_PATH_B" },
    ]));
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it.each([
    { provider: "Claude", vertex: /Google Vertex AI/i, apiKey: /Anthropic API key/i },
    { provider: "Google", vertex: /^Vertex AI\b/i, apiKey: /Gemini API key/i },
  ])("adopts later $provider status after the selected mode is saved without newer edits", async ({ provider, vertex, apiKey }) => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>().mockResolvedValue(sampleCredentialsResponse);
    const component = (currentMode: string) => provider === "Claude"
      ? <ClaudeProviderForm configured={false} currentMode={currentMode} />
      : <GoogleProviderForm configured={false} currentMode={currentMode} />;
    const view = renderWithProviders(component("api_key"), { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    await user.click(screen.getByRole("radio", { name: vertex }));
    await user.type(screen.getByLabelText(/Google Cloud project ID/i), "synthetic-project");
    await user.click(screen.getByRole("button", { name: `Save ${provider} setup` }));
    await screen.findByText(new RegExp(`${provider} provider settings saved`));
    view.rerender(component("vertex"));
    expect(screen.getByRole("radio", { name: vertex })).toBeChecked();
    view.rerender(component("api_key"));
    expect(screen.getByRole("radio", { name: apiKey })).toBeChecked();
  });

  it.each([
    { provider: "Claude", component: <ClaudeProviderForm configured currentMode="api_key" />, input: "Anthropic API key (required)" },
    { provider: "Google", component: <GoogleProviderForm configured currentMode="api_key" />, input: "Gemini API key (required)" },
  ])("retains newer synthetic $provider input if removal finishes after its dialog closes", async ({ provider, component, input }) => {
    const user = userEvent.setup();
    let resolveRemoval!: (value: typeof sampleCredentialsResponse) => void;
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRemoval = resolve; }));
    renderWithProviders(component, { ports: buildTestPorts({ api: { updateCredentialsBatch } }) });
    const field = screen.getByLabelText(input);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_A");
    await user.click(screen.getByRole("button", { name: `Remove ${provider} setup` }));
    const dialog = screen.getByRole("dialog", { name: `Remove ${provider} provider setup?` });
    await user.click(within(dialog).getByRole("button", { name: `Remove ${provider} setup` }));
    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.clear(field);
    await user.type(field, "SYNTHETIC_PLACEHOLDER_B");
    await act(async () => resolveRemoval(sampleCredentialsResponse));
    expect(field).toHaveValue("SYNTHETIC_PLACEHOLDER_B");
  });
  it("uses shared choice, field, input, and action primitives", () => {
    renderWithProviders(<GoogleProviderForm configured={false} currentMode="gemini_api_key" />);

    expect(
      screen.getByText("Choose how Google authenticates").closest("fieldset"),
    ).toHaveAttribute("data-slot", "field-set");
    expect(screen.getAllByRole("radio")).not.toHaveLength(0);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("data-slot", "input");
    }
    expect(screen.getByLabelText("Gemini API key (required)")).toHaveAttribute(
      "data-slot",
      "input",
    );
    expect(screen.getByRole("button", { name: "Show" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.getByRole("button", { name: "Save Google setup" })).toHaveAttribute(
      "data-slot",
      "button",
    );
  });

  it("selects Vertex AI from its visible card while preserving radio interaction", async () => {
    const user = userEvent.setup();
    const onChangeCapture = vi.fn();
    renderWithProviders(
      <div onChangeCapture={onChangeCapture}>
        <GoogleProviderForm configured={false} currentMode="gemini_api_key" />
      </div>,
    );

    const vertex = screen.getByRole("radio", { name: /Vertex AI/i });
    const vertexCard = vertex.closest("label");
    expect(vertexCard).not.toBeNull();
    expect(vertex).not.toBeChecked();
    expect(screen.queryByText("Not configured")).not.toBeInTheDocument();

    await user.click(vertexCard!);

    expect(vertex).toBeChecked();
    expect(vertex).toHaveFocus();
    expect(onChangeCapture).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText(/Google Cloud project ID/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Gemini API key/i }));
    expect(onChangeCapture).toHaveBeenCalledTimes(2);
    vertex.focus();
    await user.keyboard("[Space]");

    expect(vertex).toBeChecked();
    expect(onChangeCapture).toHaveBeenCalledTimes(3);
  });

  it("links each ADC route to its canonical provider documentation", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ClaudeProviderForm configured={false} />
        <GoogleProviderForm configured={false} />
      </>,
    );

    await user.click(
      screen.getByRole("radio", { name: /Google Vertex AI/i }),
    );
    await user.click(screen.getByRole("radio", { name: /^Vertex AI\b/i }));

    expect(
      screen.getByRole("link", { name: "JobCtrl Claude guide" }),
    ).toHaveAttribute("href", "https://jobctrl.dev/user/configuration#claude");
    expect(
      screen.getByRole("link", { name: "JobCtrl Google guide" }),
    ).toHaveAttribute("href", "https://jobctrl.dev/user/configuration#google");
    expect(
      screen.getAllByText("gcloud auth application-default login"),
    ).toHaveLength(2);
    expect(
      screen.queryByText(/No credential file is uploaded or copied here/i),
    ).not.toBeInTheDocument();
  });

  it("switches from an environment-owned Gemini key to local Vertex settings", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderWithProviders(
      <GoogleProviderForm
        configured
        currentMode="api_key"
        environmentManagedKeys={["GEMINI_API_KEY"]}
      />,
      { ports: buildTestPorts({ api: { updateCredentialsBatch } }) },
    );

    const gemini = screen.getByRole("radio", { name: /Gemini API key/i });
    const vertex = screen.getByRole("radio", { name: /Vertex AI/i });
    expect(gemini).toBeChecked();
    expect(gemini).toBeDisabled();
    expect(vertex).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save Google setup" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove Google setup" })).not.toBeInTheDocument();

    await user.click(vertex.closest("label")!);
    await user.type(screen.getByLabelText(/Google Cloud project ID/i), "jobctrl-vertex");
    expect(screen.getByRole("button", { name: "Save Google setup" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save Google setup" }));

    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledWith({
      operations: [
        { operation: "set", key: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
        { operation: "set", key: "GOOGLE_CLOUD_PROJECT", value: "jobctrl-vertex" },
        { operation: "set", key: "GOOGLE_CLOUD_LOCATION", value: "us-central1" },
      ],
    }));
    expect(await screen.findByText(/Google provider settings saved\. Restart JobCtrl/i)).toBeInTheDocument();
    expect(screen.queryByText("Configured")).not.toBeInTheDocument();
  });

  it("switches Claude away from an environment-owned API key without mutating it", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn<ApiClientPort["updateCredentialsBatch"]>(
      async () => sampleCredentialsResponse,
    );
    renderWithProviders(
      <ClaudeProviderForm
        configured
        currentMode="api_key"
        environmentManagedKeys={["ANTHROPIC_API_KEY"]}
      />,
      { ports: buildTestPorts({ api: { updateCredentialsBatch } }) },
    );

    const vertex = screen.getByRole("radio", { name: /Google Vertex AI/i });
    expect(screen.getByRole("radio", { name: /Anthropic API key/i })).toBeDisabled();
    expect(vertex).toBeEnabled();

    await user.click(vertex.closest("label")!);
    await user.type(screen.getByLabelText(/Google Cloud project ID/i), "jobctrl-claude-vertex");
    await user.click(screen.getByRole("button", { name: "Save Claude setup" }));

    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledOnce());
    const firstCall = updateCredentialsBatch.mock.calls.at(0);
    if (!firstCall) throw new Error("Expected a credential batch request.");
    const request = firstCall[0];
    expect(request.operations).toEqual(expect.arrayContaining([
      { operation: "set", key: "CLAUDE_CODE_USE_VERTEX", value: "1" },
      { operation: "set", key: "ANTHROPIC_VERTEX_PROJECT_ID", value: "jobctrl-claude-vertex" },
      { operation: "set", key: "CLOUD_ML_REGION", value: "global" },
    ]));
    expect(request.operations.some((operation) => operation.key === "ANTHROPIC_API_KEY")).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove Claude setup" })).not.toBeInTheDocument();
  });

  it("keeps removal feedback without repeating the provider's configured state", async () => {
    const user = userEvent.setup();
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    renderWithProviders(
      <GoogleProviderForm configured currentMode="gemini_api_key" />,
      { ports: buildTestPorts({ api: { updateCredentialsBatch } }) },
    );

    expect(screen.queryByText("Configured")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Google setup" }));
    const dialog = screen.getByRole("dialog", {
      name: "Remove Google provider setup?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Google setup" }),
    );

    await waitFor(() => expect(updateCredentialsBatch).toHaveBeenCalledWith(removeGoogleProviderBatch()));
    expect(await screen.findByText(/Google provider settings removed\. Restart JobCtrl/i)).toBeInTheDocument();
    expect(screen.queryByText("Configured")).not.toBeInTheDocument();
  });
});
