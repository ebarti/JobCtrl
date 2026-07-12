import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DemoWorkspaceReceipt } from "./contracts.js";
import { DemoReceiptHistory } from "./DemoReceiptHistory.js";
import { DemoWorkspaceProvider } from "./DemoWorkspaceProvider.js";
import { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";
import { InMemoryDemoWorkspaceStore } from "./storage.js";

async function createWorkspace(): Promise<DemoWorkspaceRepository> {
  const workspace = new DemoWorkspaceRepository({
    store: new InMemoryDemoWorkspaceStore(),
    clock: { now: () => new Date("2026-07-11T12:00:00.000Z") },
    createWorkspaceId: () => "receipt-history-test",
  });
  await workspace.initialize();
  return workspace;
}

describe("<DemoReceiptHistory>", () => {
  it("stays absent outside the demo composition", () => {
    render(
      <DemoWorkspaceProvider workspace={null}>
        <DemoReceiptHistory />
      </DemoWorkspaceProvider>,
    );

    expect(
      screen.queryByRole("region", { name: "Simulation receipts" }),
    ).toBeNull();
  });

  it("announces the latest no-effect receipt and keeps durable history", async () => {
    const workspace = await createWorkspace();
    render(
      <DemoWorkspaceProvider workspace={workspace}>
        <DemoReceiptHistory />
      </DemoWorkspaceProvider>,
    );

    const region = screen.getByRole("region", { name: "Simulation receipts" });
    expect(
      within(region).getByRole("status", { name: "Latest simulated receipt" }),
    ).toHaveTextContent("Simulated — no external effect occurred.");

    await act(async () => {
      await workspace.mutate((draft) => {
        (draft.state.receipts as DemoWorkspaceReceipt[]).push({
            receiptId: "receipt-test-dry-run",
            kind: "application",
            simulated: true,
            externalEffectOccurred: false,
            recordedAt: "2026-07-11T12:01:00.000Z",
            wouldHaveDone: "Prepared a synthetic application rehearsal.",
            didNotDo: "No test application was submitted.",
            operation: "applyJob",
            entityType: "job",
            entityId: "job-northwind-platform",
          });
      });
    });

    expect(
      within(region).getByRole("status", { name: "Latest simulated receipt" }),
    ).toHaveTextContent("No test application was submitted.");
    expect(
      within(region).getByText("Receipt history (6)"),
    ).toBeInTheDocument();

    await act(async () => {
      await workspace.reset();
    });

    expect(
      within(region).getByText("Receipt history (5)"),
    ).toBeInTheDocument();
    expect(
      within(region).queryByText("No test application was submitted."),
    ).toBeNull();
  });
});
