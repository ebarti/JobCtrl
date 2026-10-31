import { JobCtrlApiError } from "@jobctrl/api-client";
import type { CredentialsResponse } from "@jobctrl/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import { sampleCredentialsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CredentialForm } from "./credential-form.js";

describe("<CredentialForm>", () => {
  it("keeps the credential identity, secret input, and contextual actions in one field row", () => {
    renderWithProviders(
      <CredentialForm
        credentialKey="OPENAI_API_KEY"
        label="OpenAI API key"
        configured={false}
      />,
    );

    const input = screen.getByLabelText("OpenAI API key");
    const form = input.closest("form");
    expect(form).not.toBeNull();
    expect(form?.children).toHaveLength(3);
    expect(form?.children[0]).toHaveClass("credential-row-status");
    expect(form?.children[0]).toHaveAttribute("data-status-tone", "muted");
    expect(form?.children[1]).toHaveClass("credential-row-field-group");
    expect(form?.children[2]).toHaveClass("credential-row-actions");

    const identity = form?.querySelector(".credential-row-identity");
    expect(identity).not.toBeNull();
    expect(within(identity as HTMLElement).getByText("OpenAI API key")).toHaveAttribute(
      "data-slot",
      "field-label",
    );
    expect(within(identity as HTMLElement).getByText("OPENAI_API_KEY")).toHaveAttribute(
      "id",
      "credential-openai_api_key-description",
    );
    expect(input).toHaveAttribute(
      "aria-describedby",
      "credential-openai_api_key-description",
    );
    expect(
      screen.getByRole("button", { name: "Save OpenAI API key" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    ).toBeDisabled();
  });

  it("turns an operational save failure into sanitized recovery guidance", async () => {
    const user = userEvent.setup();
    const updateCredential = vi.fn(async () => {
      throw new JobCtrlApiError(503, "Service Unavailable");
    });
    renderWithProviders(
      <CredentialForm
        credentialKey="OPENAI_API_KEY"
        label="OpenAI API key"
        configured={false}
      />,
      {
        ports: buildTestPorts({ api: { updateCredential } }),
      },
    );

    await user.type(
      screen.getByLabelText("OpenAI API key"),
      "synthetic-secret",
    );
    await user.click(
      screen.getByRole("button", { name: "Save OpenAI API key" }),
    );

    expect(
      await screen.findByRole("alert", { name: /Keychain update failed/i }),
    ).toHaveTextContent(/Check credential status before trying again/i);
  });

  it.each([
    { reason: "partial_failure", expected: /recovery was incomplete.*partially updated/i },
    { reason: "ownership_unverified", expected: /ownership could not be verified.*previous helper/i },
  ])("shows truthful $reason guidance after a credential removal", async ({ reason, expected }) => {
    const user = userEvent.setup();
    const deleteCredential = vi.fn(async () => {
      throw new JobCtrlApiError(503, "Service Unavailable", "Synthetic private detail", {
        ok: false, error: "credential_store_unavailable", reason, message: "Synthetic private detail",
      }, true);
    });
    renderWithProviders(<CredentialForm credentialKey="CAPSOLVER_API_KEY" label="CapSolver API key" configured />, {
      ports: buildTestPorts({ api: { deleteCredential } }),
    });
    await user.click(screen.getByRole("button", { name: "Remove CapSolver API key" }));
    const alert = await screen.findByRole("alert", { name: /Keychain update failed/i });
    expect(alert).toHaveTextContent(expected);
    expect(alert).not.toHaveTextContent("Synthetic private detail");
    expect(deleteCredential).toHaveBeenCalledOnce();
  });

  it("reports an environment-managed credential rather than an unsupported platform", async () => {
    const user = userEvent.setup();
    const deleteCredential = vi.fn(async () => {
      throw new JobCtrlApiError(409, "Conflict", "Synthetic private detail", {
        ok: false, error: "credential_managed_by_environment", key: "CAPSOLVER_API_KEY", source: "environment",
      });
    });
    renderWithProviders(<CredentialForm credentialKey="CAPSOLVER_API_KEY" label="CapSolver API key" configured />, {
      ports: buildTestPorts({ api: { deleteCredential } }),
    });
    await user.click(screen.getByRole("button", { name: "Remove CapSolver API key" }));
    const alert = await screen.findByRole("alert", { name: /Keychain update failed/i });
    expect(alert).toHaveTextContent(/managed by the launch environment/i);
    expect(alert).not.toHaveTextContent(/unavailable on this platform/i);
    expect(alert).not.toHaveTextContent("Synthetic private detail");
    expect(deleteCredential).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)("retains newer CapSolver input through a pending save (%s)", async (outcome) => {
    const user = userEvent.setup();
    let resolveSave!: (response: CredentialsResponse) => void;
    let rejectSave!: (error: Error) => void;
    const updateCredential = vi.fn<ApiClientPort["updateCredential"]>()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }))
      .mockResolvedValue(credentialResponse(true));
    renderWithProviders(<CredentialForm credentialKey="CAPSOLVER_API_KEY" label="CapSolver API key" configured />, {
      ports: buildTestPorts({ api: { updateCredential } }),
    });
    const input = screen.getByLabelText("CapSolver API key");
    await user.type(input, "SYNTHETIC_A");
    await user.click(screen.getByRole("button", { name: "Save CapSolver API key" }));
    await waitFor(() => expect(updateCredential).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Remove CapSolver API key" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "SYNTHETIC_B");
    await act(async () => outcome === "success" ? resolveSave(credentialResponse(true)) : rejectSave(new Error("Synthetic save failure")));
    await waitFor(() => expect(input).toHaveValue("SYNTHETIC_B"));
    if (outcome === "success") expect(await screen.findByText(/newer input remains unsaved/i)).toBeInTheDocument();
    else expect(await screen.findByRole("alert", { name: /Keychain update failed/i })).toBeInTheDocument();
    expect(updateCredential).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Save CapSolver API key" }));
    await waitFor(() => expect(updateCredential).toHaveBeenCalledTimes(2));
    expect(updateCredential).toHaveBeenLastCalledWith({ key: "CAPSOLVER_API_KEY", value: "SYNTHETIC_B" });
  });

  it.each(["success", "failure"] as const)("retains newer CapSolver input through a pending removal (%s)", async (outcome) => {
    const user = userEvent.setup();
    let resolveRemoval!: (response: CredentialsResponse) => void;
    let rejectRemoval!: (error: Error) => void;
    const deleteCredential = vi.fn<ApiClientPort["deleteCredential"]>()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveRemoval = resolve; rejectRemoval = reject; }));
    const updateCredential = vi.fn<ApiClientPort["updateCredential"]>().mockResolvedValue(credentialResponse(true));
    renderWithProviders(<CredentialForm credentialKey="CAPSOLVER_API_KEY" label="CapSolver API key" configured />, {
      ports: buildTestPorts({ api: { deleteCredential, updateCredential } }),
    });
    const input = screen.getByLabelText("CapSolver API key");
    await user.type(input, "SYNTHETIC_A");
    await user.click(screen.getByRole("button", { name: "Remove CapSolver API key" }));
    await waitFor(() => expect(deleteCredential).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Save CapSolver API key" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "SYNTHETIC_B");
    await act(async () => outcome === "success" ? resolveRemoval(credentialResponse(false)) : rejectRemoval(new Error("Synthetic removal failure")));
    await waitFor(() => expect(input).toHaveValue("SYNTHETIC_B"));
    if (outcome === "success") expect(await screen.findByText(/newer input remains unsaved/i)).toBeInTheDocument();
    else expect(await screen.findByRole("alert", { name: /Keychain update failed/i })).toBeInTheDocument();
    expect(deleteCredential).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Save CapSolver API key" }));
    await waitFor(() => expect(updateCredential).toHaveBeenCalledOnce());
    expect(updateCredential).toHaveBeenCalledWith({ key: "CAPSOLVER_API_KEY", value: "SYNTHETIC_B" });
  });

  it.each(["save", "remove"] as const)("clears the unchanged input after a successful %s", async (operation) => {
    const user = userEvent.setup();
    const updateCredential = vi.fn<ApiClientPort["updateCredential"]>().mockResolvedValue(credentialResponse(true));
    const deleteCredential = vi.fn<ApiClientPort["deleteCredential"]>().mockResolvedValue(credentialResponse(false));
    renderWithProviders(<CredentialForm credentialKey="CAPSOLVER_API_KEY" label="CapSolver API key" configured />, {
      ports: buildTestPorts({ api: { deleteCredential, updateCredential } }),
    });
    const input = screen.getByLabelText("CapSolver API key");
    await user.type(input, "SYNTHETIC_A");
    await user.click(screen.getByRole("button", { name: `${operation === "save" ? "Save" : "Remove"} CapSolver API key` }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByText(/newer input remains unsaved/i)).not.toBeInTheDocument();
  });
});

function credentialResponse(configured: boolean): CredentialsResponse {
  return {
    ...sampleCredentialsResponse,
    credentials: sampleCredentialsResponse.credentials.map((entry) => entry.key === "CAPSOLVER_API_KEY" ? { ...entry, configured } : entry),
  };
}
