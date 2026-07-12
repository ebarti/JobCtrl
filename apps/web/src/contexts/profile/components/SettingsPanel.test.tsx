import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  sampleHealthResponse,
  sampleExtensionCapabilityTokenResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ExtensionPairingPanel } from "../../operations/components/ExtensionPairingPanel.js";
import { SettingsPanel } from "./SettingsPanel.js";

describe("<SettingsPanel>", () => {
  it("renders concise desired and active capacity from settings and worker health", async () => {
    renderWithProviders(<SettingsPanel />, {
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          health: vi.fn(async () => ({
            ...sampleHealthResponse,
            worker: {
              ...sampleHealthResponse.worker,
              heartbeat: {
                ...sampleHealthResponse.worker.heartbeat!,
                maxConcurrentActivities: 12,
                activityExecutorMaxWorkers: 14,
              },
            },
          })),
        },
      }),
    });

    expect(await screen.findByText("Cost and capacity")).toBeInTheDocument();
    expect(screen.getByLabelText("Worker activity slots")).toHaveValue(4);
    expect(screen.getByText(/Desired: 4. Active: 12./)).toHaveTextContent("Restart pending");
    expect(screen.queryByText("Executor threads")).not.toBeInTheDocument();
    expect(screen.queryByText("Task queue")).not.toBeInTheDocument();
    expect(screen.queryByText("JOBCTRL_MAX_CONCURRENT_ACTIVITIES")).not.toBeInTheDocument();
    expect(screen.queryByText("Token file")).not.toBeInTheDocument();
  });

  it("copies and rotates the browser extension pairing token through ports", async () => {
    const user = userEvent.setup();
    const extensionCapabilityToken = vi.fn(async () => sampleExtensionCapabilityTokenResponse);
    const rotateExtensionCapabilityToken = vi.fn(async () => ({
      ...sampleExtensionCapabilityTokenResponse,
      token: "jh_ext_rotated_token_123456789012345678901234567",
      created: true,
    }));
    const ports = buildTestPorts({
      api: {
        settings: vi.fn(async () => sampleSettingsResponse),
        health: vi.fn(async () => sampleHealthResponse),
        extensionCapabilityToken,
        rotateExtensionCapabilityToken,
      },
    });

    renderWithProviders(<ExtensionPairingPanel />, { ports });

    expect(await screen.findByText("Browser extension pairing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "copy token" }));
    expect(ports.clipboard.write).toHaveBeenCalledWith(sampleExtensionCapabilityTokenResponse.token);

    await user.click(screen.getByRole("button", { name: "rotate token" }));
    expect(rotateExtensionCapabilityToken).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "confirm rotate and disconnect" }));
    expect(rotateExtensionCapabilityToken).toHaveBeenCalledTimes(1);
    expect(ports.clipboard.write).toHaveBeenLastCalledWith(
      "jh_ext_rotated_token_123456789012345678901234567",
    );
    expect(await screen.findByRole("status")).toHaveTextContent("token rotated");
  });

  it("keeps a successful rotation visible when automatic clipboard copy is denied", async () => {
    const user = userEvent.setup();
    const rotated = {
      ...sampleExtensionCapabilityTokenResponse,
      token: "jh_ext_rotated_token_123456789012345678901234567",
      created: true,
    };
    let currentToken = sampleExtensionCapabilityTokenResponse;
    const ports = buildTestPorts({
      api: {
        settings: vi.fn(async () => sampleSettingsResponse),
        health: vi.fn(async () => sampleHealthResponse),
        extensionCapabilityToken: vi.fn(async () => currentToken),
        rotateExtensionCapabilityToken: vi.fn(async () => {
          currentToken = rotated;
          return rotated;
        }),
      },
    });
    vi.spyOn(ports.clipboard, "write").mockRejectedValue(
      new Error("clipboard permission denied"),
    );

    renderWithProviders(<ExtensionPairingPanel />, { ports });

    await user.click(
      await screen.findByRole("button", { name: "rotate token" }),
    );
    await user.click(screen.getByRole("button", { name: "confirm rotate and disconnect" }));

    expect(await screen.findByRole("status")).toHaveTextContent("token rotated");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Token rotated, but automatic copy was unavailable. Use copy token to try again.",
    );
    expect(screen.getByLabelText("Extension capability token")).toHaveValue(
      "jh_ext_rotated_token_123456789012345678901234567",
    );
  });
});
