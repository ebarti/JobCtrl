import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { PageHead } from "./page-head.js";

describe("PageHead accessibility", () => {
  it("has no axe violations with eyebrow, subtitle, and actions", async () => {
    const view = render(
      <main>
        <PageHead
          eyebrow="Pipeline"
          title="Jobs"
          subtitle="1,204 total"
          actions={<button type="button">New search</button>}
        />
      </main>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Jobs" })).toHaveAttribute(
      "data-typography",
      "page-title",
    );
    expect(
      screen.getByRole("navigation", { name: "breadcrumb" }),
    ).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no axe violations with only a title", async () => {
    const view = render(
      <main>
        <PageHead title="Pipelines" />
      </main>,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
