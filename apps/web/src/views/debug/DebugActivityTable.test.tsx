import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { SortingState } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import type { ActivityEventSummary } from "../../contexts/operations/types.js";
import { makeActivityPage } from "../../test/fixtures/projections.js";
import { DebugActivityTable } from "./DebugActivityTable.js";

const baseActivity: ActivityEventSummary = {
  eventId: "evt-0",
  eventType: "JobScored",
  jobKey: "job-1",
  title: "Staff Software Engineer",
  company: "Acme Corp",
  stage: "score",
  level: "info",
  message: "Job scored 8/10",
  at: "2026-05-06T07:00:00Z",
};

function makeActivity(index: number): ActivityEventSummary {
  const suffix = String(index).padStart(2, "0");
  return {
    ...baseActivity,
    eventId: `evt-${suffix}`,
    message: `Activity event ${suffix}`,
    at: new Date(Date.UTC(2026, 4, 6, 7, 0, index)).toISOString(),
  };
}

function renderTable(overrides: Partial<React.ComponentProps<typeof DebugActivityTable>> = {}) {
  return render(
    <DebugActivityTable
      data={makeActivityPage(
        Array.from({ length: 50 }, (_, index) => makeActivity(index + 11)),
        1,
        50,
        60,
      )}
      loading={false}
      sorting={[{ id: "occurred_at", desc: true }] satisfies SortingState}
      onSortingChange={vi.fn()}
      page={1}
      pageSize={50}
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
      onOpenActivity={vi.fn()}
      {...overrides}
    />,
  );
}

describe("<DebugActivityTable>", () => {
  it("uses server pagination metadata instead of loading every activity event", () => {
    renderTable();

    expect(screen.getByRole("table")).toHaveClass("filterable-data-grid-table");
    expect(screen.getByText("50 shown / 60 total")).toBeInTheDocument();
    expect(screen.getByText("page 1 / 2 · 60 rows")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("Activity event 60")).toBeInTheDocument();
    expect(screen.queryByText("Activity event 01")).not.toBeInTheDocument();
  });

  it("opens the selected activity from pointer and keyboard row activation", async () => {
    const user = userEvent.setup();
    const onOpenActivity = vi.fn();
    renderTable({
      data: makeActivityPage([makeActivity(1)]),
      onOpenActivity,
    });

    const activityRow = screen.getByText("Activity event 01").closest("tr");
    expect(activityRow).not.toBeNull();
    expect(activityRow).toHaveAttribute("tabindex", "0");

    await user.click(activityRow!);
    expect(onOpenActivity).toHaveBeenLastCalledWith("evt-01");

    onOpenActivity.mockClear();
    activityRow!.focus();
    await user.keyboard("{Enter}");

    expect(onOpenActivity).toHaveBeenLastCalledWith("evt-01");
  });
});
