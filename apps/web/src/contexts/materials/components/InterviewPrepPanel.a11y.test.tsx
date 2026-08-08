import type { ReactNode } from "react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";

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
    const user = userEvent.setup();
    const view = renderWithProviders(
      <main>
        <InterviewPrepPanel
          jobId="job-1"
          prep={sampleInterviewPrep}
          requirements={[
            {
              id: "req-platform",
              text: "Own reliable API platforms across multiple teams",
              tier: "must_have",
              weight: 0.9,
              evidence_span: "Own our API platform reliability program",
              coverage_scope: "resume",
            },
          ]}
          resolveEvidenceReference={(evidenceId) => ({
            entryId: evidenceId,
            title: "Reduced API latency for critical services",
            excerpt: "Cut p95 latency by 30% across Python services.",
          })}
        />
      </main>,
    );

    await user.click(
      view.getByRole("button", { name: "Technical details" }),
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
