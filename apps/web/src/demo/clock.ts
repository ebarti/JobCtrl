import type { DemoReadModel, DemoRelativeTimestamp, DemoRouteData, DemoScenario, DemoSeed } from "./contracts.js";

const DEMO_TIMESTAMP_PREFIX = "demo-time:";

export interface DemoClock {
  readonly anchor: string;
}

/** A JSON-safe timestamp token resolved only when a seed is materialized. */
export type DemoTimestampToken = `${typeof DEMO_TIMESTAMP_PREFIX}${number}`;

export function demoTimestamp(offsetMinutes: number): DemoTimestampToken {
  if (!Number.isSafeInteger(offsetMinutes)) {
    throw new TypeError("Demo timestamp offsets must be safe integers.");
  }
  return `${DEMO_TIMESTAMP_PREFIX}${offsetMinutes}`;
}

export interface MaterializedDemoScenario {
  readonly scenarioId: string;
  readonly operation: DemoScenario["operation"];
  readonly steps: readonly {
    readonly state: "queued" | "running";
    readonly at: string;
    readonly message: string;
  }[];
  readonly terminal:
    | { readonly state: "succeeded"; readonly summary: string; readonly at: string }
    | {
        readonly state: "failed";
        readonly errorCode: string;
        readonly retryable: true;
        readonly summary: string;
        readonly at: string;
      }
    | { readonly state: "cancelled"; readonly summary: string; readonly at: string };
}

export interface MaterializedDemoSeed {
  readonly schemaVersion: DemoSeed["schemaVersion"];
  readonly seedVersion: DemoSeed["seedVersion"];
  readonly title: DemoSeed["title"];
  readonly artifacts: DemoSeed["artifacts"];
  readonly generatedAt: string;
  readonly readModel: DemoReadModel;
  readonly routeData: MaterializedDemoRouteData;
  readonly scenarios: readonly MaterializedDemoScenario[];
  readonly receipts: readonly (Omit<DemoSeed["receipts"][number], "recordedAt"> & {
    readonly recordedAt: string;
  })[];
}

export type MaterializedDemoRouteData = Readonly<
  Record<
    keyof DemoRouteData,
    readonly (Omit<DemoRouteData[keyof DemoRouteData][number], "at"> & { readonly at: string })[]
  >
>;

export function materializeRelativeTimestamp(
  clock: DemoClock,
  timestamp: DemoRelativeTimestamp,
): string {
  if (!Number.isSafeInteger(timestamp.offsetMinutes)) {
    throw new TypeError("Demo timestamp offsets must be safe integers.");
  }
  const anchorMs = Date.parse(clock.anchor);
  if (!Number.isFinite(anchorMs)) {
    throw new TypeError("Demo clock anchors must be ISO timestamps.");
  }
  return new Date(anchorMs + timestamp.offsetMinutes * 60_000).toISOString();
}

function materializeTimestampToken(value: string, clock: DemoClock): string | null {
  if (!value.startsWith(DEMO_TIMESTAMP_PREFIX)) {
    return null;
  }
  const offsetMinutes = Number(value.slice(DEMO_TIMESTAMP_PREFIX.length));
  return Number.isSafeInteger(offsetMinutes)
    ? materializeRelativeTimestamp(clock, { offsetMinutes })
    : null;
}

/**
 * Recursively materializes server-shaped response payloads without modifying
 * their ApiClientPort return types. Only explicit demo timestamp tokens change.
 */
export function materializeDemoReadModel(seed: DemoSeed["readModel"], clock: DemoClock): DemoReadModel {
  const materialize = (value: unknown): unknown => {
    if (typeof value === "string") {
      return materializeTimestampToken(value, clock) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map(materialize);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, materialize(nested)]));
    }
    return value;
  };
  return materialize(seed) as DemoReadModel;
}

function materializeRouteData(seed: DemoRouteData, clock: DemoClock): MaterializedDemoRouteData {
  return Object.fromEntries(
    Object.entries(seed).map(([route, records]) => [
      route,
      records.map((record) => ({ ...record, at: materializeRelativeTimestamp(clock, record.at) })),
    ]),
  ) as unknown as MaterializedDemoRouteData;
}

/** Materializes all relative times without reading the browser clock. */
export function materializeDemoSeed(seed: DemoSeed, clock: DemoClock): MaterializedDemoSeed {
  return {
    schemaVersion: seed.schemaVersion,
    seedVersion: seed.seedVersion,
    title: seed.title,
    artifacts: seed.artifacts,
    generatedAt: materializeRelativeTimestamp(clock, { offsetMinutes: 0 }),
    readModel: materializeDemoReadModel(seed.readModel, clock),
    routeData: materializeRouteData(seed.routeData, clock),
    scenarios: seed.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      operation: scenario.operation,
      steps: scenario.steps.map((step) => ({
        state: step.state,
        at: materializeRelativeTimestamp(clock, step.at),
        message: step.message,
      })),
      terminal: {
        ...scenario.terminal,
        at: materializeRelativeTimestamp(clock, scenario.terminal.at),
      },
    })),
    receipts: seed.receipts.map((receipt) => ({
      ...receipt,
      recordedAt: materializeRelativeTimestamp(clock, receipt.recordedAt),
    })),
  };
}
