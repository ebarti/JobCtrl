import type {
  BrowserCapabilitiesResponse,
  BrowserCapabilityId,
  BrowserCapabilityItem,
} from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleExtensionCapabilityTokenResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { BrowserCapabilitiesPanel } from "./BrowserCapabilitiesPanel.js";
import { ExtensionPairingPanel } from "./ExtensionPairingPanel.js";

const disabledCapabilities: BrowserCapabilitiesResponse = {
  ok: true,
  capabilities: [
    {
      id: "core-browser",
      status: "ready",
      detail: "Managed browser ready.",
      mutable: false,
      enabled: true,
      profileCopyReady: false,
    },
    {
      id: "auto-apply-browser",
      status: "disabled",
      detail: "Disabled.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
    {
      id: "authenticated-linkedin-browser",
      status: "disabled",
      detail: "Disabled.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
  ],
};

function updateCapability(
  response: BrowserCapabilitiesResponse,
  capabilityId: BrowserCapabilityId,
  patch: Partial<BrowserCapabilityItem>,
): BrowserCapabilitiesResponse {
  return {
    ...response,
    capabilities: response.capabilities.map((capability) =>
      capability.id === capabilityId ? { ...capability, ...patch } : capability,
    ),
  };
}

describe("<BrowserCapabilitiesPanel>", () => {
  it("keeps every capability, status, detail, and control reachable through disclosures", async () => {
    const user = userEvent.setup();
    const ports = buildTestPorts({
      api: { browserCapabilities: vi.fn(async () => disabledCapabilities) },
    });

    renderWithProviders(<BrowserCapabilitiesPanel />, { ports });

    const panelTrigger = await screen.findByRole("button", { name: /^Browser capabilities/ });
    expect(panelTrigger).toHaveAttribute("aria-expanded", "true");
    expect(panelTrigger).toHaveAccessibleName(/Explicit adoption/i);
    expect(screen.getByText(/never auto-detects or adopts Chrome/i)).toBeInTheDocument();

    const coreTrigger = screen.getByRole("button", { name: /^Core managed browser/ });
    const autoApplyTrigger = screen.getByRole("button", { name: /^Auto-apply browser/ });
    const linkedInTrigger = screen.getByRole("button", {
      name: /^Authenticated LinkedIn browser/,
    });

    expect(coreTrigger).toHaveAccessibleName(/Managed browser ready.*Status: ready/i);
    expect(autoApplyTrigger).toHaveAccessibleName(/Disabled.*Status: disabled/i);
    expect(linkedInTrigger).toHaveAccessibleName(/Disabled.*Status: disabled/i);
    expect(coreTrigger).toHaveAttribute("aria-expanded", "false");
    expect(autoApplyTrigger).toHaveAttribute("aria-expanded", "false");
    expect(linkedInTrigger).toHaveAttribute("aria-expanded", "false");

    await user.click(coreTrigger);
    expect(screen.getByText("Current status: ready")).toBeInTheDocument();
    expect(screen.getByText("Managed by JobCtrl and read-only.")).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Enable selected browser" }),
    ).not.toBeInTheDocument();
    await user.click(autoApplyTrigger);
    expect(
      screen.getByRole("textbox", { name: "Chrome or Chromium executable path" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable selected browser" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disable now" })).toBeDisabled();
    expect(screen.getAllByText(/status API does not echo local paths/i)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });

  it("enables and hot-disables an optional browser from the explicit executable path", async () => {
    const user = userEvent.setup();
    let current = disabledCapabilities;
    const browserCapabilities = vi.fn(async () => current);
    const enableBrowserCapability = vi.fn(
      async (capabilityId: BrowserCapabilityId, _body: { executablePath: string }) => {
        current = updateCapability(current, capabilityId, {
          enabled: true,
          status: "ready",
          detail: "Explicit browser ready.",
        });
        return current;
      },
    );
    const disableBrowserCapability = vi.fn(async (capabilityId: BrowserCapabilityId) => {
      current = updateCapability(current, capabilityId, {
        enabled: false,
        status: "disabled",
        detail: "Disabled; browser access is revoked.",
      });
      return current;
    });
    const ports = buildTestPorts({
      api: {
        browserCapabilities,
        enableBrowserCapability,
        disableBrowserCapability,
      },
    });

    renderWithProviders(<BrowserCapabilitiesPanel />, { ports });

    await user.click(
      await screen.findByRole("button", { name: /^Auto-apply browser/ }),
    );
    const executablePath = screen.getByRole("textbox", {
      name: "Chrome or Chromium executable path",
    });
    await user.type(executablePath, "  /Applications/Chromium.app/Contents/MacOS/Chromium  ");
    await user.click(screen.getByRole("button", { name: "Enable selected browser" }));

    await waitFor(() =>
      expect(enableBrowserCapability).toHaveBeenCalledWith("auto-apply-browser", {
        executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Auto-apply browser enabled from the explicitly selected executable.",
    );
    expect(executablePath).toHaveValue("");

    const disableButton = screen.getByRole("button", { name: "Disable now" });
    await waitFor(() => expect(disableButton).toBeEnabled());
    await user.click(disableButton);

    expect(disableBrowserCapability).toHaveBeenCalledWith("auto-apply-browser");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Auto-apply browser disabled immediately.",
      ),
    );
  });

  it("requires a source path and separate consent before copying a LinkedIn profile", async () => {
    const user = userEvent.setup();
    let current = updateCapability(disabledCapabilities, "authenticated-linkedin-browser", {
      enabled: true,
      status: "ready",
      detail: "Explicit LinkedIn browser ready.",
    });
    const copyLinkedInBrowserProfile = vi.fn(
      async (_request: {
        sourceProfilePath: string;
        consent: true;
        consentMethod: "explicit-ui-v1";
      }) => {
        current = updateCapability(current, "authenticated-linkedin-browser", {
          profileCopyReady: true,
          detail: "Copied profile ready.",
        });
        return current;
      },
    );
    const ports = buildTestPorts({
      api: {
        browserCapabilities: vi.fn(async () => current),
        copyLinkedInBrowserProfile,
      },
    });

    renderWithProviders(<BrowserCapabilitiesPanel />, { ports });

    await user.click(
      await screen.findByRole("button", { name: /^Authenticated LinkedIn browser/ }),
    );
    const sourcePath = screen.getByLabelText("Existing browser profile directory");
    const consent = screen.getByRole("checkbox", {
      name: "I explicitly consent to copy this profile into JobCtrl-owned storage.",
    });
    const copyButton = screen.getByRole("button", { name: "Copy selected profile" });

    expect(sourcePath).toHaveAttribute("type", "password");
    expect(copyButton).toBeDisabled();
    await user.type(sourcePath, "  /Users/example/Library/Chrome/Profile 1  ");
    expect(copyButton).toBeDisabled();
    await user.click(consent);
    expect(copyButton).toBeEnabled();
    await user.click(copyButton);

    await waitFor(() =>
      expect(copyLinkedInBrowserProfile).toHaveBeenCalledWith({
        sourceProfilePath: "/Users/example/Library/Chrome/Profile 1",
        consent: true,
        consentMethod: "explicit-ui-v1",
      }),
    );
    await waitFor(() => {
      expect(sourcePath).toHaveValue("");
      expect(consent).not.toBeChecked();
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The selected profile was copied into JobCtrl-owned storage.",
    );
  });
});

describe("<ExtensionPairingPanel>", () => {
  it("preserves the visible pairing data and the copy then confirm-rotation flow", async () => {
    const user = userEvent.setup();
    const rotated = {
      ...sampleExtensionCapabilityTokenResponse,
      token: "jh_ext_rotated_token_123456789012345678901234567",
      created: true,
    };
    let currentToken = sampleExtensionCapabilityTokenResponse;
    const rotateExtensionCapabilityToken = vi.fn(async () => {
      currentToken = rotated;
      return rotated;
    });
    const ports = buildTestPorts({
      api: {
        extensionCapabilityToken: vi.fn(async () => currentToken),
        rotateExtensionCapabilityToken,
      },
    });

    renderWithProviders(<ExtensionPairingPanel />, { ports });

    expect(
      screen.getByRole("heading", { name: "Browser extension pairing", level: 2 }),
    ).toBeInTheDocument();
    const panelTrigger = screen.getByRole("button", { name: /^Browser extension pairing/ });
    const pairingRegion = screen.getByRole("region", {
      name: "Browser extension pairing controls",
    });
    expect(pairingRegion).toBeInTheDocument();
    expect(screen.getByText("Local capability token for extension API requests")).toBeInTheDocument();
    expect(screen.getByText("capture, autofill read")).toBeInTheDocument();

    await user.click(panelTrigger);
    expect(panelTrigger).toHaveAttribute("aria-expanded", "false");
    expect(pairingRegion.closest("[hidden]")).toBeInTheDocument();
    panelTrigger.focus();
    expect(panelTrigger).toHaveFocus();
    await user.click(panelTrigger);
    expect(panelTrigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "Browser extension pairing controls" }),
    ).toBe(pairingRegion);

    const tokenField = screen.getByLabelText("Extension capability token");
    await waitFor(() =>
      expect(tokenField).toHaveValue(sampleExtensionCapabilityTokenResponse.token),
    );
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(ports.clipboard.write).toHaveBeenCalledWith(sampleExtensionCapabilityTokenResponse.token);

    await user.click(screen.getByRole("button", { name: "Rotate token" }));
    expect(rotateExtensionCapabilityToken).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Confirm rotation below; existing extension pairing will disconnect.",
    );

    await user.click(screen.getByRole("button", { name: "Confirm rotate and disconnect" }));
    await waitFor(() => {
      expect(rotateExtensionCapabilityToken).toHaveBeenCalledTimes(1);
      expect(ports.clipboard.write).toHaveBeenLastCalledWith(rotated.token);
      expect(screen.getByRole("status")).toHaveTextContent("token rotated");
    });
  });
});
