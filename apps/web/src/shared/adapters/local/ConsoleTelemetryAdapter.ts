import type { TelemetryAttributes, TelemetryPort } from "../../ports/TelemetryPort.js";

export class ConsoleTelemetryAdapter implements TelemetryPort {
  constructor(private readonly debug = import.meta.env.DEV) {}

  event(name: string, attributes?: TelemetryAttributes): void {
    if (this.debug) {
      console.debug("[telemetry]", name, attributes);
    }
  }

  error(error: unknown, attributes?: TelemetryAttributes): void {
    if (this.debug) {
      console.debug("[telemetry:error]", error, attributes);
    }
  }

  timing(name: string, ms: number, attributes?: TelemetryAttributes): void {
    if (this.debug) {
      console.debug("[telemetry:timing]", name, ms, attributes);
    }
  }
}
