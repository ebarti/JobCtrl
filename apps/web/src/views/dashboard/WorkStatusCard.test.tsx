import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { renderWithProviders } from "../../test/render.js";
import { WorkStatusCard } from "./WorkStatusCard.js";

describe("<WorkStatusCard>", () => {
  it("renders active and stuck work as one continuous two-cell ledger", () => {
    const { container } = renderWithProviders(
      <WorkStatusCard summary={sampleDashboardSummary} />,
    );

    const ledger = container.querySelector(".work-status-ledger");
    expect(ledger).toBeInTheDocument();
    expect(
      ledger?.querySelectorAll(":scope > .work-status-ledger__cell"),
    ).toHaveLength(2);
    expect(ledger?.querySelector(".card")).not.toBeInTheDocument();
    expect(screen.getByText("Active work")).toBeInTheDocument();
    expect(screen.getByText("Stuck work")).toBeInTheDocument();
    expect(
      screen.getByText("worker unavailable · stale over 2m 30s"),
    ).toBeInTheDocument();
  });
});
