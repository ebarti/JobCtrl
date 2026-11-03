import type { ManualCaptureQueueItemSummary } from "@jobctrl/contracts";

import { DEMO_READ_MODEL } from "./read-model.js";

/** Interpret only the original bundled capture from saved pre-lifecycle demo workspaces. */
export function withDemoCaptureLifecycle(item: ManualCaptureQueueItemSummary): ManualCaptureQueueItemSummary {
  const fixture = DEMO_READ_MODEL.discovery.manualCapture.items[0];
  if (
    !fixture || Object.hasOwn(item, "lifecycleId") || item.itemId !== fixture.itemId ||
    item.originatingUrl !== fixture.originatingUrl || item.sourceId !== fixture.sourceId ||
    item.reason !== fixture.reason || item.retryContext?.simulated !== true
  ) return item;
  return { ...item, lifecycleId: fixture.lifecycleId };
}
