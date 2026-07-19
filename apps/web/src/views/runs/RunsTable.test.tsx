import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeWorkflowRunsPage,
  sampleWorkflowRun,
  sampleWorkflowRunCompleted,
} from "../../test/fixtures/projections.js";
import { renderWithProviders } from "../../test/render.js";
import { RunsTable } from "./RunsTable.js";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

describe("<RunsTable>", () => {
  afterEach(() => setViewportWidth(1024));

  function renderTable(
    overrides: Partial<React.ComponentProps<typeof RunsTable>> = {},
  ) {
    return renderWithProviders(
      <RunsTable
        data={makeWorkflowRunsPage()}
        loading={false}
        sorting={[{ id: "started_at", desc: true }]}
        onSortingChange={() => undefined}
        page={1}
        pageSize={50}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onOpenRun={() => undefined}
        {...overrides}
      />,
    );
  }

  it("renders a row per workflow run with the status badge and Temporal deep-link", () => {
    renderTable();

    expect(screen.getByText(sampleWorkflowRun.title)).toBeInTheDocument();
    expect(
      screen.getByText(sampleWorkflowRunCompleted.title),
    ).toBeInTheDocument();

    const links = screen.getAllByRole("link", {
      name: /Open workflow .* in Temporal Web UI/i,
    });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(
      `http://127.0.0.1:8233/namespaces/default/workflows/${encodeURIComponent(
        sampleWorkflowRun.workflowId,
      )}`,
    );
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      screen.getByRole("button", {
        name: `Stop workflow run for ${sampleWorkflowRun.title}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: `Stop workflow run for ${sampleWorkflowRunCompleted.title}`,
      }),
    ).not.toBeInTheDocument();
  });

  it("renders the standing auto-apply loop as a visible operations run", () => {
    renderTable({
      data: makeWorkflowRunsPage([
        {
          ...sampleWorkflowRun,
          workflowId: "apply-auto-local",
          runId: "apply-auto-local",
          jobKey: "",
          title: "Standing apply loop",
          company: "Auto apply",
          status: "in_progress",
          dryRun: false,
        },
      ]),
    });

    expect(screen.getByText("Standing apply loop")).toBeInTheDocument();
    expect(screen.getByText(/Auto apply/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Stop workflow run for Standing apply loop",
      }),
    ).toBeInTheDocument();
  });

  it("invokes onOpenRun with the workflow id when a row is activated", async () => {
    const user = userEvent.setup();
    const onOpenRun = vi.fn();
    renderTable({ onOpenRun });

    const activationButton = screen.getByRole("button", {
      name: `Open run ${sampleWorkflowRun.title} ${sampleWorkflowRun.workflowId}`,
    });
    await user.click(activationButton);

    expect(onOpenRun).toHaveBeenCalledWith(sampleWorkflowRun.workflowId);
  });

  it("reports sortable column changes", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();
    renderTable({ onSortingChange });

    await user.click(screen.getByRole("button", { name: "Sort by Workflow" }));

    expect(onSortingChange).toHaveBeenCalledWith([
      { id: "title", desc: false },
    ]);
  });

  it("renders the loading state when no data has been fetched yet", () => {
    renderTable({ data: null, loading: true });
    expect(screen.getByText(/Loading workflow runs/i)).toBeInTheDocument();
  });

  it("renders the empty state with no items", () => {
    renderTable({
      data: {
        ok: true,
        items: [],
        pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
        sort: { field: "started_at", dir: "desc" },
        filter: {},
      },
    });
    expect(screen.getByText(/No workflow runs/i)).toBeInTheDocument();
  });

  it("shows workflow, status, start, duration, and actions in the mobile record", async () => {
    setViewportWidth(390);
    renderTable();

    const list = await screen.findByRole("list", { name: "Workflow runs" });
    const record = within(list)
      .getByText(sampleWorkflowRun.title)
      .closest("li");
    expect(record).not.toBeNull();
    const run = within(record as HTMLElement);
    expect(run.getByText("in progress")).toBeInTheDocument();
    expect(run.getByText(/Started/)).toBeInTheDocument();
    expect(run.getByText(/Duration/)).toBeInTheDocument();
    expect(
      run.getByRole("button", {
        name: `Stop workflow run for ${sampleWorkflowRun.title}`,
      }),
    ).toBeInTheDocument();
    expect(
      run.getByRole("button", {
        name: `Open run ${sampleWorkflowRun.title} ${sampleWorkflowRun.workflowId}`,
      }),
    ).not.toHaveClass("row-activation-focus-only");
  });
});
