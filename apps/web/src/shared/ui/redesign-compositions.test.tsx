import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdaptiveFieldGrid, AdaptiveFieldSpan } from "./adaptive-field-grid.js";
import { ChoiceControl } from "./choice-control.js";
import { DisclosureSection } from "./disclosure-section.js";
import { PreviewWorkbench } from "./preview-workbench.js";

describe("redesign compositions", () => {
  it("keeps disclosure content mounted while collapsed", () => {
    render(
      <DisclosureSection title="Tailoring controls" defaultOpen>
        <input aria-label="Additional guidance" defaultValue="Keep evidence explicit" />
      </DisclosureSection>,
    );

    const trigger = screen.getByRole("button", { name: /tailoring controls/i });
    const input = screen.getByRole("textbox", { name: "Additional guidance" });

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(input).toBeInTheDocument();
    expect(input.closest("[hidden]")).not.toBeNull();
  });

  it("associates a choice label and disabled reason with its control", () => {
    render(
      <ChoiceControl
        label="Change experience titles"
        disabledReason="Titles stay grounded in source evidence."
        disabled
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Change experience titles" });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAccessibleDescription("Titles stay grounded in source evidence.");
  });

  it("exposes adaptive spans without changing source order", () => {
    const { container } = render(
      <AdaptiveFieldGrid columns={4} minColumnWidth={180}>
        <div>First</div>
        <AdaptiveFieldSpan span="full">Second</AdaptiveFieldSpan>
      </AdaptiveFieldGrid>,
    );

    const grid = container.querySelector(".adaptive-field-grid");
    const gridContainer = container.querySelector(".adaptive-field-grid-container");
    expect(grid).toHaveAttribute("data-columns", "4");
    expect(gridContainer).toHaveStyle({ "--adaptive-field-min": "180px" });
    expect(screen.getByText("First").compareDocumentPosition(screen.getByText("Second"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("names the real document preview region", () => {
    const action = vi.fn();
    render(
      <PreviewWorkbench
        title="Resume template"
        previewLabel="Resume template preview"
        actions={<button onClick={action}>Save version</button>}
      >
        <article>Resume content</article>
      </PreviewWorkbench>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Resume template preview" })).toHaveTextContent(
      "Resume content",
    );
  });
});
