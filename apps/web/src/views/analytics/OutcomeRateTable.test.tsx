import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { sampleOutcomeAnalyticsSummary } from "../../test/fixtures/projections.js";
import { outcomeRows } from "./DimensionBreakdownPanel.js";
import { OutcomeRateTable } from "./OutcomeRateTable.js";

describe("<OutcomeRateTable>", () => {
  it("shows count-only copy without percentages for below-threshold rows", () => {
    render(
      <OutcomeRateTable
        rows={outcomeRows(sampleOutcomeAnalyticsSummary, "fit_band")}
        loading={false}
      />,
    );

    const row = screen.getByText("stretch").closest("tr");
    expect(row).not.toBeNull();
    const scoped = within(row!);

    expect(scoped.getAllByText(/too few to rate/i).length).toBeGreaterThan(0);
    expect(scoped.getByText(/1 replies · n=1 · too few to rate/i)).toBeInTheDocument();
    expect(scoped.getByText("1 applied")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
    expect(scoped.getByText("1 replies")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
    expect(row).not.toHaveTextContent("100%");
  });

  it("renders rated rows with the rate and n adjacent", () => {
    render(
      <OutcomeRateTable
        rows={outcomeRows(sampleOutcomeAnalyticsSummary, "apply_mode")}
        loading={false}
      />,
    );

    const row = screen.getByText("automated live").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getAllByText("40% · n=5").length).toBeGreaterThan(0);
  });

  it("maps template and policy dimensions into rows", () => {
    const templateRows = outcomeRows(sampleOutcomeAnalyticsSummary, "template");
    const policyRows = outcomeRows(sampleOutcomeAnalyticsSummary, "policy");

    expect(templateRows.map((row) => row.label)).toContain("Modern compact");
    expect(policyRows.map((row) => row.label)).toContain("Policy v3");
  });

  it("keeps below-threshold rows last when sorting by a rate column", async () => {
    const user = userEvent.setup();
    render(
      <OutcomeRateTable
        rows={outcomeRows(sampleOutcomeAnalyticsSummary, "source")}
        loading={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sort by Reply rate/i }));

    const labels = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("th")?.textContent ?? "");
    expect(labels.at(-1)).toContain("lever");
  });
});
