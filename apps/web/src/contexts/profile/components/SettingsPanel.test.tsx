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
import { SettingsPanel } from "./SettingsPanel.js";

describe("<SettingsPanel>", () => {
  it("renders Temporal activity concurrency from worker health", async () => {
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

    expect(await screen.findByText("Temporal runtime")).toBeInTheDocument();
    expect(screen.getByText("Activity slots")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Executor threads")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(
      screen.getByText("JOBHUNTER_MAX_CONCURRENT_ACTIVITIES"),
    ).toBeInTheDocument();
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

    renderWithProviders(<SettingsPanel />, { ports });

    expect(await screen.findByText("Browser extension pairing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "copy token" }));
    expect(ports.clipboard.write).toHaveBeenCalledWith(sampleExtensionCapabilityTokenResponse.token);

    await user.click(screen.getByRole("button", { name: "rotate token" }));
    expect(rotateExtensionCapabilityToken).toHaveBeenCalledTimes(1);
    expect(ports.clipboard.write).toHaveBeenLastCalledWith(
      "jh_ext_rotated_token_123456789012345678901234567",
    );
    expect(await screen.findByRole("status")).toHaveTextContent("token rotated");
  });
});
