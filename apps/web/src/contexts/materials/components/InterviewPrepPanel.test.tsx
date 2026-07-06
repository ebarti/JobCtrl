import type { ReactNode } from "react";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleInterviewPrep } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { InterviewPrepPanel } from "./InterviewPrepPanel.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
    className,
  }: {
    children: ReactNode;
    search: { entry?: string; job?: string; q?: string };
    to: string;
    className?: string;
  }) => {
    const params = new URLSearchParams();
    if (search.q !== undefined) params.set("q", search.q);
    if (search.entry !== undefined) params.set("entry", search.entry);
    if (search.job !== undefined) params.set("job", search.job);
    return (
      <a className={className} href={`${to}?${params.toString()}`}>
        {children}
      </a>
    );
  },
}));

describe("<InterviewPrepPanel>", () => {
  it("renders accepted prep items with evidence-map provenance links and source text", () => {
    renderWithProviders(<InterviewPrepPanel jobId="job-1" prep={sampleInterviewPrep} />);

    const region = screen.getByRole("region", { name: "Interview preparation" });
    expect(within(region).getByText("Platform reliability story")).toBeInTheDocument();
    expect(within(region).getByText("STAR draft")).toBeInTheDocument();
    const evidenceLink = within(region).getByRole("link", { name: "ev-api-latency" });
    expect(evidenceLink).toHaveAttribute(
      "href",
      "/evidence-map?q=&entry=ev-api-latency&job=job-1",
    );
    expect(within(region).getByText("Reduced API latency by 30% using Python services.")).toBeInTheDocument();
    expect(within(region).queryByText(/raw prompt/i)).not.toBeInTheDocument();
  });

  it("renders the explicit generate action when no prep has been accepted", () => {
    renderWithProviders(<InterviewPrepPanel jobId="job-1" prep={null} />);

    expect(screen.getByText("No interview prep generated.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "generate interview prep" })).toBeEnabled();
  });
});
