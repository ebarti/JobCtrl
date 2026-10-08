import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { LocaleVariantCard } from "./MaterialLocaleVariants.js";
import { makeLocaleVariant } from "./MaterialLocaleVariants.stories.js";

describe("locale review accessibility", () => {
  it.each(["candidate", "accepted", "rejected"] as const)(
    "has no axe violations in %s state",
    async (status) => {
      const { container } = render(
        <LocaleVariantCard
          variant={makeLocaleVariant(status)}
          jobKey="job"
          pending={false}
          onReview={() => {}}
        />,
      );
      expect((await axe(container)).violations).toEqual([]);
    },
  );
});
