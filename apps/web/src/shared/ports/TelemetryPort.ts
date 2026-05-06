export type TelemetryAttributes = Record<string, boolean | number | string>;

export interface TelemetryPort {
  event(name: string, attributes?: TelemetryAttributes): void;
  error(error: unknown, attributes?: TelemetryAttributes): void;
  timing(name: string, ms: number, attributes?: TelemetryAttributes): void;
}
