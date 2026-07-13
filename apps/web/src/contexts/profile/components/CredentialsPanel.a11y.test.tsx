import type { CredentialsResponse } from "@jobctrl/contracts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import {
  sampleCredentialsResponse,
  sampleProviderStatusResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

function responseFor(
  state: "absent" | "environment" | "inspection_failed" | "present" | "unsupported",
): CredentialsResponse {
  const unavailableReason =
    state === "unsupported"
      ? "unsupported_platform"
      : state === "inspection_failed"
        ? "inspection_failed"
        : null;
  const configured = state === "present" || state === "environment"
    ? true
    : state === "absent"
      ? false
      : null;
  return {
    ...sampleCredentialsResponse,
    store: {
      ...sampleCredentialsResponse.store,
      available: unavailableReason === null,
      unavailableReason,
    },
    credentials: sampleCredentialsResponse.credentials.map((credential) => ({
      ...credential,
      configured,
      effectiveSource:
        state === "present"
          ? "keychain"
          : state === "environment"
            ? "environment"
            : state === "absent"
              ? "absent"
              : "inspection_unknown",
      editable: unavailableReason === null && state !== "environment",
    })),
  };
}

describe("<CredentialsPanel> a11y", () => {
  it.each(["present", "absent", "environment", "unsupported", "inspection_failed"] as const)(
    "has no axe violations in the %s state",
    async (state) => {
      const view = renderWithProviders(<CredentialsPanel />, {
        ports: buildTestPorts({
          api: {
            credentials: vi.fn(async () => responseFor(state)),
            providerStatus: vi.fn(async () => sampleProviderStatusResponse),
          },
        }),
      });
      await screen.findByRole("heading", { name: "LLM providers" });
      expect(await axe(view.container)).toHaveNoViolations();
    },
  );

  it.each(["Claude", "Google"] as const)(
    "has no axe violations in the open %s removal confirmation",
    async (provider) => {
      const user = userEvent.setup();
      renderWithProviders(<CredentialsPanel />, {
        ports: buildTestPorts({
          api: {
            credentials: vi.fn(async () => responseFor("present")),
            providerStatus: vi.fn(async () => sampleProviderStatusResponse),
          },
        }),
      });
      await user.click(
        await screen.findByRole("button", { name: `Remove ${provider} setup` }),
      );
      await screen.findByRole("dialog", { name: `Remove ${provider} provider setup?` });

      expect(await axe(document.body)).toHaveNoViolations();
    },
  );
});
