import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleApplyReviewQueue } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { ApplyReviewDecisionControls } from "./ApplyReviewDecisionControls.js";

describe("<ApplyReviewDecisionControls>", () => {
  it("pairs semantic icons and colors with decision actions and the submit-gate status", () => {
    const item = sampleApplyReviewQueue.items[0]!;

    renderWithProviders(<ApplyReviewDecisionControls item={item} />);

    const getDecisionButton = (name: string) =>
      screen.getByRole("button", {
        name: new RegExp(`${name} for ${item.title}`, "i"),
      });
    const approveSubmitButton = getDecisionButton("Approve submit");
    const approveDryRunButton = getDecisionButton("Approve dry run");
    const deferButton = getDecisionButton("Defer");
    const declineButton = getDecisionButton("Decline");

    for (const button of [
      approveSubmitButton,
      approveDryRunButton,
      deferButton,
      declineButton,
    ]) {
      const icon = button.querySelector('svg[data-icon="inline-start"]');
      expect(icon).toHaveAttribute("aria-hidden", "true");
    }

    for (const approvalButton of [
      approveSubmitButton,
      approveDryRunButton,
    ]) {
      expect(approvalButton).toHaveClass(
        "bg-success",
        "text-success-foreground",
        "hover:bg-success/90",
        "focus-visible:ring-success",
      );
    }
    expect(deferButton).toHaveClass(
      "bg-warning",
      "text-warning-foreground",
      "hover:bg-warning/90",
      "focus-visible:ring-warning",
    );
    expect(declineButton).toHaveClass(
      "bg-destructive",
      "text-white",
      "hover:bg-destructive/90",
    );

    const submitGateStatus = screen
      .getByText("Submit gate: approval not recorded.")
      .closest('[role="status"]');
    expect(submitGateStatus).toHaveClass(
      "inline-flex",
      "items-center",
      "justify-end",
      "gap-1.5",
    );
    expect(
      submitGateStatus?.querySelector(".tabler-icon-lock"),
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps partial-evidence blocker icon and copy in one semantic row", () => {
    const item = {
      ...sampleApplyReviewQueue.items[0]!,
      approvalGate: {
        ...sampleApplyReviewQueue.items[0]!.approvalGate,
        dryRunEvidence: null,
        partialDryRunEvidence: {
          runId: "dry-run-partial",
          coverage: "partial" as const,
          finishedAt: "2026-05-06T06:35:00Z",
          blockedChannels: ["Document"],
        },
        reasons: ["awaiting_dry_run" as const],
      },
    };

    renderWithProviders(<ApplyReviewDecisionControls item={item} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Partial dry-run evidence only/i);
    expect(alert).toHaveClass(
      "inline-flex",
      "items-center",
      "justify-end",
      "gap-1.5",
    );
    expect(alert.querySelector(".tabler-icon-lock")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    const overrideButton = screen.getByRole("button", {
      name: new RegExp(
        `Approve with partial dry-run evidence for ${item.title}`,
        "i",
      ),
    });
    expect(
      overrideButton.querySelector('svg[data-icon="inline-start"]'),
    ).toHaveAttribute("aria-hidden", "true");
    expect(overrideButton).toHaveClass(
      "bg-success",
      "text-success-foreground",
      "hover:bg-success/90",
      "focus-visible:ring-success",
    );
  });

  it("distinguishes approval preparation guidance from a blocked gate", () => {
    const item = sampleApplyReviewQueue.items[0]!;

    renderWithProviders(
      <ApplyReviewDecisionControls
        approvalNotice="The saved draft will be rendered before approval."
        item={item}
      />,
    );

    const status = screen
      .getByText("The saved draft will be rendered before approval.")
      .closest('[role="status"]');
    expect(status?.querySelector(".tabler-icon-info-circle")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(status?.querySelector(".tabler-icon-lock")).not.toBeInTheDocument();
  });
});
