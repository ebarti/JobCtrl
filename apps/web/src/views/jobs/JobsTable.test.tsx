import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { JobSummary } from "../../contexts/operations/types.js";
import {
  makeJobsPage,
  sampleJob,
  sampleSecondaryJob,
} from "../../test/fixtures/projections.js";
import { JobsTable } from "./JobsTable.js";

function renderJobsTable(
  jobs: readonly JobSummary[] = [
    {
      ...sampleJob,
      company: "Acme Corp",
      source: "LinkedIn",
      discoverySource: "jobspy:linkedin",
      postingSource: "greenhouse:acme",
      postingSourceUrl: "https://boards.greenhouse.io/acme/jobs/123",
    },
  ],
) {
  const sorting: SortingState = [{ id: "discovered_at", desc: true }];
  const rowSelection: RowSelectionState = {};
  return render(
    <JobsTable
      data={makeJobsPage(jobs)}
      loading={false}
      sorting={sorting}
      onSortingChange={() => {}}
      rowSelection={rowSelection}
      onRowSelectionChange={() => {}}
      allMatchingSelected={false}
      page={1}
      pageSize={50}
      onPageChange={() => {}}
      onPageSizeChange={() => {}}
      onOpenJob={() => {}}
    />,
  );
}

function makeJob(index: number): JobSummary {
  return {
    ...sampleJob,
    jobKey: `job-${index}`,
    title: `Job ${index}`,
    company: `Company ${index}`,
  };
}

function StatefulJobsTable({
  jobs,
  onOpenJob = () => {},
}: {
  jobs: readonly JobSummary[];
  onOpenJob?: (jobKey: string) => void;
}) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const sorting: SortingState = [{ id: "discovered_at", desc: true }];

  return (
    <JobsTable
      data={makeJobsPage(jobs)}
      loading={false}
      sorting={sorting}
      onSortingChange={() => {}}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
      allMatchingSelected={false}
      page={1}
      pageSize={50}
      onPageChange={() => {}}
      onPageSizeChange={() => {}}
      onOpenJob={onOpenJob}
    />
  );
}

function rowForTitle(title: string): HTMLTableRowElement {
  const row = screen.getByText(title).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLTableRowElement;
}

function hitboxForTitle(title: string): HTMLElement {
  const hitbox = screen
    .getByLabelText(`Select ${title}`)
    .closest(".row-check-hitbox");
  expect(hitbox).not.toBeNull();
  return hitbox as HTMLElement;
}

describe("<JobsTable>", () => {
  it("omits ordinary active lifecycle copy and labels real posting exceptions", () => {
    const unknownJob: JobSummary = {
      ...sampleSecondaryJob,
      jobKey: "job-unknown",
      title: "Unverified posting",
      activeState: "unknown",
    };
    const expiredJob: JobSummary = {
      ...sampleSecondaryJob,
      jobKey: "job-expired",
      title: "Expired posting",
      activeState: "expired",
    };

    renderJobsTable([sampleJob, unknownJob, expiredJob]);

    const activeTitleStack = screen
      .getByText(sampleJob.title)
      .closest('[data-slot="title-stack"]');
    expect(
      activeTitleStack?.querySelector('[data-slot="title-stack-secondary"]'),
    ).toBeNull();
    expect(activeTitleStack).not.toHaveTextContent(/^open$/i);
    expect(activeTitleStack).not.toHaveTextContent(/^active$/i);

    const unknownTitleStack = screen
      .getByText(unknownJob.title)
      .closest('[data-slot="title-stack"]');
    expect(
      unknownTitleStack?.querySelector('[data-slot="title-stack-secondary"]'),
    ).toBeNull();
    expect(unknownTitleStack).not.toHaveTextContent(/posting status unknown/i);
    const activationButton = rowForTitle(sampleJob.title).querySelector(
      ".data-grid-row-activation-button",
    );
    expect(activationButton).toHaveClass("row-activation-focus-only");
    expect(activationButton).not.toHaveClass("sr-only", "focus:not-sr-only");
    expect(activationButton).toHaveTextContent("View details");
    expect(activationButton).toHaveAttribute(
      "aria-label",
      `Open job ${sampleJob.title} at ${sampleJob.company}`,
    );
    expect(rowForTitle(expiredJob.title)).toHaveTextContent("Posting expired");
  });

  it("renders source as its own column instead of folding it into company", () => {
    renderJobsTable();

    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("posting greenhouse:acme")).toBeInTheDocument();
    expect(
      screen.getByText("discovered via jobspy:linkedin"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Acme Corp.*LinkedIn/)).not.toBeInTheDocument();
  });

  it("does not label a broad discovery board as the posting owner", () => {
    renderJobsTable([
      {
        ...sampleJob,
        source: "LinkedIn",
        discoverySource: "jobspy:linkedin",
        postingSource: "",
        postingSourceUrl: null,
      },
    ]);

    expect(screen.queryByText("posting LinkedIn")).not.toBeInTheDocument();
    expect(
      screen.getByText("discovered via jobspy:linkedin"),
    ).toBeInTheDocument();
  });

  it("renders state with internal stage context", () => {
    renderJobsTable([
      {
        ...sampleJob,
        currentStage: "discover",
        currentSubstage: "tailor",
        currentState: "pending",
      },
    ]);

    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("tailor stage")).toBeInTheDocument();
  });

  it("renders separate compensation scan columns", () => {
    renderJobsTable([sampleSecondaryJob]);

    expect(screen.getByText("Salary min (€ / year)")).toBeInTheDocument();
    expect(screen.getByText("Salary max (€ / year)")).toBeInTheDocument();
    expect(screen.getByText("Market (€ / year)")).toBeInTheDocument();
    expect(screen.getByText("Confidence")).toBeInTheDocument();
    expect(screen.getByText("Warnings")).toBeInTheDocument();
    expect(screen.getByText("70,000")).toBeInTheDocument();
    expect(screen.getByText("90,000")).toBeInTheDocument();
    expect(screen.getByText("112,000-142,000")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByText(/2 sources/i)).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
  });

  it("selects a row when clicking the checkbox cell hit area", async () => {
    const user = userEvent.setup();
    const openCalls: string[] = [];

    render(
      <StatefulJobsTable
        jobs={[sampleJob, sampleSecondaryJob]}
        onOpenJob={(jobKey) => openCalls.push(jobKey)}
      />,
    );

    await user.click(hitboxForTitle(sampleJob.title));

    expect(rowForTitle(sampleJob.title)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(rowForTitle(sampleSecondaryJob.title)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(openCalls).toEqual([]);
  });

  it("opens the job overlay when clicking visible row content", async () => {
    const user = userEvent.setup();
    const openCalls: string[] = [];

    render(
      <StatefulJobsTable
        jobs={[sampleJob, sampleSecondaryJob]}
        onOpenJob={(jobKey) => openCalls.push(jobKey)}
      />,
    );

    await user.click(screen.getByText(sampleJob.title));

    expect(openCalls).toEqual([sampleJob.jobKey]);
    expect(rowForTitle(sampleJob.title)).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("shift-selects the visible range between the anchor row and target row", async () => {
    const user = userEvent.setup();
    const jobs = [makeJob(1), makeJob(2), makeJob(3), makeJob(4)];

    render(<StatefulJobsTable jobs={jobs} />);

    await user.click(hitboxForTitle("Job 1"));
    fireEvent.click(hitboxForTitle("Job 4"), { shiftKey: true });

    for (const job of jobs) {
      expect(rowForTitle(job.title)).toHaveAttribute("aria-selected", "true");
    }
  });
});
