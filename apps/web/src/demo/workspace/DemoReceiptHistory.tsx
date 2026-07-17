import { useMemo, useSyncExternalStore, type JSX } from "react";

import { formatDateTime } from "../../shared/lib/formatters.js";
import type { DemoWorkspaceReceipt } from "./contracts.js";
import type { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";
import { useDemoWorkspace } from "./DemoWorkspaceProvider.js";

const RECEIPT_KIND_LABELS: Record<DemoWorkspaceReceipt["kind"], string> = {
  application: "Application rehearsal",
  outreach: "Outreach rehearsal",
  discovery: "Discovery rehearsal",
  compensation: "Compensation rehearsal",
  contact_research: "Contact research rehearsal",
  llm: "Generation rehearsal",
  os_open: "Artifact preview rehearsal",
};

function receiptLabel(receipt: DemoWorkspaceReceipt): string {
  if (!receipt.operation) return RECEIPT_KIND_LABELS[receipt.kind];
  const phrase = receipt.operation.replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1).toLowerCase()}`;
}

function newestFirst(
  receipts: readonly DemoWorkspaceReceipt[],
): readonly DemoWorkspaceReceipt[] {
  return receipts.toSorted(
    (first, second) =>
      Date.parse(second.recordedAt) - Date.parse(first.recordedAt),
  );
}

function DemoReceiptHistoryContent({
  workspace,
}: {
  readonly workspace: DemoWorkspaceRepository;
}): JSX.Element | null {
  const receipts = useSyncExternalStore(
    workspace.subscribeReceipts,
    workspace.getReceiptsSnapshot,
    workspace.getReceiptsSnapshot,
  );
  const orderedReceipts = useMemo(() => newestFirst(receipts), [receipts]);
  const latest = orderedReceipts[0];

  if (!latest) return null;

  return (
    <section
      aria-label="Simulation receipts"
      className="demo-receipt-history"
    >
      <p
        aria-label="Latest simulated receipt"
        aria-live="polite"
        className="demo-receipt-latest"
        role="status"
      >
        <strong>Simulated — no external effect occurred.</strong>
        <span aria-hidden="true" className="demo-receipt-latest__desktop-copy">
          {latest.didNotDo}
        </span>
        <span className="sr-only">{latest.didNotDo}</span>
      </p>
      <details className="demo-receipt-latest__disclosure">
        <summary>Latest no-effect receipt details</summary>
        <span>{latest.didNotDo}</span>
      </details>
      <details className="demo-receipt-history__disclosure">
        <summary>Receipt history ({orderedReceipts.length})</summary>
        <ol className="demo-receipt-list">
          {orderedReceipts.map((receipt) => (
            <li key={receipt.receiptId}>
              <div className="demo-receipt-list-head">
                <strong>{receiptLabel(receipt)}</strong>
                <time dateTime={receipt.recordedAt}>
                  {formatDateTime(receipt.recordedAt)}
                </time>
              </div>
              <span>{receipt.wouldHaveDone}</span>
              <span>
                <strong>No external effect:</strong> {receipt.didNotDo}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

export function DemoReceiptHistory(): JSX.Element | null {
  const context = useDemoWorkspace();
  return context.mode === "demo" ? (
    <DemoReceiptHistoryContent workspace={context.workspace} />
  ) : null;
}
