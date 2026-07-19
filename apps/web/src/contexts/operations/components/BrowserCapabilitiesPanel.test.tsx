import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { BrowserCapabilitiesPanel } from "./BrowserCapabilitiesPanel.js";

describe("<BrowserCapabilitiesPanel>", () => {
  it("detects Chrome without enabling it and keeps the managed browser read-only", async () => {
    const enableBrowserCapability = vi.fn();
    renderWithProviders(<BrowserCapabilitiesPanel />, {
      ports: buildTestPorts({ api: { enableBrowserCapability } }),
    });

    expect(await screen.findByText("Core managed browser")).toBeInTheDocument();
    expect(
      screen.getAllByText(/nothing is enabled or launched until you confirm/i),
    ).toHaveLength(3);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Enable Google Chrome" }),
    ).toHaveLength(2);
    expect(
      screen.queryByLabelText(/Chrome or Chromium executable path/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /download/i }),
    ).not.toBeInTheDocument();
    expect(enableBrowserCapability).not.toHaveBeenCalled();
  });

  it("enables only the detected browser explicitly confirmed by the user", async () => {
    const user = userEvent.setup();
    const enableBrowserCapability = vi.fn();
    renderWithProviders(<BrowserCapabilitiesPanel />, {
      ports: buildTestPorts({ api: { enableBrowserCapability } }),
    });

    const heading = await screen.findByRole("heading", {
      name: "Authenticated LinkedIn browser",
    });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    await user.click(
      within(card as HTMLElement).getByRole("button", {
        name: "Enable Google Chrome",
      }),
    );

    expect(enableBrowserCapability).toHaveBeenCalledOnce();
    expect(enableBrowserCapability).toHaveBeenCalledWith(
      "authenticated-linkedin-browser",
      { detectedBrowserId: "google-chrome" },
    );
  });

  it("keeps a rejected manual path visible and shows the validation reason inline", async () => {
    const user = userEvent.setup();
    const enableBrowserCapability = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "The selected executable did not identify itself as Chrome or Chromium.",
        ),
      );
    renderWithProviders(<BrowserCapabilitiesPanel />, {
      ports: buildTestPorts({ api: { enableBrowserCapability } }),
    });

    const heading = await screen.findByRole("heading", {
      name: "Auto-apply browser",
    });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);
    await user.click(
      scope.getByRole("button", {
        name: /advanced browser path/i,
      }),
    );
    const input = scope.getByLabelText("Chrome or Chromium executable path");
    await user.type(input, "/Applications/Safari.app");
    await user.click(
      scope.getByRole("button", { name: "Enable manual browser" }),
    );

    expect(await scope.findByRole("alert")).toHaveTextContent(
      /did not identify itself as Chrome or Chromium/i,
    );
    expect(input).toHaveValue("/Applications/Safari.app");
  });

  it("requires separate consent before copying an authenticated profile", async () => {
    const user = userEvent.setup();
    const copyLinkedInBrowserProfile = vi.fn();
    const browserCapabilities = vi.fn(async () => ({
      ok: true as const,
      detectedBrowsers: [
        { id: "google-chrome" as const, label: "Google Chrome" },
      ],
      capabilities: [
        {
          id: "core-browser" as const,
          status: "ready" as const,
          detail: "Managed browser ready.",
          mutable: false,
          enabled: true,
          profileCopyReady: false,
        },
        {
          id: "auto-apply-browser" as const,
          status: "disabled" as const,
          detail: "Disabled.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
        {
          id: "authenticated-linkedin-browser" as const,
          status: "ready" as const,
          detail: "Browser access is enabled.",
          mutable: true,
          enabled: true,
          profileCopyReady: false,
        },
      ],
    }));
    renderWithProviders(<BrowserCapabilitiesPanel />, {
      ports: buildTestPorts({
        api: { browserCapabilities, copyLinkedInBrowserProfile },
      }),
    });

    const source = await screen.findByLabelText(
      "Existing browser profile directory",
    );
    const consent = screen.getByRole("checkbox", {
      name: /I explicitly consent to copy this profile/i,
    });
    const copy = screen.getByRole("button", {
      name: "Copy selected profile",
    });

    expect(copy).toBeDisabled();
    await user.type(source, "/synthetic/chrome-profile");
    expect(copy).toBeDisabled();
    await user.click(consent);
    expect(copy).toBeEnabled();
    await user.click(copy);

    await waitFor(() =>
      expect(copyLinkedInBrowserProfile).toHaveBeenCalledOnce(),
    );
    expect(copyLinkedInBrowserProfile).toHaveBeenCalledWith({
      sourceProfilePath: "/synthetic/chrome-profile",
      consent: true,
      consentMethod: "explicit-ui-v1",
    });
  });

  it("distinguishes managed, optional, and consent-required access", async () => {
    const { container } = renderWithProviders(<BrowserCapabilitiesPanel />);

    expect(await screen.findByText("Managed by JobCtrl")).toBeInTheDocument();
    expect(screen.getByText("Optional browser access")).toBeInTheDocument();
    expect(
      screen.getByText("Optional access · separate consent for profile copy"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-browser-capability="core-browser"]'),
    ).toHaveAttribute("data-browser-access", "managed");
    expect(
      container.querySelector(
        '[data-browser-capability="authenticated-linkedin-browser"]',
      ),
    ).toHaveAttribute("data-browser-access", "consent");
  });
});
