import type { DiscoveryBrowserTaskCompletionRequest } from "@jobctrl/contracts";

import type { BrowserApi } from "./browser";
import { executeDiscoveryBrowserTask } from "./discovery-executor";
import {
  getNextDiscoveryBrowserTask,
  isDiscoveryBrowserLeaseActive,
  LocalApiError,
  postDiscoveryBrowserTaskResult,
  type LocalApiOptions,
} from "./local-api";

const LEASE_HEARTBEAT_INTERVAL_MS = 750;

export async function processNextDiscoveryBrowserTask(
  browser: BrowserApi,
  token: string,
  installationId: string,
  extensionVersion: string,
  apiOptions: LocalApiOptions = {},
): Promise<"idle" | "processed"> {
  const lease = await getNextDiscoveryBrowserTask(
    token,
    installationId,
    extensionVersion,
    apiOptions,
  );
  if (lease.status === "idle") {
    return "idle";
  }

  const execution = new AbortController();
  let executing = true;
  let leaseIsActive = true;
  const heartbeat = (async () => {
    while (executing) {
      try {
        const active = await isDiscoveryBrowserLeaseActive(
          token,
          installationId,
          extensionVersion,
          lease.taskId,
          lease.leaseId,
          { ...apiOptions, timeoutMs: Math.min(apiOptions.timeoutMs ?? 5_000, 5_000) },
        );
        if (!active) {
          leaseIsActive = false;
          execution.abort(new Error("Discovery browser lease was canceled."));
          return;
        }
      } catch (error) {
        if (
          error instanceof LocalApiError &&
          (error.status === 401 || error.status === 403 || error.status === 409)
        ) {
          leaseIsActive = false;
          execution.abort(error);
          return;
        }
        // A transient loopback heartbeat failure does not outlive the task's
        // independent hard timeout. Retry while Chrome is still executing.
      }
      await delay(LEASE_HEARTBEAT_INTERVAL_MS);
    }
  })();

  const result = await executeDiscoveryBrowserTask(browser, lease, {
    signal: execution.signal,
  });
  executing = false;
  await heartbeat;
  if (!leaseIsActive) {
    return "processed";
  }
  const completion: DiscoveryBrowserTaskCompletionRequest = {
    leaseId: lease.leaseId,
    result,
  };
  await postDiscoveryBrowserTaskResult(
    token,
    installationId,
    extensionVersion,
    lease.taskId,
    completion,
    apiOptions,
  );
  return "processed";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
