import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  makeWorkflowRunsPage,
  sampleWorkflowRun,
  sampleWorkflowRunCompleted,
} from "../../test/fixtures/projections.js";
import { RunsTable } from "./RunsTable.js";

describe("<RunsTable>", () => {
  function renderTable(overrides: Partial<React.ComponentProps<typeof RunsTable>> = {}) {
    return render(
      <RunsTable
        data={makeWorkflowRunsPage()}
        loading={false}
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
    expect(screen.getByText(sampleWorkflowRunCompleted.title)).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: /Open workflow .* in Temporal Web UI/i });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(
      `http://127.0.0.1:8233/namespaces/default/workflows/${encodeURIComponent(
        sampleWorkflowRun.workflowId,
      )}`,
    );
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("invokes onOpenRun with the workflow id when a row is activated", async () => {
    const onOpenRun = vi.fn();
    renderTable({ onOpenRun });

    // Activate the row by clicking the title cell (the link cell stops
    // propagation so it only opens the deep-link, not the row).
    const titleCell = screen.getByText(sampleWorkflowRun.title);
    titleCell.click();
    // DataTable wires `onRowActivate` to the row container, so simulate
    // the row click via the closest row element.
    const row = titleCell.closest("tr") ?? titleCell.closest(".data-row");
    if (row) {
      (row as HTMLElement).click();
    }
    expect(onOpenRun).toHaveBeenCalledWith(sampleWorkflowRun.workflowId);
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
});
