import type { BrowserCapabilitiesResponse } from "@jobctrl/contracts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

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
      detail: "Disabled; select an executable to adopt this capability.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
    {
      id: "authenticated-linkedin-browser",
      status: "disabled",
      detail: "Disabled; authenticated profile access has not been adopted.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
  ],
};

const authenticatedProfileReady: BrowserCapabilitiesResponse = {
  ...disabledCapabilities,
  capabilities: disabledCapabilities.capabilities.map((capability) =>
    capability.id === "authenticated-linkedin-browser"
      ? {
          ...capability,
          status: "ready" as const,
          detail: "Explicit LinkedIn browser ready; profile copy requires separate consent.",
          enabled: true,
        }
      : capability,
  ),
};

function browserCapabilitiesHandler(response: BrowserCapabilitiesResponse) {
  return http.get("*/v1/browser-capabilities", () => HttpResponse.json(response));
}

const meta = {
  title: "Contexts/Operations/BrowserCapabilitiesPanel",
  component: BrowserCapabilitiesPanel,
} satisfies Meta<typeof BrowserCapabilitiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    msw: { handlers: [browserCapabilitiesHandler(disabledCapabilities)] },
  },
};

export const AuthenticatedProfileReady: Story = {
  parameters: {
    msw: {
      handlers: [
        browserCapabilitiesHandler(authenticatedProfileReady),
        http.post(
          "*/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy",
          () => HttpResponse.json(authenticatedProfileReady),
        ),
      ],
    },
  },
};

export const BrowserSettings: Story = {
  render: () => (
    <div className="settings-browser-sections">
      <BrowserCapabilitiesPanel />
      <ExtensionPairingPanel />
    </div>
  ),
  parameters: {
    msw: { handlers: [browserCapabilitiesHandler(disabledCapabilities)] },
  },
};
