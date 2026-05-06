import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GenerateMaterialsButton } from "./GenerateMaterialsButton.js";

describe("<GenerateMaterialsButton>", () => {
  it("is disabled until the backend endpoint lands", () => {
    render(<GenerateMaterialsButton jobId="job-1" />);
    expect(screen.getByRole("button", { name: /generate materials/i })).toBeDisabled();
  });

  it("preserves the job id as a data attribute", () => {
    const { container } = render(<GenerateMaterialsButton jobId="job-42" />);
    const button = container.querySelector("button");
    expect(button?.getAttribute("data-job-id")).toBe("job-42");
  });
});
