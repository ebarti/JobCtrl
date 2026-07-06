import type { TenantId } from "../tenant.js";

export const SOURCE_KINDS = [
  "ats_api",
  "employer_careers_page",
  "official_api",
  "licensed_feed",
  "niche_board",
  "broad_board",
  "smart_extract",
  "user_mediated_capture",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ATS_KINDS = ["workday", "greenhouse", "lever", "ashby", "other"] as const;
export type AtsKind = (typeof ATS_KINDS)[number];

export const SOURCE_STATES = [
  "active",
  "experimental",
  "quarantined",
  "disabled",
] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const SOURCE_PRIORITIES = [
  "canonical",
  "preferred",
  "standard",
  "fallback",
  "lead_generator",
] as const;
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];

export const SOURCE_POLICY_METHODS = [
  "api",
  "feed",
  "static_page",
  "rendered_listing",
  "rendered_detail",
  "user_mediated_capture",
] as const;
export type SourcePolicyMethod = (typeof SOURCE_POLICY_METHODS)[number];

/**
 * How the politeness gateway (R10) treats robots.txt for a source.
 *
 * `honor` (the fail-closed default) obeys the target host's robots.txt before
 * any page-rendering fetch. `exempt_documented_api` marks a source accessed
 * through a documented public JSON API or licensed feed governed by that
 * contract rather than the host's crawl directives (owner decision D2). Rate,
 * concurrency, and per-run budget still apply to exempt sources.
 */
export const ROBOTS_POLICIES = ["honor", "exempt_documented_api"] as const;
export type RobotsPolicy = (typeof ROBOTS_POLICIES)[number];

export const SOURCE_AUTHENTICATION_MODES = [
  "none",
  "user_session",
  "api_key",
  "oauth",
  "manual",
] as const;
export type SourceAuthenticationMode = (typeof SOURCE_AUTHENTICATION_MODES)[number];

export const MANUAL_ACTION_REASONS = [
  "captcha",
  "login_required",
  "paywall",
  "bot_detection",
  "rate_limit",
  "robots_disallowed",
  "protected_internal_site",
  "ambiguous_career_system",
  "browser_extension_capture",
] as const;
export type ManualActionReason = (typeof MANUAL_ACTION_REASONS)[number];

export const MANUAL_CAPTURE_MODES = [
  "current_page",
  "saved_html",
  "copied_url",
  "pasted_text",
  "email_import",
] as const;
export type ManualCaptureMode = (typeof MANUAL_CAPTURE_MODES)[number];

export interface ManualInterventionPolicy {
  readonly allowed: boolean;
  readonly triggers: readonly ManualActionReason[];
  readonly captureModes: readonly ManualCaptureMode[];
}

export interface ContentFilterOverridePolicy {
  readonly allowed: boolean;
  readonly requiresReason: boolean;
  readonly allowedFilters: readonly string[];
}

export interface SourcePolicy {
  readonly policyId: string;
  readonly allowedMethods: readonly SourcePolicyMethod[];
  readonly authentication: SourceAuthenticationMode;
  readonly attribution: "none" | "required";
  readonly maxPagesPerRun: number;
  readonly maxRunFrequency: string;
  readonly locatorMaxRequestsPerDomain: number;
  // Crawl-politeness enforcement (R10). Declared intent; the Python politeness
  // gateway enforces these at every fetch surface. `maxPagesPerRun` keeps its
  // result-volume meaning; `maxRequestsPerRun` is the distinct request budget.
  readonly robotsPolicy: RobotsPolicy;
  readonly minRequestIntervalSeconds: number;
  readonly maxConcurrentRequestsPerHost: number;
  readonly maxRequestsPerRun: number;
  readonly manualIntervention: ManualInterventionPolicy;
  readonly contentFilterOverride: ContentFilterOverridePolicy;
  readonly thirdPartyControlBypass: false;
}

export function createSourcePolicy(policy: SourcePolicy): SourcePolicy {
  if (!policy.policyId.trim()) {
    throw new Error("SourcePolicy.policyId must be a non-empty string");
  }
  if (policy.allowedMethods.length === 0) {
    throw new Error("SourcePolicy.allowedMethods must contain at least one method");
  }
  if (!Number.isInteger(policy.maxPagesPerRun) || policy.maxPagesPerRun <= 0) {
    throw new Error("SourcePolicy.maxPagesPerRun must be a positive integer");
  }
  if (
    !Number.isInteger(policy.locatorMaxRequestsPerDomain) ||
    policy.locatorMaxRequestsPerDomain <= 0
  ) {
    throw new Error("SourcePolicy.locatorMaxRequestsPerDomain must be a positive integer");
  }
  if (!(policy.minRequestIntervalSeconds >= 0)) {
    throw new Error("SourcePolicy.minRequestIntervalSeconds must be non-negative");
  }
  if (
    !Number.isInteger(policy.maxConcurrentRequestsPerHost) ||
    policy.maxConcurrentRequestsPerHost <= 0
  ) {
    throw new Error("SourcePolicy.maxConcurrentRequestsPerHost must be a positive integer");
  }
  if (!Number.isInteger(policy.maxRequestsPerRun) || policy.maxRequestsPerRun <= 0) {
    throw new Error("SourcePolicy.maxRequestsPerRun must be a positive integer");
  }
  if (policy.thirdPartyControlBypass !== false) {
    throw new Error("SourcePolicy.thirdPartyControlBypass must remain false");
  }
  return policy;
}

export const SMART_EXTRACT_EXPERIMENTAL_POLICY = createSourcePolicy({
  policyId: "smart_extract_experimental",
  allowedMethods: ["static_page", "rendered_listing", "rendered_detail"],
  authentication: "none",
  attribution: "none",
  maxPagesPerRun: 50,
  maxRunFrequency: "PT24H",
  locatorMaxRequestsPerDomain: 5,
  robotsPolicy: "honor",
  minRequestIntervalSeconds: 1.0,
  maxConcurrentRequestsPerHost: 1,
  maxRequestsPerRun: 500,
  manualIntervention: {
    allowed: true,
    triggers: [
      "captcha",
      "login_required",
      "paywall",
      "bot_detection",
      "rate_limit",
      "robots_disallowed",
    ],
    captureModes: ["current_page", "saved_html", "copied_url", "pasted_text", "email_import"],
  },
  contentFilterOverride: {
    allowed: true,
    requiresReason: true,
    allowedFilters: ["low_confidence_extraction", "short_description"],
  },
  thirdPartyControlBypass: false,
});

export interface SourceQualityPlaceholder {
  readonly activeRate: number | null;
  readonly duplicateRate: number | null;
  readonly detailSuccessRate: number | null;
  readonly applyUrlSuccessRate: number | null;
  readonly staleRate: number | null;
  readonly sampleSize: number;
}

export interface SourceRegistryEntry {
  readonly tenantId: TenantId;
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly displayName: string;
  readonly owner: "system" | "user";
  readonly priority: SourcePriority;
  readonly state: SourceState;
  readonly policy: SourcePolicy;
  readonly adapterConfig: Record<string, unknown>;
  readonly quality: SourceQualityPlaceholder;
}

export interface SourceDiscoveryEvidence {
  readonly matchedUrl: string;
  readonly pageTitle: string | null;
  readonly detectedAtsKind: string | null;
  readonly sourceNativeToken: string | null;
  readonly employerDomainMatched: boolean;
  readonly redirectChain: readonly string[];
  readonly validationFetchStatus: number | null;
}

export interface ManualActionRequired {
  readonly originatingUrl: string;
  readonly sourceId: string | null;
  readonly reason: ManualActionReason;
  readonly retryContext: Record<string, unknown>;
  readonly requiredAt: string;
}

export interface ManualCaptureProvenance {
  readonly sourceKind: "user_mediated_capture";
  readonly originatingUrl: string;
  readonly capturedAt: string;
  readonly captureMode: ManualCaptureMode;
  readonly futureManualActionRequired: boolean;
  readonly captureClient?: string;
  readonly extensionVersion?: string;
}

export interface SourceLocationCandidate {
  readonly tenantId: TenantId;
  readonly candidateId: string;
  readonly candidateUrl: string;
  readonly sourceKind: SourceKind;
  readonly confidence: number;
  readonly evidence: SourceDiscoveryEvidence;
  readonly manualActionRequired: ManualActionRequired | null;
  readonly discoveredAt: string;
}

export interface LocatorPolicy {
  readonly userAgent: string;
  readonly maxRequestsPerDomain: number;
  readonly minPromotionConfidence: number;
  readonly minManualReviewConfidence: number;
  readonly domainAllowlist: readonly string[];
  readonly allowAutonomousBroadDiscovery: boolean;
}

export const DEFAULT_LOCATOR_POLICY: LocatorPolicy = {
  userAgent: "JobHunter Source Locator (local)",
  maxRequestsPerDomain: 5,
  minPromotionConfidence: 0.75,
  minManualReviewConfidence: 0.4,
  domainAllowlist: [],
  allowAutonomousBroadDiscovery: false,
};

export type LocatorDecision = "promote" | "manual_action_required" | "reject";

export function validateSourceLocationCandidate(
  candidate: SourceLocationCandidate,
  policy: LocatorPolicy = DEFAULT_LOCATOR_POLICY,
): LocatorDecision {
  if (!candidate.candidateId.trim() || !candidate.candidateUrl.trim()) {
    throw new Error("SourceLocationCandidate ids and URLs must be non-empty");
  }
  if (candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error("SourceLocationCandidate.confidence must be between 0 and 1");
  }
  if (policy.maxRequestsPerDomain <= 0) {
    throw new Error("LocatorPolicy.maxRequestsPerDomain must be positive");
  }
  if (candidate.manualActionRequired !== null) {
    return "manual_action_required";
  }
  if (candidate.confidence >= policy.minPromotionConfidence) {
    if (hasLocatorPromotionAuthority(candidate, policy)) {
      return "promote";
    }
    return "manual_action_required";
  }
  if (candidate.confidence >= policy.minManualReviewConfidence) {
    return "manual_action_required";
  }
  return "reject";
}

function hasLocatorPromotionAuthority(
  candidate: SourceLocationCandidate,
  policy: LocatorPolicy,
): boolean {
  return (
    candidate.evidence.employerDomainMatched ||
    policy.allowAutonomousBroadDiscovery ||
    isDomainAllowed(candidate.candidateUrl, policy.domainAllowlist)
  );
}

function isDomainAllowed(candidateUrl: string, allowlist: readonly string[]): boolean {
  const host = hostname(candidateUrl);
  if (host === null) {
    return false;
  }
  return allowlist.some((domain) => {
    const normalized = domain.trim().toLowerCase();
    return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
  });
}

function hostname(candidateUrl: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(candidateUrl.trim());
  return match?.[1]?.toLowerCase() ?? null;
}
