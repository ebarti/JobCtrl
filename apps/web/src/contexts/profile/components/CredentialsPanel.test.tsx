import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleCredentialsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

describe("<CredentialsPanel>", () => {
  it("disables Keychain forms off macOS while keeping environment guidance visible", async () => {
    renderWithProviders(<CredentialsPanel />, {
      ports: buildTestPorts({
        api: {
          credentials: vi.fn(async () => ({
            ...sampleCredentialsResponse,
            store: {
              ...sampleCredentialsResponse.store,
              available: false,
              unavailableReason: "unsupported_platform" as const,
            },
            credentials: sampleCredentialsResponse.credentials.map(
              (credential) => ({
                ...credential,
                configured: null,
              }),
            ),
          })),
        },
      }),
    });

    const unavailableBanner = await screen.findByText(
      /Keychain credential editing is available only on macOS/i,
    );
    expect(unavailableBanner).toHaveTextContent(
      "Configure these values in ~/.jobctrl/.env or your shell environment on this platform.",
    );
    for (const input of [
      screen.getByLabelText(/OpenAI API Key/),
      screen.getByLabelText(/Gemini API Key/),
      screen.getByLabelText(/Custom LLM URL/),
    ]) {
      expect(input).toBeDisabled();
    }
    expect(screen.getAllByText("environment only")).toHaveLength(3);
    expect(
      screen.getByRole("heading", { name: "Use environment configuration" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("macOS Keychain", { selector: "span" }),
    ).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("tells macOS users that saved Keychain changes require a worker restart", async () => {
    renderWithProviders(<CredentialsPanel />, {
      ports: buildTestPorts({
        api: { credentials: vi.fn(async () => sampleCredentialsResponse) },
      }),
    });

    expect(
      await screen.findByText(
        /restart the JobCtrl worker after saving or removing/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("stored in Keychain")).toBeInTheDocument();
    expect(screen.getAllByText("not in Keychain")).toHaveLength(2);
    expect(screen.getByLabelText(/OpenAI API Key/)).toBeEnabled();
  });

  it("labels confirmed Keychain absences without implying the runtime environment is absent", async () => {
    renderWithProviders(<CredentialsPanel />, {
      ports: buildTestPorts({
        api: {
          credentials: vi.fn(async () => ({
            ...sampleCredentialsResponse,
            credentials: sampleCredentialsResponse.credentials.map(
              (credential) => ({
                ...credential,
                configured: false,
              }),
            ),
          })),
        },
      }),
    });

    expect(await screen.findAllByText("not in Keychain")).toHaveLength(3);
    expect(
      screen.getByText(
        /these checks do not inspect your shell or ~\/\.jobctrl\/\.env/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders failed inspection as unknown, disables mutations, and offers a retry", async () => {
    const user = userEvent.setup();
    const credentials = vi.fn(async () => ({
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
    }));
    renderWithProviders(<CredentialsPanel />, {
      ports: buildTestPorts({ api: { credentials } }),
    });

    expect(
      await screen.findByRole("alert", {
        name: /Keychain inspection unavailable/i,
      }),
    ).toHaveTextContent(/Unlock Keychain Access, then retry/i);
    expect(screen.getAllByText("unable to check")).toHaveLength(3);
    for (const input of [
      screen.getByLabelText(/OpenAI API Key/),
      screen.getByLabelText(/Gemini API Key/),
      screen.getByLabelText(/Custom LLM URL/),
    ]) {
      expect(input).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", {
      name: /save|remove/i,
    })) {
      expect(button).toBeDisabled();
    }

    await user.click(
      screen.getByRole("button", { name: /retry Keychain check/i }),
    );
    expect(credentials).toHaveBeenCalledTimes(2);
  });
});
