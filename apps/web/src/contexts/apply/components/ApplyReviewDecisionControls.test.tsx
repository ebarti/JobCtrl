import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleApplyReviewQueue } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { ApplyReviewDecisionControls } from "./ApplyReviewDecisionControls.js";

describe("<ApplyReviewDecisionControls>", () => {
  it("makes live-submit authorization the sole primary action when it is available", () => {
    const item = sampleApplyReviewQueue.items[0]!;

    renderWithProviders(<ApplyReviewDecisionControls item={item} />);

    const getDecisionButton = (name: string) =>
      screen.getByRole("button", {
        name: new RegExp(`${name} for ${item.title}`, "i"),
      });
    const approveSubmitButton = getDecisionButton("Authorize live submit");
    const approveDryRunButton = getDecisionButton("Authorize dry run");
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

    expect(approveSubmitButton).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
      "hover:bg-primary/90",
    );
    expect(approveDryRunButton).toHaveClass(
      "border-border",
      "bg-card",
      "text-foreground",
    );
    expect(approveDryRunButton).not.toHaveClass("bg-success");
    expect(deferButton).toHaveClass(
      "text-muted-foreground",
      "hover:bg-muted",
      "hover:text-foreground",
    );
    expect(declineButton).toHaveClass(
      "bg-destructive",
      "text-destructive-foreground",
      "hover:bg-destructive/90",
    );

    expect(
      screen.getByRole("group", {
        name: `Authorization decision for ${item.title}`,
      }),
    ).toBeInTheDocument();

    const submitGates = screen.getByRole("table", { name: "Submit gates" });
    expect(submitGates).toHaveTextContent("GateStateDetail");
    expect(
      screen.getByRole("cell", { name: "Approval recorded" }),
    ).toHaveAttribute("data-label", "Gate");
    expect(screen.getByRole("cell", { name: "not recorded" })).toHaveAttribute(
      "data-label",
      "State",
    );
    expect(submitGates).toHaveTextContent(
      "Approval recordednot recordedLive submit stays locked until an approval is bound",
    );
    expect(submitGates).toHaveTextContent(
      "Dry-run evidencefullRun apply-run-2 completed with full coverage.",
    );
    const approvalRow = screen
      .getByRole("cell", { name: "Approval recorded" })
      .closest("tr");
    expect(approvalRow?.querySelector(".tabler-icon-clock")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      approvalRow?.querySelector(".tabler-icon-check"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Authorization only:/i).closest("p"),
    ).toHaveTextContent(/does not start or submit an application immediately/i);

    const technicalDetails = screen
      .getByText("Technical details")
      .closest("details");
    expect(technicalDetails).not.toHaveAttribute("open");
    expect(technicalDetails).toHaveTextContent("Profile version");
    expect(technicalDetails).toHaveTextContent("Application URL");
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

    const alert = screen
      .getAllByRole("alert")
      .find((candidate) =>
        candidate.textContent?.includes("Partial dry-run evidence only"),
      );
    expect(alert).toBeDefined();
    if (!alert) {
      throw new Error("Expected partial dry-run evidence alert.");
    }
    expect(alert).toHaveTextContent(/Partial dry-run evidence only/i);
    expect(alert.querySelector(".tabler-icon-lock")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    const dryRunButton = screen.getByRole("button", {
      name: new RegExp(`Authorize dry run for ${item.title}`, "i"),
    });
    expect(dryRunButton).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
      "hover:bg-primary/90",
    );

    const overrideButton = screen.getByRole("button", {
      name: new RegExp(
        `Authorize live submit with partial dry-run evidence for ${item.title}`,
        "i",
      ),
    });
    expect(
      overrideButton.querySelector('svg[data-icon="inline-start"]'),
    ).toHaveAttribute("aria-hidden", "true");
    expect(overrideButton).toHaveClass(
      "border-border",
      "bg-card",
      "text-foreground",
    );
    expect(overrideButton).not.toHaveClass("bg-success");
  });

  it("keeps each draft notice and live-submit blocker visible in its owning gate row", () => {
    const item = sampleApplyReviewQueue.items[0]!;

    renderWithProviders(
      <ApplyReviewDecisionControls
        approvalDisabledReason="Save the draft before approval."
        approvalNotice="The saved draft will be rendered before approval."
        liveSubmitDisabledReason="Confirm the related prior application."
        item={item}
      />,
    );

    const materialsRow = screen
      .getByRole("cell", { name: "Materials" })
      .closest("tr");
    expect(materialsRow).toHaveTextContent(
      "blockedSave the draft before approval. The saved draft will be rendered before approval.",
    );
    const repeatRow = screen
      .getByRole("cell", { name: "Repeat application protection" })
      .closest("tr");
    expect(repeatRow).toHaveTextContent(
      "Confirm the related prior application.",
    );
    expect(repeatRow?.querySelector(".tabler-icon-lock")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("places stale canonical bindings in the corresponding blocked rows", () => {
    const item = {
      ...sampleApplyReviewQueue.items[0]!,
      approvalGate: {
        ...sampleApplyReviewQueue.items[0]!.approvalGate,
        reasons: ["approval_stale_materials" as const],
      },
      review: {
        ...sampleApplyReviewQueue.items[0]!.review,
        state: "approved_submit" as const,
        materialsGeneration:
          sampleApplyReviewQueue.items[0]!.approvalGate.materialsGeneration! -
          1,
        profileVersion:
          sampleApplyReviewQueue.items[0]!.approvalGate.profileVersion! - 1,
        applicationUrl: `${sampleApplyReviewQueue.items[0]!.approvalGate.applicationUrl}?previous=1`,
      },
    };

    renderWithProviders(<ApplyReviewDecisionControls item={item} />);

    const approvalRow = screen
      .getByRole("cell", { name: "Approval recorded" })
      .closest("tr");
    expect(approvalRow).toHaveTextContent("stale");
    expect(approvalRow).toHaveTextContent(
      "materials changed since approval, profile changed since approval, application URL changed since approval",
    );
    expect(
      screen.getByRole("cell", { name: "Materials" }).closest("tr"),
    ).toHaveTextContent("changed");
    expect(
      screen.getByRole("cell", { name: "Profile version" }).closest("tr"),
    ).toHaveTextContent("changed");
    expect(
      screen.getByRole("cell", { name: "Application URL" }).closest("tr"),
    ).toHaveTextContent("changed");
  });
});
