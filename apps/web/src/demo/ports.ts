import { LOCAL_TENANT } from "@jobctrl/domain-types";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import type { FeatureFlagPort } from "../shared/ports/FeatureFlagPort.js";
import type { OpenInOsPort } from "../shared/ports/OpenInOsPort.js";
import type { Session, SessionPort } from "../shared/ports/SessionPort.js";
import type { StoragePort } from "../shared/ports/StoragePort.js";

export class DemoCapabilityError extends Error {
  readonly code = "demo_capability_not_implemented" as const;

  constructor(method: string) {
    super(
      `Demo capability ${method} is not available until the demo adapter is initialized.`,
    );
    this.name = "DemoCapabilityError";
  }
}

/** P2 replaces these deliberate rejections with the complete read adapter. */
export function createDemoApiClientPlaceholder(): ApiClientPort {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const method = String(property);
        return () => {
          if (method.endsWith("Url")) {
            throw new DemoCapabilityError(method);
          }
          return Promise.reject(new DemoCapabilityError(method));
        };
      },
    },
  ) as ApiClientPort;
}

export class DemoSessionAdapter implements SessionPort {
  getSession(): Session {
    return { tenantId: LOCAL_TENANT, userId: null };
  }
}

/** UI preferences are intentionally tab-local until P5 exposes a resettable UI. */
export class DemoStorageAdapter implements StoragePort {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

export class DemoFeatureFlagAdapter implements FeatureFlagPort {
  get<T extends boolean | number | string>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
}

/** The public demo cannot invoke the local host OS opener. */
export class DemoOpenInOsAdapter implements OpenInOsPort {
  async open(_artifactId: string): Promise<never> {
    throw new DemoCapabilityError("openInOs");
  }
}
