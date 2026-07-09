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
});
