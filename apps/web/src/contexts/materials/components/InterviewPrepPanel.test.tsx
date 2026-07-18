import type { EmployerAnalysisRequirement } from "@jobctrl/contracts";
import type { ReactNode } from "react";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleInterviewPrep } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { InterviewPrepPanel } from "./InterviewPrepPanel.js";

const interviewRequirements: readonly EmployerAnalysisRequirement[] = [
  {
    id: "req-platform",
    text: "Own reliable API platforms across multiple teams",
    tier: "must_have",
    weight: 0.9,
    evidence_span: "Own our API platform reliability program",
  },
];

const resolveEvidenceReference = (evidenceId: string) =>
  evidenceId === "ev-api-latency"
    ? {
        entryId: "profile-api-latency",
        title: "Reduced API latency for critical services",
        excerpt: "Cut p95 latency by 30% across Python services.",
      }
    : null;

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
  it("renders accepted prep items with human-readable provenance and technical IDs", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <InterviewPrepPanel
        jobId="job-1"
        prep={sampleInterviewPrep}
        requirements={interviewRequirements}
        resolveEvidenceReference={resolveEvidenceReference}
      />,
    );

    const region = screen.getByRole("region", { name: "Interview preparation" });
    expect(within(region).getByText("Platform reliability story")).toBeInTheDocument();
    expect(within(region).getByText("STAR draft")).toHaveClass("tag", "info");
    expect(within(region).getByText("STAR draft")).not.toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(within(region).getByText("gate passed")).toHaveAttribute(
      "data-status-tone",
      "ok",
    );
    expect(within(region).getByText("gate passed").querySelector("svg")).toHaveClass(
      "tabler-icon-circle-check",
    );
    expect(within(region).getByText("grounded")).toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(within(region).getByText("generation 1")).toHaveClass("tag", "muted");
    expect(within(region).getByText("gpt-test")).toHaveClass("tag", "muted");
    const evidenceLink = within(region).getByRole("link", {
      name: "Reduced API latency for critical services",
    });
    expect(evidenceLink).toHaveAttribute(
      "href",
      "/evidence-map?q=&entry=profile-api-latency&job=job-1",
    );
    expect(
      within(region).getByText("Cut p95 latency by 30% across Python services."),
    ).toBeInTheDocument();
    expect(
      within(region).getByText("Own reliable API platforms across multiple teams"),
    ).toBeInTheDocument();
    expect(within(region).getByText("Reduced API latency by 30% using Python services.")).toBeInTheDocument();
    expect(within(region).queryByText("ev-api-latency")).not.toBeInTheDocument();
    expect(within(region).queryByText("req-platform")).not.toBeInTheDocument();
    expect(within(region).queryByText(/raw prompt/i)).not.toBeInTheDocument();

    await user.click(
      within(region).getByRole("button", { name: "Technical details" }),
    );

    expect(within(region).getByText("ev-api-latency")).toBeInTheDocument();
    expect(within(region).getByText("req-platform")).toBeInTheDocument();
  });

  it("keeps unresolved identifiers inspectable without using them as labels", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <InterviewPrepPanel
        jobId="job-1"
        prep={sampleInterviewPrep}
        requirements={[]}
        resolveEvidenceReference={() => null}
      />,
    );

    const region = screen.getByRole("region", { name: "Interview preparation" });
    expect(
      within(region).getByText("Evidence reference unavailable."),
    ).toBeInTheDocument();
    expect(
      within(region).getByText("Requirement reference unavailable."),
    ).toBeInTheDocument();
    expect(within(region).queryByText("ev-api-latency")).not.toBeInTheDocument();
    expect(within(region).queryByText("req-platform")).not.toBeInTheDocument();

    await user.click(
      within(region).getByRole("button", { name: "Technical details" }),
    );

    expect(within(region).getByText("ev-api-latency")).toBeInTheDocument();
    expect(within(region).getByText("req-platform")).toBeInTheDocument();
  });

  it("renders the explicit generate action when no prep has been accepted", () => {
    renderWithProviders(<InterviewPrepPanel jobId="job-1" prep={null} />);

    expect(screen.getByText("No interview prep generated.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate interview prep" })).toBeEnabled();
  });

  it("renders accepted residual warnings as semantic alerts", () => {
    const prep = {
      ...sampleInterviewPrep,
      gateAudit: {
        ...sampleInterviewPrep.gateAudit,
        warnings: ["Review the overall framing."],
      },
      items: sampleInterviewPrep.items.map((item) => ({
        ...item,
        warnings: ["Keep the metric tied to its source."],
      })),
    };

    renderWithProviders(<InterviewPrepPanel jobId="job-1" prep={prep} />);

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert).toHaveTextContent("Accepted residual warnings");
      expect(alert.querySelector("svg")).toHaveClass(
        "tabler-icon-alert-triangle",
      );
    }
    expect(screen.getByText("Review the overall framing.")).toBeInTheDocument();
    expect(
      screen.getByText("Keep the metric tied to its source."),
    ).toBeInTheDocument();
  });
});
