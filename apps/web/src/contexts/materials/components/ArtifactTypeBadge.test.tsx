import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactTypeBadge } from "./ArtifactTypeBadge.js";

describe("<ArtifactTypeBadge>", () => {
  it("renders the kind and format labels for resume_pdf", () => {
    const { container } = render(<ArtifactTypeBadge artifactType="resume_pdf" />);
    const root = container.querySelector("span.artifact-type");
    expect(root?.getAttribute("data-artifact-type")).toBe("resume_pdf");
  });
});
