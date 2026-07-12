import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { expect, it, vi } from "vitest";

import { DemoConsentClient } from "./DemoConsentClient.js";
import { DemoConsentGate } from "./DemoConsentGate.js";

it("has no automated accessibility violations", async () => {
  const view = render(
    <DemoConsentGate
      client={new DemoConsentClient({
        fetcher: vi.fn() as unknown as typeof fetch,
        createOperationKey: () => "a".repeat(32),
      })}
      initialChoice="denied"
      onDeclined={vi.fn()}
      onGranted={vi.fn()}
    />,
  );

  expect(await axe(view.container)).toHaveNoViolations();
});
