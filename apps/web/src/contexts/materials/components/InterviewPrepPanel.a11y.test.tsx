import type { ReactNode } from "react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { sampleInterviewPrep } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { InterviewPrepPanel } from "./InterviewPrepPanel.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

describe("<InterviewPrepPanel> a11y", () => {
  it("has no axe violations when populated", async () => {
    const view = renderWithProviders(
      <main>
        <InterviewPrepPanel jobId="job-1" prep={sampleInterviewPrep} />
      </main>,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
