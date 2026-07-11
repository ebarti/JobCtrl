export const DEMO_CONSENT_VERSION = "v1" as const;

export type DemoConsentChoice = "unknown" | "granted" | "denied";
export type DemoConsentDecision = Exclude<DemoConsentChoice, "unknown">;
export type DemoHealthResult = "success" | "failure";
export type DemoHealthStorageMode = "persistent" | "memory";

export interface DemoConsentState {
  readonly choice: DemoConsentChoice;
  readonly version: typeof DEMO_CONSENT_VERSION;
}

export interface DemoConsentClientOptions {
  readonly fetcher?: typeof fetch;
  readonly createOperationKey?: () => string;
}

export class DemoConsentUnavailableError extends Error {
  constructor() {
    super("The demo consent service is temporarily unavailable.");
    this.name = "DemoConsentUnavailableError";
  }
}

/** The only browser client allowed to contact consent/health before app mount. */
export class DemoConsentClient {
  private readonly fetcher: typeof fetch;
  private readonly createOperationKey: () => string;
  private readonly choiceKeys = new Map<DemoConsentDecision, string>();
  private healthKey: string | undefined;

  constructor(options: DemoConsentClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.createOperationKey = options.createOperationKey ?? randomOperationKey;
  }

  async getChoice(): Promise<DemoConsentState> {
    const response = await this.fetcher("/api/demo-consent", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    return readConsentState(response);
  }

  async submitChoice(choice: DemoConsentDecision): Promise<DemoConsentState> {
    const operationKey = this.choiceKeys.get(choice) ?? this.createOperationKey();
    this.choiceKeys.set(choice, operationKey);
    const response = await this.fetcher("/api/demo-consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ choice, operationKey }),
    });
    const state = await readConsentState(response);
    if (state.choice !== choice) throw new DemoConsentUnavailableError();
    this.choiceKeys.delete(choice);
    return state;
  }

  async recordHealth(
    result: DemoHealthResult,
    storageMode: DemoHealthStorageMode,
  ): Promise<void> {
    const operationKey = this.healthKey ?? this.createOperationKey();
    this.healthKey = operationKey;
    const response = await this.fetcher("/api/demo-health", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        choice: "granted",
        result,
        storageMode,
        operationKey,
      }),
    });
    if (!response.ok) throw new DemoConsentUnavailableError();
    this.healthKey = undefined;
  }
}

async function readConsentState(response: Response): Promise<DemoConsentState> {
  if (!response.ok) throw new DemoConsentUnavailableError();
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DemoConsentUnavailableError();
  }
  if (!isRecord(value)) throw new DemoConsentUnavailableError();
  if (
    value.version !== DEMO_CONSENT_VERSION ||
    (value.choice !== "unknown" && value.choice !== "granted" && value.choice !== "denied")
  ) {
    throw new DemoConsentUnavailableError();
  }
  return { choice: value.choice, version: value.version };
}

function randomOperationKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
