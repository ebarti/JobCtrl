import type { CredentialsResponse } from "@jobctrl/contracts";
import { waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { sampleCredentialsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

function responseFor(
  state: "absent" | "inspection_failed" | "present" | "unsupported",
): CredentialsResponse {
  const unavailableReason =
    state === "unsupported"
      ? "unsupported_platform"
      : state === "inspection_failed"
        ? "inspection_failed"
        : null;
  const configured =
    state === "present" ? true : state === "absent" ? false : null;
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
    })),
  };
}

describe("<CredentialsPanel> a11y", () => {
  it.each(["present", "absent", "unsupported", "inspection_failed"] as const)(
    "has no axe violations in the %s state",
    async (state) => {
      const view = renderWithProviders(<CredentialsPanel />, {
        ports: buildTestPorts({
          api: { credentials: vi.fn(async () => responseFor(state)) },
        }),
      });
      await waitFor(() =>
        expect(view.container.querySelector("form")).not.toBeNull(),
      );

      expect(await axe(view.container)).toHaveNoViolations();
    },
  );
});
