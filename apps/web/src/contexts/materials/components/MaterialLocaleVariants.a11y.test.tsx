import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { buildProviderHarness } from "../../../test/render.js";
import { MaterialLocaleVariants } from "./MaterialLocaleVariants.js";
import { localeStoryState } from "./MaterialLocaleVariants.stories.js";

describe("MaterialLocaleVariants accessibility", () => {
  it.each(["candidate", "accepted", "refused"] as const)(
    "has no axe violations for %s",
    async (status) => {
      const harness = buildProviderHarness();
      const view = render(
        <MaterialLocaleVariants
          jobId="90000000-0000-4000-8000-000000000055"
          state={localeStoryState(status)}
        />,
        { wrapper: harness.Wrapper },
      );
      await screen.findByRole("heading", { name: "Reviewed locale variants" });
      expect(await axe(view.container)).toHaveNoViolations();
    },
  );
});
