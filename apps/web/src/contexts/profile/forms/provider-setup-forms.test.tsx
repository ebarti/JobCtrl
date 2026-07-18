import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
