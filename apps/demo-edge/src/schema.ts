import {
  actionNames,
  consentChoices,
  durationBuckets,
  errorCodes,
  featureNames,
  healthResults,
  metricBuckets,
  type ConsentRequest,
  type HealthRequest,
  referrerClasses,
  resultCodes,
  routeNames,
  scenarioNames,
  storageModes,
  telemetryEventNames,
  timingMetrics,
  type TelemetryAttributes,
  type TelemetryEvent,
  tourSteps,
  viewportBuckets,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isFrom<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isOperationKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function parseConsentRequest(value: unknown): ConsentRequest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["choice", "operationKey"]) || !isFrom(value.choice, consentChoices) || !isOperationKey(value.operationKey)) {
    return undefined;
  }
  return { choice: value.choice, operationKey: value.operationKey };
}

export function parseHealthRequest(value: unknown): HealthRequest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["choice", "result", "storageMode", "operationKey"])
    || !isFrom(value.choice, consentChoices)
    || !isFrom(value.result, healthResults)
    || !isFrom(value.storageMode, storageModes)
    || !isOperationKey(value.operationKey)) {
    return undefined;
  }
  return {
    choice: value.choice,
    result: value.result,
    storageMode: value.storageMode,
    operationKey: value.operationKey,
  };
}

const allowedAttributesByEvent: Record<TelemetryEvent["name"], readonly (keyof TelemetryAttributes)[]> = {
  demo_session_started: ["route", "viewportBucket", "referrerClass"],
  demo_route_viewed: ["route", "viewportBucket", "referrerClass"],
  demo_tour_started: ["route", "tourStep"],
  demo_tour_step_completed: ["route", "tourStep"],
  demo_tour_completed: ["route"],
  demo_feature_opened: ["route", "feature"],
  demo_action_started: ["route", "feature", "action", "scenario"],
  demo_action_completed: ["route", "feature", "action", "scenario", "result", "durationBucket"],
  demo_action_failed: ["route", "feature", "action", "scenario", "result", "errorCode", "durationBucket"],
  demo_action_cancelled: ["route", "feature", "action", "scenario", "result", "durationBucket"],
  demo_workspace_reset: ["route"],
  demo_install_cta_clicked: ["route"],
  demo_docs_cta_clicked: ["route"],
  demo_client_error: ["route", "errorCode"],
  demo_timing: ["route", "timingMetric", "metricBucket", "viewportBucket"],
};

function parseTelemetryAttributes(value: unknown, name: TelemetryEvent["name"]): TelemetryAttributes | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, allowedAttributesByEvent[name])) return undefined;
  if (("route" in value && !isFrom(value.route, routeNames))
    || ("feature" in value && !isFrom(value.feature, featureNames))
    || ("action" in value && !isFrom(value.action, actionNames))
    || ("scenario" in value && !isFrom(value.scenario, scenarioNames))
    || ("result" in value && !isFrom(value.result, resultCodes))
    || ("errorCode" in value && !isFrom(value.errorCode, errorCodes))
    || ("durationBucket" in value && !isFrom(value.durationBucket, durationBuckets))
    || ("timingMetric" in value && !isFrom(value.timingMetric, timingMetrics))
    || ("metricBucket" in value && !isFrom(value.metricBucket, metricBuckets))
    || ("viewportBucket" in value && !isFrom(value.viewportBucket, viewportBuckets))
    || ("tourStep" in value && !isFrom(value.tourStep, tourSteps))
    || ("referrerClass" in value && !isFrom(value.referrerClass, referrerClasses))) {
    return undefined;
  }
  if (name === "demo_timing" && (!("timingMetric" in value) || !("metricBucket" in value))) {
    return undefined;
  }
  return value as TelemetryAttributes;
}

export function parseTelemetryEvent(value: unknown): TelemetryEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "attributes"]) || !isFrom(value.name, telemetryEventNames)) {
    return undefined;
  }
  const attributes = parseTelemetryAttributes(value.attributes, value.name);
  if (attributes === undefined) return undefined;
  return { name: value.name, attributes };
}
