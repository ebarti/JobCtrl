import { LOCAL_TENANT } from "@jobctrl/domain-types";

import type { FeatureFlagPort } from "../shared/ports/FeatureFlagPort.js";
import type { Session, SessionPort } from "../shared/ports/SessionPort.js";
import type { StoragePort } from "../shared/ports/StoragePort.js";
import { LocalStorageAdapter } from "../shared/adapters/local/LocalStorageAdapter.js";
import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";

export class DemoCapabilityError extends Error {
  readonly code = "demo_capability_not_implemented" as const;

  constructor(method: string, reason?: string) {
    const capability =
      DEMO_CAPABILITY_MANIFEST[method as keyof typeof DEMO_CAPABILITY_MANIFEST];
    super(
      reason ??
        capability?.reason ??
        "This action requires the configured private local workspace.",
    );
    this.name = "DemoCapabilityError";
  }
}

export class DemoSessionAdapter implements SessionPort {
  getSession(): Session {
    return { tenantId: LOCAL_TENANT, userId: null };
  }
}

/** UI preferences are intentionally tab-local until P5 exposes a resettable UI. */
export class DemoStorageAdapter implements StoragePort {
  private readonly values = new Map<string, unknown>();
  private readonly coordination = new LocalStorageAdapter();

  get<T = unknown>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }

  transact<T>(
    key: string,
    operation: (current: string | null) => { result: T; write?: string },
    signal?: AbortSignal,
  ): Promise<T> {
    return this.coordination.transact(key, operation, signal);
  }
}

export class DemoFeatureFlagAdapter implements FeatureFlagPort {
  get<T extends boolean | number | string>(key: string, defaultValue: T): T {
    if (key === "demoMode" && typeof defaultValue === "boolean") {
      return true as T;
    }
    for (const operation of Object.keys(
      DEMO_CAPABILITY_MANIFEST,
    ) as (keyof typeof DEMO_CAPABILITY_MANIFEST)[]) {
      const capability = DEMO_CAPABILITY_MANIFEST[operation];
      if (
        key === `apiCapability:${operation}:available` &&
        typeof defaultValue === "boolean"
      ) {
        return (capability.class !== "unavailable") as T;
      }
      if (
        key === `apiCapability:${operation}:reason` &&
        typeof defaultValue === "string"
      ) {
        return capability.reason as T;
      }
    }
    return defaultValue;
  }
}
