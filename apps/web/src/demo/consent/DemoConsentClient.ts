export const DEMO_CONSENT_VERSION = "v2" as const;
export const DEMO_CONSENT_REQUEST_TIMEOUT_MS = 3_000;

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
  readonly requestTimeoutMs?: number;
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
  private readonly requestTimeoutMs: number;
  private readonly choiceKeys = new Map<DemoConsentDecision, string>();
  private healthKey: string | undefined;

  constructor(options: DemoConsentClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.createOperationKey = options.createOperationKey ?? randomOperationKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEMO_CONSENT_REQUEST_TIMEOUT_MS;
  }

  async getChoice(): Promise<DemoConsentState> {
    return this.withRequestTimeout(async (signal) => {
      const response = await this.fetcher("/api/demo-consent", {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      });
      return readConsentState(response);
    });
  }

  async submitChoice(choice: DemoConsentDecision): Promise<DemoConsentState> {
    const operationKey = this.choiceKeys.get(choice) ?? this.createOperationKey();
    this.choiceKeys.set(choice, operationKey);
    const state = await this.withRequestTimeout(async (signal) => {
      const response = await this.fetcher("/api/demo-consent", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ choice, operationKey }),
        signal,
      });
      return readConsentState(response);
    });
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
    await this.withRequestTimeout(async (signal) => {
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
        signal,
      });
      if (!response.ok) throw new DemoConsentUnavailableError();
    });
    this.healthKey = undefined;
  }

  private async withRequestTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new DemoConsentUnavailableError());
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof DemoConsentUnavailableError) throw error;
      throw new DemoConsentUnavailableError();
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
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
