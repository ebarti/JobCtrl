export const CONSENT_CONTRACT_VERSION = "v1";
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const MAX_REQUEST_BYTES = 2_048;
export const OPERATIONAL_RATE_LIMIT_PER_MINUTE = 120;
export const TELEMETRY_RATE_LIMIT_PER_MINUTE = 30;
export const TELEMETRY_GLOBAL_RATE_LIMIT_PER_MINUTE = 2_000;
export const RETENTION_SAFETY_MARGIN_SECONDS = 2 * 60 * 60;
export const PERSISTENT_COOKIE_MAX_AGE_SECONDS = CONSENT_MAX_AGE_SECONDS - RETENTION_SAFETY_MARGIN_SECONDS;
export const OPERATION_DIGEST_MAX_AGE_SECONDS = 24 * 60 * 60;
export const PRODUCT_DATA_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export const consentChoices = ["granted", "denied"] as const;
export type ConsentChoice = (typeof consentChoices)[number];

export const healthResults = ["success", "failure"] as const;
export type HealthResult = (typeof healthResults)[number];

export const storageModes = ["persistent", "memory"] as const;
export type StorageMode = (typeof storageModes)[number];

export const telemetryEventNames = [
  "demo_session_started",
  "demo_route_viewed",
  "demo_tour_started",
  "demo_tour_step_completed",
  "demo_tour_completed",
  "demo_feature_opened",
  "demo_action_started",
  "demo_action_completed",
  "demo_action_failed",
  "demo_action_cancelled",
  "demo_workspace_reset",
  "demo_install_cta_clicked",
  "demo_docs_cta_clicked",
  "demo_client_error",
  "demo_timing",
] as const;
export type TelemetryEventName = (typeof telemetryEventNames)[number];

export const routeNames = [
  "dashboard",
  "jobs",
  "job_detail",
  "evidence",
  "tailor",
  "apply_review",
  "apply_dry_run",
  "runs",
  "settings",
  "docs",
] as const;
export type RouteName = (typeof routeNames)[number];

export const featureNames = [
  "discovery",
  "scoring",
  "evidence",
  "materials",
  "apply_review",
  "apply",
  "outreach",
  "demo_tour",
] as const;
export type FeatureName = (typeof featureNames)[number];

export const actionNames = [
  "open",
  "start",
  "complete",
  "fail",
  "cancel",
  "retry",
  "reset",
  "install_cta",
  "docs_cta",
] as const;
export type ActionName = (typeof actionNames)[number];

export const scenarioNames = ["success", "failure", "cancellation", "retry"] as const;
export type ScenarioName = (typeof scenarioNames)[number];

export const resultCodes = ["succeeded", "failed", "cancelled"] as const;
export type ResultCode = (typeof resultCodes)[number];

export const errorCodes = [
  "network_unavailable",
  "telemetry_unavailable",
  "validation_rejected",
  "scenario_failed",
  "client_unexpected",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const durationBuckets = [
  "under_100ms",
  "100ms_to_499ms",
  "500ms_to_999ms",
  "1s_to_2s",
  "2s_to_5s",
  "5s_to_10s",
  "over_10s",
] as const;
export type DurationBucket = (typeof durationBuckets)[number];

export const timingMetrics = ["lcp", "inp", "cls", "ttfb", "route_transition"] as const;
export type TimingMetric = (typeof timingMetrics)[number];

export const metricBuckets = ["good", "needs_improvement", "poor"] as const;
export type MetricBucket = (typeof metricBuckets)[number];

export const viewportBuckets = ["compact", "standard", "wide"] as const;
export type ViewportBucket = (typeof viewportBuckets)[number];

export const tourSteps = ["welcome", "jobs", "evidence", "tailor", "apply", "install"] as const;
export type TourStep = (typeof tourSteps)[number];

export const referrerClasses = ["direct", "jobctrl_docs", "github", "search", "other"] as const;
export type ReferrerClass = (typeof referrerClasses)[number];

export interface TelemetryAttributes {
  route?: RouteName;
  feature?: FeatureName;
  action?: ActionName;
  scenario?: ScenarioName;
  result?: ResultCode;
  errorCode?: ErrorCode;
  durationBucket?: DurationBucket;
  timingMetric?: TimingMetric;
  metricBucket?: MetricBucket;
  viewportBucket?: ViewportBucket;
  tourStep?: TourStep;
  referrerClass?: ReferrerClass;
}

export interface TelemetryEvent {
  name: TelemetryEventName;
  attributes: TelemetryAttributes;
}

export interface ConsentRequest {
  choice: ConsentChoice;
  operationKey: string;
}

export interface HealthRequest {
  choice: ConsentChoice;
  result: HealthResult;
  storageMode: StorageMode;
  operationKey: string;
}
