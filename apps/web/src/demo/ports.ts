import { LOCAL_TENANT } from "@jobctrl/domain-types";

import type { FeatureFlagPort } from "../shared/ports/FeatureFlagPort.js";
import type { Session, SessionPort } from "../shared/ports/SessionPort.js";
import type { SessionStoragePort } from "../shared/ports/SessionStoragePort.js";
import type { StoragePort } from "../shared/ports/StoragePort.js";
import { LocalStorageAdapter } from "../shared/adapters/local/LocalStorageAdapter.js";
import { BrowserSessionStorageAdapter } from "../shared/adapters/local/BrowserSessionStorageAdapter.js";
import type { DemoWorkspaceRepository } from "./workspace/DemoWorkspaceRepository.js";
import {
  DEMO_CAPABILITY_MANIFEST,
  DEMO_FEATURE_CAPABILITIES,
} from "./capabilities.js";

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

/** Opaque pending-request identities cannot outlive their synthetic workspace. */
export class DemoSessionStorageAdapter implements SessionStoragePort {
  private readonly storage = new BrowserSessionStorageAdapter("demo");
  private scope: string | undefined;

  setWorkspaceScope(workspaceId: string, resetEpoch: number): void {
    const next = `${workspaceId}:${resetEpoch}`;
    if (this.scope === next) return;
    if (this.scope) {
      try {
        const keys = JSON.parse(
          this.storage.get(`${this.scope}:keys`) ?? "[]",
        ) as string[];
        for (const key of keys)
          this.storage.remove(`${this.scope}:value:${key}`);
        this.storage.remove(`${this.scope}:keys`);
      } catch {
        /* A new epoch cannot read an earlier pending request. */
      }
    }
    this.scope = next;
  }

  private scopedKey(key: string): string {
    if (!this.scope || !key)
      throw new Error("The demo request-recovery workspace is unavailable.");
    return `${this.scope}:value:${key}`;
  }
  get(key: string): string | null {
    return this.storage.get(this.scopedKey(key));
  }
  set(key: string, value: string): void {
    const scoped = this.scopedKey(key);
    const keys = JSON.parse(
      this.storage.get(`${this.scope}:keys`) ?? "[]",
    ) as string[];
    this.storage.set(
      `${this.scope}:keys`,
      JSON.stringify([...new Set([...keys, key])]),
    );
    this.storage.set(scoped, value);
  }
  remove(key: string): void {
    this.storage.remove(this.scopedKey(key));
    const keys = JSON.parse(
      this.storage.get(`${this.scope}:keys`) ?? "[]",
    ) as string[];
    this.storage.set(
      `${this.scope}:keys`,
      JSON.stringify(keys.filter((item) => item !== key)),
    );
  }
}

/** Recovery copies are scoped to the exact synthetic workspace and reset epoch. */
export class DemoStorageAdapter implements StoragePort {
  private readonly values = new Map<string, unknown>();
  private recovery: LocalStorageAdapter | undefined;
  private scope: string | undefined;

  constructor(private readonly workspace: DemoWorkspaceRepository) {}

  setWorkspaceScope(
    workspaceId: string,
    resetEpoch: number,
    persistent: boolean,
  ): void {
    const next = `${workspaceId}:${resetEpoch}`;
    if (this.scope === next && Boolean(this.recovery) === persistent) return;
    const retained =
      this.scope === next ? new Map(this.values) : new Map<string, unknown>();
    if (this.recovery) {
      try {
        for (const key of this.recovery.get<string[]>("keys") ?? []) {
          if (this.scope === next)
            retained.set(key, this.recovery.get(`value:${key}`));
          this.recovery.remove(`value:${key}`);
        }
        this.recovery.remove("keys");
      } catch {
        /* A reset's new namespace cannot read an old recovery copy. */
      }
    }
    this.scope = next;
    this.recovery = persistent
      ? new LocalStorageAdapter(`jobctrl-demo:recovery:${next}:`)
      : undefined;
    this.values.clear();
    for (const [key, value] of retained) this.values.set(key, value);
  }

  private isRecoveryKey(key: string): boolean {
    return (
      key.startsWith("profile-wording-draft:") ||
      key.startsWith("profile-editor-recovery:") ||
      key.startsWith("profile-resume-draft:")
    );
  }

  get<T = unknown>(key: string): T | null {
    if (this.recovery && this.isRecoveryKey(key))
      return this.recovery.get<T>(`value:${key}`);
    return (this.values.get(key) as T | undefined) ?? null;
  }

  readRaw(key: string): string | null {
    if (this.recovery && this.isRecoveryKey(key))
      return this.recovery.readRaw(`value:${key}`);
    const value = this.values.get(key);
    return value === undefined ? null : JSON.stringify(value);
  }

  set<T = unknown>(key: string, value: T): void {
    if (this.recovery && this.isRecoveryKey(key)) {
      const keys = this.recovery.get<string[]>("keys") ?? [];
      // Write the registry first so reset cleanup also owns a failed value write.
      this.recovery.set("keys", [...new Set([...keys, key])]);
      this.recovery.set(`value:${key}`, value);
      return;
    }
    this.values.set(key, value);
  }

  remove(key: string): void {
    if (this.recovery && this.isRecoveryKey(key)) {
      this.recovery.remove(`value:${key}`);
      const keys = this.recovery.get<string[]>("keys") ?? [];
      this.recovery.set(
        "keys",
        keys.filter((item) => item !== key),
      );
      return;
    }
    this.values.delete(key);
  }

  transact<T>(
    key: string,
    operation: (current: string | null) => { result: T; write?: string },
    signal?: AbortSignal,
  ): Promise<T> {
    const scope = this.scope;
    if (!scope)
      return Promise.reject(
        new Error("The synthetic draft workspace is unavailable."),
      );
    return this.workspace
      .transactDraftSlot(
        `demo:${scope}:${key}`,
        (current) => {
          if (scope !== this.scope)
            throw new Error(
              "The synthetic workspace changed before this recovery draft was saved.",
            );
          return operation(current);
        },
        signal,
      )
      .then((result) => {
        if (scope !== this.scope)
          throw new Error(
            "The synthetic workspace changed before this recovery draft was confirmed.",
          );
        return result;
      });
  }
}

export class DemoFeatureFlagAdapter implements FeatureFlagPort {
  get<T extends boolean | number | string>(key: string, defaultValue: T): T {
    if (key === "demoMode" && typeof defaultValue === "boolean") {
      return true as T;
    }
    for (const [operation, capability] of Object.entries({
      ...DEMO_CAPABILITY_MANIFEST,
      ...DEMO_FEATURE_CAPABILITIES,
    })) {
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
