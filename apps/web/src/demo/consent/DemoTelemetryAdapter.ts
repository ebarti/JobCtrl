import type {
  TelemetryAttributes as PortTelemetryAttributes,
  TelemetryPort,
} from "../../shared/ports/TelemetryPort.js";

const EVENT_NAMES = [
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

const ROUTES = [
  "dashboard", "discovery", "jobs", "job_detail", "evidence", "tailor",
  "artifacts", "artifact_detail", "apply_review", "apply_dry_run", "runs",
  "pipelines", "analytics", "profile", "preferences", "outreach",
  "contact_detail", "activity", "settings", "docs",
] as const;
const FEATURES = [
  "discovery", "scoring", "pipeline", "evidence", "materials", "artifacts",
  "apply_review", "apply", "outreach", "demo_tour",
] as const;
const ACTIONS = [
  "open", "start", "complete", "fail", "cancel", "retry", "reset",
  "install_cta", "docs_cta", "rescore", "retailor", "retry_stage",
  "run_stage", "open_artifact", "apply_dry_run", "mark_applied",
] as const;
const SCENARIOS = ["success", "failure", "cancellation", "retry"] as const;
const RESULTS = ["succeeded", "failed", "cancelled"] as const;
const ERRORS = [
  "network_unavailable", "telemetry_unavailable", "validation_rejected",
  "scenario_failed", "client_unexpected",
] as const;
const DURATIONS = [
  "under_100ms", "100ms_to_499ms", "500ms_to_999ms", "1s_to_2s",
  "2s_to_5s", "5s_to_10s", "over_10s",
] as const;
const TIMINGS = ["lcp", "inp", "cls", "ttfb", "route_transition"] as const;
const METRICS = ["good", "needs_improvement", "poor"] as const;
const VIEWPORTS = ["compact", "standard", "wide"] as const;
const TOUR_STEPS = ["welcome", "jobs", "evidence", "tailor", "apply", "install"] as const;
const REFERRERS = ["direct", "jobctrl_docs", "github", "search", "other"] as const;

export type DemoRouteName = (typeof ROUTES)[number];

interface DemoTelemetryAdapterOptions {
  readonly fetcher?: typeof fetch;
  readonly viewportWidth?: () => number;
  readonly referrer?: () => string;
}

const ALLOWED_ATTRIBUTES: Readonly<Record<(typeof EVENT_NAMES)[number], readonly string[]>> = {
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

const ATTRIBUTE_VALUES: Readonly<Record<string, readonly string[]>> = {
  route: ROUTES,
  feature: FEATURES,
  action: ACTIONS,
  scenario: SCENARIOS,
  result: RESULTS,
  errorCode: ERRORS,
  durationBucket: DURATIONS,
  timingMetric: TIMINGS,
  metricBucket: METRICS,
  viewportBucket: VIEWPORTS,
  tourStep: TOUR_STEPS,
  referrerClass: REFERRERS,
};

/** Consent-gated, fail-open telemetry with a closed payload vocabulary. */
export class DemoTelemetryAdapter implements TelemetryPort {
  private readonly fetcher: typeof fetch;
  private readonly viewportWidth: () => number;
  private readonly referrer: () => string;

  constructor(options: DemoTelemetryAdapterOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.viewportWidth = options.viewportWidth ?? (() => window.innerWidth);
    this.referrer = options.referrer ?? (() => document.referrer);
  }

  event(name: string, attributes: PortTelemetryAttributes = {}): void {
    const event = validatedEvent(name, attributes);
    if (!event) return;
    this.send(event);
  }

  error(_error: unknown, attributes: PortTelemetryAttributes = {}): void {
    const route = isFrom(attributes.route, ROUTES) ? attributes.route : undefined;
    const errorCode = isFrom(attributes.errorCode, ERRORS)
      ? attributes.errorCode
      : "client_unexpected";
    this.event("demo_client_error", { ...(route ? { route } : {}), errorCode });
  }

  timing(name: string, milliseconds: number, attributes: PortTelemetryAttributes = {}): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const route = isFrom(attributes.route, ROUTES) ? attributes.route : undefined;
    const timingMetric = isFrom(name, TIMINGS) ? name : "route_transition";
    this.event("demo_timing", {
      ...(route ? { route } : {}),
      timingMetric,
      metricBucket: metricBucket(milliseconds),
      viewportBucket: viewportBucket(this.viewportWidth()),
    });
  }

  sessionStarted(pathname: string): void {
    this.event("demo_session_started", this.navigationAttributes(pathname));
  }

  routeViewed(pathname: string): void {
    this.event("demo_route_viewed", this.navigationAttributes(pathname));
  }

  private navigationAttributes(pathname: string): PortTelemetryAttributes {
    return {
      route: classifyDemoRoute(pathname),
      viewportBucket: viewportBucket(this.viewportWidth()),
      referrerClass: classifyReferrer(this.referrer()),
    };
  }

  private send(event: { name: string; attributes: Record<string, string> }): void {
    try {
      void this.fetcher("/api/demo-telemetry", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }).catch(() => undefined);
    } catch {
      // Optional analytics never changes product behavior.
    }
  }
}

export function classifyDemoRoute(pathname: string): DemoRouteName {
  const parts = pathname.split("/").filter(Boolean);
  const root = parts[0] ?? "dashboard";
  if (root === "jobs") return parts.length > 1 ? "job_detail" : "jobs";
  if (root === "artifacts") return parts.length > 1 ? "artifact_detail" : "artifacts";
  if (root === "outreach") return parts.length > 1 ? "contact_detail" : "outreach";
  const direct: Readonly<Record<string, DemoRouteName>> = {
    dashboard: "dashboard",
    discovery: "discovery",
    "evidence-map": "evidence",
    "apply-review": "apply_review",
    runs: "runs",
    pipelines: "pipelines",
    analytics: "analytics",
    profile: "profile",
    preferences: "preferences",
    activity: "activity",
    settings: "settings",
  };
  return direct[root] ?? "dashboard";
}

function validatedEvent(
  name: string,
  attributes: PortTelemetryAttributes,
): { name: string; attributes: Record<string, string> } | undefined {
  if (!isFrom(name, EVENT_NAMES)) return undefined;
  const allowed = ALLOWED_ATTRIBUTES[name];
  const entries = Object.entries(attributes);
  if (entries.some(([key]) => !allowed.includes(key))) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    const values = ATTRIBUTE_VALUES[key];
    if (!values || typeof value !== "string" || !values.includes(value)) return undefined;
    normalized[key] = value;
  }
  if (name === "demo_timing" && (!normalized.timingMetric || !normalized.metricBucket)) {
    return undefined;
  }
  return { name, attributes: normalized };
}

function isFrom<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function viewportBucket(width: number): (typeof VIEWPORTS)[number] {
  if (width < 720) return "compact";
  if (width < 1280) return "standard";
  return "wide";
}

function classifyReferrer(referrer: string): (typeof REFERRERS)[number] {
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host === "jobctrl.dev" || host.endsWith(".jobctrl.dev")) return "jobctrl_docs";
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (/^(www\.)?(google|bing|duckduckgo|ecosia)\./.test(host)) return "search";
    return "other";
  } catch {
    return "other";
  }
}

function metricBucket(milliseconds: number): (typeof METRICS)[number] {
  if (milliseconds < 2_500) return "good";
  if (milliseconds < 4_000) return "needs_improvement";
  return "poor";
}
