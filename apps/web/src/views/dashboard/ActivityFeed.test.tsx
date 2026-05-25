import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ActivityFeed } from "./ActivityFeed.js";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const baseActivity: DashboardSummary["activity"][number] = {
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

function makeActivity(index: number): DashboardSummary["activity"][number] {
  const suffix = String(index).padStart(2, "0");
  return {
    ...baseActivity,
    eventId: `evt-${suffix}`,
    message: `Activity event ${suffix}`,
    at: new Date(Date.UTC(2026, 4, 6, 7, 0, index)).toISOString(),
  };
}

function makeSummary(activityCount: number): DashboardSummary {
  return {
    ...sampleDashboardSummary,
    activity: Array.from({ length: activityCount }, (_, index) => makeActivity(index + 1)),
  };
}

describe("<ActivityFeed>", () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  it("renders recent activity as a paginated shared data grid without trimming rows", async () => {
    const user = userEvent.setup();
    const { container } = render(<ActivityFeed summary={makeSummary(60)} />);

    expect(screen.getByRole("table")).toHaveClass("filterable-data-grid-table");
    expect(screen.getByText("50 shown / 60 filtered / 60 loaded")).toBeInTheDocument();
    expect(screen.getByText("page 1 / 2 · 60 rows")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("Activity event 60")).toBeInTheDocument();
    expect(screen.queryByText("Activity event 01")).not.toBeInTheDocument();
    expect(container.querySelector("button.activity-row.clickable-row")).toBeNull();

    await user.click(screen.getByRole("button", { name: "next" }));

    expect(screen.getByText("10 shown / 60 filtered / 60 loaded")).toBeInTheDocument();
    expect(screen.getByText("Activity event 01")).toBeInTheDocument();
  });

  it("keeps activity detail navigation on pointer and keyboard row activation", async () => {
    const user = userEvent.setup();
    render(<ActivityFeed summary={makeSummary(1)} />);

    const activityRow = screen.getByText("Activity event 01").closest("tr");
    expect(activityRow).not.toBeNull();
    expect(activityRow).toHaveAttribute("tabindex", "0");

    await user.click(activityRow!);
    expect(navigateMock).toHaveBeenLastCalledWith({
      to: "/activity/$eventId",
      params: { eventId: "evt-01" },
    });

    navigateMock.mockClear();
    activityRow!.focus();
    await user.keyboard("{Enter}");

    expect(navigateMock).toHaveBeenLastCalledWith({
      to: "/activity/$eventId",
      params: { eventId: "evt-01" },
    });
  });
});
