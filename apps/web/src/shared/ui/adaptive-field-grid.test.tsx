import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { Field, FieldLabel } from "./field.js";
import { Input } from "./input.js";
import { AdaptiveFieldGrid, AdaptiveFieldSpan } from "./adaptive-field-grid.js";

describe("<AdaptiveFieldGrid>", () => {
  it("preserves field source order and exposes named spans", () => {
    render(
      <AdaptiveFieldGrid data-testid="property-grid">
        <Field>
          <FieldLabel htmlFor="first-field">First field</FieldLabel>
          <Input id="first-field" />
        </Field>
        <AdaptiveFieldSpan span="wide">
          <Field>
            <FieldLabel htmlFor="second-field">Second field</FieldLabel>
            <Input id="second-field" />
          </Field>
        </AdaptiveFieldSpan>
        <AdaptiveFieldSpan span="full">
          <Field>
            <FieldLabel htmlFor="third-field">Third field</FieldLabel>
            <Input id="third-field" />
          </Field>
        </AdaptiveFieldSpan>
      </AdaptiveFieldGrid>,
    );

    const grid = screen.getByTestId("property-grid");
    expect(grid).toHaveAttribute("data-slot", "adaptive-field-grid");
    expect(
      within(grid)
        .getAllByRole("textbox")
        .map((control) => control.getAttribute("id")),
    ).toEqual(["first-field", "second-field", "third-field"]);
    expect(
      grid.querySelector('[data-slot="adaptive-field-span"][data-span="wide"]'),
    ).not.toBeNull();
    expect(
      grid.querySelector('[data-slot="adaptive-field-span"][data-span="full"]'),
    ).not.toBeNull();
  });

  it("defines four, two, and one-column behavior against the grid container", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/styles/redesign-configuration.css"),
      "utf8",
    );

    expect(css).toContain("container-name: adaptive-field-grid;");
    expect(css).toContain("container-type: inline-size;");
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(css).toContain("@container adaptive-field-grid (max-width: 56rem)");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain("@container adaptive-field-grid (max-width: 32rem)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr);");
  });
});
