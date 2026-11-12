import type { ReactNode } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useDiscoverySearchController } from "../hooks/useDiscoverySearchController.js";
import { DiscoverySearchFeedback } from "./DiscoverySearchFeedback.js";

/** Composition supplies placement; Discovery owns admission and all progress. */
export function SavedDiscoverySearch({ profileVersion, workspaceIdentity, disabledReason, children }: {
  readonly profileVersion?: number | null | undefined;
  readonly workspaceIdentity?: string | undefined;
  readonly disabledReason?: string | undefined;
  readonly children: (controls: { readonly action: ReactNode; readonly feedback: ReactNode }) => ReactNode;
}) {
  const controller = useDiscoverySearchController({ profileVersion, workspaceIdentity, disabledReason, savedPreferences: true });
  return children({
    action: <Button type="button" disabled={!controller.canStart} onClick={() => controller.launch()}>{controller.isPending ? "Queueing search…" : controller.recovery.record && controller.recovery.canRetry ? "Retry the same request" : "Start search"}</Button>,
    feedback: <DiscoverySearchFeedback controller={controller} />,
  });
}
