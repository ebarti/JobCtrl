import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  sampleHealthResponse,
  sampleDiscoveryBrowserBridgeStatusResponse,
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
    expect(await screen.findByLabelText("Worker activity slots")).toHaveValue(4);
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

    await user.click(await screen.findByRole("button", { name: /^Browser extension\b/i }));
    expect(await screen.findByText("Live Chrome connection")).toBeInTheDocument();
    expect(screen.getByText("capture, autofill read, Discovery browser")).toHaveAttribute(
      "data-typography",
      "body",
    );
    expect(screen.getByText("Current Chrome profile; never copied")).toBeInTheDocument();
    expect(screen.getByText("Chrome installation …00000099")).toBeInTheDocument();
    expect(
      screen.getByText(/Saving this token in that profile selects its extension installation/),
    ).toBeInTheDocument();
    expect(screen.getByText("Connected in Chrome")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(ports.clipboard.write).toHaveBeenCalledWith(sampleExtensionCapabilityTokenResponse.token);

    await user.click(screen.getByRole("button", { name: "Rotate token" }));
    expect(rotateExtensionCapabilityToken).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm rotation and disconnect" }));
    expect(rotateExtensionCapabilityToken).toHaveBeenCalledTimes(1);
    expect(ports.clipboard.write).toHaveBeenLastCalledWith(
      "jh_ext_rotated_token_123456789012345678901234567",
    );
    expect(await screen.findByText("Token rotated")).toBeInTheDocument();
  });

  it("does not call a pairing token ready when the live Chrome extension is offline", async () => {
    const ports = buildTestPorts({
      api: {
        extensionCapabilityToken: vi.fn(
          async () => sampleExtensionCapabilityTokenResponse,
        ),
        discoveryBrowserBridgeStatus: vi.fn(async () => ({
          ...sampleDiscoveryBrowserBridgeStatusResponse,
          connected: false,
          lastSeenAt: null,
          extensionVersion: null,
        })),
      },
    });

    renderWithProviders(<ExtensionPairingPanel />, { ports });

    expect(await screen.findByText("Extension offline")).toBeInTheDocument();
    const disclosure = screen.getByRole("button", {
      name: /^Browser extension\b/i,
    });
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    await userEvent.click(disclosure);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open Chrome with the paired JobCtrl extension before running Discovery",
    );
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

    await user.click(await screen.findByRole("button", { name: /^Browser extension\b/i }));
    await user.click(
      await screen.findByRole("button", { name: "Rotate token" }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm rotation and disconnect" }));

    expect(await screen.findByText("Token rotated")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Token rotated, but automatic copy was unavailable. Use copy token to try again.",
    );
    expect(screen.getByLabelText("Extension capability token")).toHaveValue(
      "jh_ext_rotated_token_123456789012345678901234567",
    );
  });
});
