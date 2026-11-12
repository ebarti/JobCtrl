import { useState, type ReactNode } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useDiscoverySearchController } from "../hooks/useDiscoverySearchController.js";
import { DiscoverySearchSetup } from "./DiscoverySearchSetup.js";
import { DiscoverySearchFeedback, type DiscoverySearchFeedbackRenderer } from "./DiscoverySearchFeedback.js";

/** Composition supplies placement; Discovery owns admission and all progress. */
export function SavedDiscoverySearch({ profileVersion, workspaceIdentity, disabledReason, accountingSetupReason, spendingAction, renderFeedback, children }: {
  readonly profileVersion?: number | null | undefined;
  readonly workspaceIdentity?: string | undefined;
  readonly disabledReason?: string | undefined;
  readonly accountingSetupReason?: string | undefined;
  readonly spendingAction?: ReactNode;
  readonly renderFeedback?: DiscoverySearchFeedbackRenderer;
  readonly children: (controls: { readonly action: ReactNode; readonly feedback: ReactNode }) => ReactNode;
}) {
  const controller = useDiscoverySearchController({ profileVersion, workspaceIdentity, disabledReason, savedPreferences: true });
  const [setupOpen, setSetupOpen] = useState(false);
  const feedback: Parameters<DiscoverySearchFeedbackRenderer>[1] = (progress) => <><DiscoverySearchFeedback controller={controller} spendingAction={spendingAction} assessmentProgress={progress} /><DiscoverySearchSetup open={setupOpen} onOpenChange={setSetupOpen} reason={accountingSetupReason} action={spendingAction} /></>;
  return children({
    action: <Button type="button" disabled={!controller.canStart} onClick={() => { if (accountingSetupReason && !controller.recovery.record) setSetupOpen(true); else controller.launch(); }}>{controller.isPending ? "Queueing search…" : controller.recovery.record && controller.recovery.canRetry ? "Retry the same request" : "Start search"}</Button>,
    feedback: renderFeedback ? renderFeedback(controller, feedback) : feedback(),
  });
}
