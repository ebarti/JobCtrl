import { describe, expect, it } from "vitest";

import { makeGateResultsBlocked, makeGateResultsPassing } from "../../../test/fixtures/outreach.js";
import { renderWithProviders } from "../../../test/render.js";
import { DraftGateResultsPanel } from "./DraftGateResultsPanel.js";

describe("<DraftGateResultsPanel>", () => {
  it("shows the passed banner and no fabrications for a passing gate", () => {
    const view = renderWithProviders(
      <DraftGateResultsPanel gateResults={makeGateResultsPassing()} />,
    );
    expect(view.getByText("Truthfulness gates passed")).toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(view.getByText("Truthfulness gates passed")).toHaveAttribute(
      "data-status-tone",
      "ok",
    );
    expect(
      view.getByText("No fabricated claims detected in the generated text."),
    ).toBeInTheDocument();
  });

  it("renders every failing field for a blocked gate without hiding it", () => {
    const view = renderWithProviders(
      <DraftGateResultsPanel gateResults={makeGateResultsBlocked()} />,
    );
    expect(view.getByText("Truthfulness gates blocked this draft")).toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(view.getByText("Truthfulness gates blocked this draft")).toHaveAttribute(
      "data-status-tone",
      "danger",
    );
    // The deterministic fabrication finding is surfaced with its control, token,
    // and the offending generated text (auditability discipline: never hide it).
    expect(view.getByText("never_fabricate_metrics")).toBeInTheDocument();
    expect(view.getByText("40% faster")).toBeInTheDocument();
    expect(
      view.getByText("I led a project that made the pipeline 40% faster."),
    ).toBeInTheDocument();
    // Validator error and judge blocker are shown too.
    expect(view.getByText("Claim not grounded in any confirmed fact.")).toBeInTheDocument();
    expect(view.getByText("Fabricated performance metric.")).toBeInTheDocument();
  });
});
