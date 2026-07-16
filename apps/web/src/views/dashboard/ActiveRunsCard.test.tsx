import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleWorkflowRun } from "../../test/fixtures/projections.js";
import { renderWithProviders } from "../../test/render.js";
import { ActiveRunsCard } from "./ActiveRunsCard.js";

describe("ActiveRunsCard", () => {
  it("labels its bounded list honestly when more than one page of runs is supplied", async () => {
    const runs = Array.from({ length: 13 }, (_, index) => ({
      ...sampleWorkflowRun,
      workflowId: `workflow-${index}`,
      runId: `run-${index}`,
      title: `Workflow ${index}`,
    }));

    renderWithProviders(
      <ActiveRunsCard runs={runs} loading={false} error={null} />,
      { withRouter: true },
    );

    expect(await screen.findByText("8 shown")).toBeInTheDocument();
    expect(await screen.findAllByRole("button")).toHaveLength(8);
    expect(screen.queryByText("13 active")).not.toBeInTheDocument();
  });

  it.each([
    ["starting", "clock"],
    ["in_progress", "clock"],
    ["canceled", "ban"],
    ["terminated", "ban"],
  ] as const)("uses the domain-specific icon for %s runs", async (status, iconName) => {
    renderWithProviders(
      <ActiveRunsCard
        runs={[{ ...sampleWorkflowRun, status }]}
        loading={false}
        error={null}
      />,
      { withRouter: true },
    );

    const label = status.replaceAll("_", " ");
    expect((await screen.findByText(label)).querySelector("svg")).toHaveClass(
      `tabler-icon-${iconName}`,
    );
  });

  it("marks read failures with a semantic alert icon", async () => {
    renderWithProviders(
      <ActiveRunsCard runs={[]} loading={false} error="runs unavailable" />,
      { withRouter: true },
    );

    const alert = (await screen.findByText("Active runs unavailable")).closest(
      '[data-slot="alert"]',
    );
    expect(alert?.querySelector("svg.tabler-icon-alert-triangle")).toBeInTheDocument();
  });
});
