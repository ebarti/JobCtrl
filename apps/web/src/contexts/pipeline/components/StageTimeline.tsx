import type { JSX } from "react";
import type { StageSummary } from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconExternalLink,
} from "@tabler/icons-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../shared/ui/collapsible.js";
import { TailorJobButton } from "../../materials/components/RetailorCurrentPolicyButton.js";
import { useBrowserCapabilitiesQuery } from "../../operations/hooks/useBrowserCapabilitiesQuery.js";
import { useRetryStageMutation } from "../hooks/useRetryStageMutation.js";
import { StageBadge } from "./StageBadge.js";

export interface StageTimelineProps {
  stages: readonly StageSummary[];
  jobId?: string;
  postingUrl?: string;
}

export function StageTimeline({
  stages,
  jobId,
  postingUrl,
}: StageTimelineProps): JSX.Element {
  return (
    <ol aria-label="Preparation stages" className="timeline stage-timeline">
      {stages.map((stage) => {
        const diagnostics = stageDiagnostics(stage);
        const guidance = stageGuidance(stage);
        const manualCaptureUrl = guidance ? publicPostingUrl(postingUrl) : null;
        return (
          <li
            className="timeline-row stage-timeline__item"
            data-stage-state={stage.state}
            key={stage.stage}
          >
            <div className="timeline-row-head stage-timeline__header">
              <span
                className="stage-timeline__stage-name"
                data-typography="strong-body"
              >
                {stageLabel(stage.stage)}
              </span>
              <StageBadge state={stage.state} />
            </div>
            {guidance ? (
              <Alert className="stage-timeline__guidance">
                <IconAlertTriangle aria-hidden="true" />
                <AlertTitle>{guidance.title}</AlertTitle>
                <AlertDescription>
                  <p>{guidance.explanation}</p>
                  {stage.state === "blocked" &&
                  stage.errorCode === "ENRICH_ROBOTS_DISALLOWED" &&
                  jobId &&
                  isLinkedInJobUrl(manualCaptureUrl) ? (
                    <AuthenticatedLinkedInRetry jobId={jobId} />
                  ) : null}
                  <p>
                    <strong>Manual capture fallback.</strong> Open the posting
                    in the browser with the paired JobCtrl extension, then
                    choose
                    <strong> Capture page</strong>. JobCtrl imports the visible
                    posting as an explicit, job-scoped manual override and
                    stores user-mediated provenance. It does not bypass the
                    fetch guard or the site's robots policy, and it never
                    submits an application.
                  </p>
                  {manualCaptureUrl ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        nativeButton={false}
                        render={
                          <a
                            href={manualCaptureUrl}
                            rel="noreferrer"
                            role="link"
                            target="_blank"
                          />
                        }
                        size="sm"
                        variant="outline"
                      >
                        <IconExternalLink data-icon="inline-start" />
                        Open posting for manual capture
                      </Button>
                    </div>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {diagnostics.length ? (
              <StageDiagnosticDisclosure
                diagnostics={diagnostics}
                stage={stage.stage}
              />
            ) : null}
            {jobId && canTailorFromStage(stage) ? (
              <TailorJobButton className="tab timeline-action" jobId={jobId} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StageDiagnosticDisclosure({
  diagnostics,
  stage,
}: {
  diagnostics: Array<[string, string]>;
  stage: StageSummary["stage"];
}): JSX.Element {
  return (
    <Collapsible className="stage-timeline__diagnostic-disclosure">
      <CollapsibleTrigger
        render={
          <Button
            className="stage-timeline__diagnostic-trigger"
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <IconChevronDown aria-hidden="true" data-icon="inline-start" />
        Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className="stage-timeline__diagnostic-content">
        <StageDiagnosticList diagnostics={diagnostics} stage={stage} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function AuthenticatedLinkedInRetry({ jobId }: { jobId: string }): JSX.Element {
  const capabilities = useBrowserCapabilitiesQuery();
  const retryStage = useRetryStageMutation();
  const authenticatedLinkedIn = capabilities.data?.capabilities.find(
    (capability) => capability.id === "authenticated-linkedin-browser",
  );
  const ready =
    authenticatedLinkedIn?.status === "ready" &&
    authenticatedLinkedIn.enabled &&
    authenticatedLinkedIn.profileCopyReady;

  if (capabilities.isPending) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p>Checking the authenticated LinkedIn browser capability.</p>
        <Button disabled size="sm" variant="outline">
          Checking authenticated browser
        </Button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p>
          Authenticated retry needs an enabled LinkedIn browser and an
          explicitly consented JobCtrl-owned profile copy.
        </p>
        <Button
          nativeButton={false}
          render={<a href="/settings/browser" role="link" />}
          size="sm"
          variant="outline"
        >
          Set up authenticated LinkedIn browser
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p>
        Retry this LinkedIn job with the consented JobCtrl-owned profile. Host
        pacing and the current run request budget still apply. The stage reset
        and new attempt remain in audit history, and this preparation retry
        never reaches application submission.
      </p>
      <Button
        disabled={retryStage.isPending}
        onClick={() =>
          retryStage.mutate({
            jobId,
            stage: "enrich",
            runAfter: true,
          })
        }
        size="sm"
      >
        {retryStage.isPending
          ? "Retrying with authenticated browser"
          : "Retry with authenticated browser"}
      </Button>
      {retryStage.isError ? (
        <p role="alert">
          The authenticated retry could not start. Try again from this job.
        </p>
      ) : null}
    </div>
  );
}

function StageDiagnosticList({
  diagnostics,
  stage,
}: {
  diagnostics: Array<[string, string]>;
  stage: StageSummary["stage"];
}): JSX.Element {
  return (
    <dl className="timeline-diagnostics" aria-label={`${stage} diagnostics`}>
      {diagnostics.map(([label, value]) => (
        <div key={label}>
          <dt data-typography="label">{label}</dt>
          <dd data-typography="body">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function canTailorFromStage(stage: StageSummary): boolean {
  return (
    stage.stage === "tailor" &&
    !["queued", "running", "succeeded", "exhausted"].includes(stage.state)
  );
}

const STAGE_LABELS: Record<StageSummary["stage"], string> = {
  discover: "Discover",
  enrich: "Enrich",
  score: "Score",
  tailor: "Tailor",
  cover: "Cover letter",
  apply: "Apply",
};

function stageLabel(stage: StageSummary["stage"]): string {
  return STAGE_LABELS[stage];
}

function stageDiagnostics(stage: StageSummary): Array<[string, string]> {
  if (!["failed", "exhausted", "blocked"].includes(stage.state)) return [];
  const diagnostics: Array<[string, string]> = [];
  if (stage.errorCode) diagnostics.push(["code", stage.errorCode]);
  if (stage.errorMessage) diagnostics.push(["message", stage.errorMessage]);
  if (stage.attemptCount || stage.maxAttempts) {
    diagnostics.push([
      "attempts",
      `${stage.attemptCount}/${stage.maxAttempts}`,
    ]);
  }
  if (stage.durationMs !== null) {
    diagnostics.push(["duration", formatDuration(stage.durationMs)]);
  }
  if (stage.blockedBy.length) {
    diagnostics.push(["blocked by", stage.blockedBy.join(", ")]);
  }
  if (["failed", "exhausted"].includes(stage.state)) {
    diagnostics.push([
      "retry",
      stage.retryable ? "available" : "not automatic",
    ]);
  }
  return diagnostics;
}

function stageGuidance(
  stage: StageSummary,
): { title: string; explanation: string } | null {
  if (
    stage.stage !== "enrich" ||
    !["failed", "exhausted", "blocked"].includes(stage.state)
  ) {
    return null;
  }
  if (stage.errorCode === "ENRICH_ROBOTS_DISALLOWED") {
    return {
      title: "Automated enrichment is blocked by site policy",
      explanation:
        "The site's robots policy does not allow JobCtrl to fetch this posting automatically, so JobCtrl did not fetch it.",
    };
  }
  if (stage.errorCode === "DETAIL_UNSAFE_URL") {
    return {
      title: "JobCtrl's read-only fetch guard stopped this page",
      explanation:
        "The posting tried a page request outside JobCtrl's read-only public-fetch policy. JobCtrl blocked that request instead of weakening the safety boundary.",
    };
  }
  return null;
}

function publicPostingUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isLinkedInJobUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const linkedinHost =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    const path = url.pathname.toLowerCase();
    return linkedinHost && (path === "/jobs" || path.startsWith("/jobs/"));
  } catch {
    return false;
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1000)}s`;
}
