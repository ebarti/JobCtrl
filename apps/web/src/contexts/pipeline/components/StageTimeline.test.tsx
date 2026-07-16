import type {
  ActionRunResponse,
  BrowserCapabilitiesResponse,
  StageSummary,
} from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { StageTimeline } from "./StageTimeline.js";

function makeStage(
  stage: StageSummary["stage"],
  state: StageSummary["state"],
): StageSummary {
  return {
    stage,
    state,
    attemptCount: 0,
    maxAttempts: 3,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    blockedBy: [],
    nextAction: null,
  };
}

function readyAuthenticatedLinkedInBrowser(): BrowserCapabilitiesResponse {
  return {
    ok: true,
    detectedBrowsers: [{ id: "google-chrome", label: "Google Chrome" }],
    capabilities: [
      {
        id: "core-browser",
        status: "ready",
        detail: "Managed browser ready.",
        mutable: false,
        enabled: true,
        profileCopyReady: false,
      },
      {
        id: "auto-apply-browser",
        status: "disabled",
        detail: "Disabled.",
        mutable: true,
        enabled: false,
        profileCopyReady: false,
      },
      {
        id: "authenticated-linkedin-browser",
        status: "ready",
        detail: "Consented profile copy ready.",
        mutable: true,
        enabled: true,
        profileCopyReady: true,
      },
    ],
  };
}

describe("<StageTimeline>", () => {
  it("shows a manual tailor action on actionable tailor stages", () => {
    renderWithProviders(
      <StageTimeline
        jobId="job-1"
        stages={[
          makeStage("score", "succeeded"),
          makeStage("tailor", "pending"),
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "tailor this job" }),
    ).toBeInTheDocument();
  });

  it("does not show a manual tailor action after tailoring succeeds", () => {
    renderWithProviders(
      <StageTimeline
        jobId="job-1"
        stages={[makeStage("tailor", "succeeded")]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "tailor this job" }),
    ).not.toBeInTheDocument();
  });

  it("shows failed-stage diagnostics without raw next-action commands", () => {
    renderWithProviders(
      <StageTimeline
        stages={[
          {
            ...makeStage("enrich", "failed"),
            attemptCount: 1,
            durationMs: 20_000,
            errorCode: "DETAIL_ERROR",
            errorMessage: "no data extracted",
            nextAction: "jobctrl retry enrich https://example.com/jobs/1",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(
      "DETAIL_ERROR",
    );
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(
      "no data extracted",
    );
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(
      /retry\s*available/,
    );
    expect(screen.queryByText(/jobctrl retry enrich/i)).not.toBeInTheDocument();
  });

  it("explains a robots block and offers audited manual capture for the posting", () => {
    const postingUrl = "https://www.linkedin.com/jobs/view/123";
    renderWithProviders(
      <StageTimeline
        postingUrl={postingUrl}
        stages={[
          {
            ...makeStage("enrich", "blocked"),
            errorCode: "ENRICH_ROBOTS_DISALLOWED",
            errorMessage: "robots.txt disallows automated fetch of this URL",
          },
        ]}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Automated enrichment is blocked by site policy",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /robots policy does not allow/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /JobCtrl did not fetch it/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /paired JobCtrl extension/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /user-mediated provenance/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /explicit, job-scoped manual override/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /does not bypass .*robots policy/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /never submits an application/i,
    );
    expect(
      screen.getByRole("link", { name: "Open posting for manual capture" }),
    ).toHaveAttribute("href", postingUrl);
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(
      "ENRICH_ROBOTS_DISALLOWED",
    );
  });

  it("retries one robots-blocked LinkedIn job with the ready authenticated browser", async () => {
    const user = userEvent.setup();
    const retryStage = vi.fn(
      async (jobKey: string): Promise<ActionRunResponse> => ({
        ok: true as const,
        runId: "run-linkedin-authenticated-retry",
        actionId: "action-linkedin-authenticated-retry",
        action: "retry_stage" as const,
        status: "queued",
        jobKey,
        command: {
          action: "retry_stage" as const,
          jobKey,
          stage: "enrich" as const,
          runAfter: true,
        },
      }),
    );
    const browserCapabilities = vi.fn(async () =>
      readyAuthenticatedLinkedInBrowser(),
    );
    renderWithProviders(
      <StageTimeline
        jobId="linkedin-job-123"
        postingUrl="https://www.linkedin.com/jobs/view/123"
        stages={[
          {
            ...makeStage("enrich", "blocked"),
            errorCode: "ENRICH_ROBOTS_DISALLOWED",
            errorMessage: "robots.txt disallows automated fetch of this URL",
          },
        ]}
      />,
      { ports: buildTestPorts({ api: { browserCapabilities, retryStage } }) },
    );

    const retry = await screen.findByRole("button", {
      name: "Retry with authenticated browser",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/host pacing/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/run request budget/i);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /remain in audit history/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /never reaches application submission/i,
    );

    await user.click(retry);

    await waitFor(() =>
      expect(retryStage).toHaveBeenCalledWith("linkedin-job-123", {
        stage: "enrich",
        resetAttempts: false,
        runAfter: true,
        dryRun: false,
      }),
    );
    expect(
      screen.getByRole("link", { name: "Open posting for manual capture" }),
    ).toBeInTheDocument();
  });

  it("links to authenticated browser setup when the capability is not ready", async () => {
    renderWithProviders(
      <StageTimeline
        jobId="linkedin-job-456"
        postingUrl="https://www.linkedin.com/jobs/view/456"
        stages={[
          {
            ...makeStage("enrich", "blocked"),
            errorCode: "ENRICH_ROBOTS_DISALLOWED",
            errorMessage: "robots.txt disallows automated fetch of this URL",
          },
        ]}
      />,
      { ports: buildTestPorts() },
    );

    expect(
      await screen.findByRole("link", {
        name: "Set up authenticated LinkedIn browser",
      }),
    ).toHaveAttribute("href", "/settings/browser");
    expect(
      screen.queryByRole("button", {
        name: "Retry with authenticated browser",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /explicitly consented/i,
    );
    expect(
      screen.getByRole("link", { name: "Open posting for manual capture" }),
    ).toBeInTheDocument();
  });

  it("never offers the authenticated bypass for a non-LinkedIn URL", async () => {
    const browserCapabilities = vi.fn(async () =>
      readyAuthenticatedLinkedInBrowser(),
    );
    renderWithProviders(
      <StageTimeline
        jobId="not-linkedin"
        postingUrl="https://example.com/jobs/linkedin.com/jobs/123"
        stages={[
          {
            ...makeStage("enrich", "blocked"),
            errorCode: "ENRICH_ROBOTS_DISALLOWED",
            errorMessage: "robots.txt disallows automated fetch of this URL",
          },
        ]}
      />,
      { ports: buildTestPorts({ api: { browserCapabilities } }) },
    );

    expect(
      screen.queryByRole("button", {
        name: "Retry with authenticated browser",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: "Set up authenticated LinkedIn browser",
      }),
    ).not.toBeInTheDocument();
    expect(browserCapabilities).not.toHaveBeenCalled();
  });

  it("never offers the authenticated bypass unless the robots-blocked state is current", () => {
    const browserCapabilities = vi.fn(async () =>
      readyAuthenticatedLinkedInBrowser(),
    );
    renderWithProviders(
      <StageTimeline
        jobId="linkedin-not-blocked"
        postingUrl="https://www.linkedin.com/jobs/view/999"
        stages={[
          {
            ...makeStage("enrich", "failed"),
            errorCode: "ENRICH_ROBOTS_DISALLOWED",
            errorMessage: "stale robots diagnostic on a failed state",
          },
        ]}
      />,
      { ports: buildTestPorts({ api: { browserCapabilities } }) },
    );

    expect(
      screen.queryByRole("button", {
        name: "Retry with authenticated browser",
      }),
    ).not.toBeInTheDocument();
    expect(browserCapabilities).not.toHaveBeenCalled();
  });

  it("explains a blocked page request without hiding the fetch-guard evidence", () => {
    const postingUrl = "https://www.linkedin.com/jobs/view/456";
    renderWithProviders(
      <StageTimeline
        postingUrl={postingUrl}
        stages={[
          {
            ...makeStage("enrich", "failed"),
            errorCode: "DETAIL_UNSAFE_URL",
            errorMessage: "Unsupported public route method: POST",
          },
        ]}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /read-only public-fetch policy/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /blocked that request/i,
    );
    expect(
      screen.getByRole("link", { name: "Open posting for manual capture" }),
    ).toHaveAttribute("href", postingUrl);
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(
      "DETAIL_UNSAFE_URL",
    );
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(
      "Unsupported public route method: POST",
    );
  });

  it("does not offer recovery for a successful stage with stale diagnostic fields", () => {
    renderWithProviders(
      <StageTimeline
        postingUrl="https://www.linkedin.com/jobs/view/789"
        stages={[
          {
            ...makeStage("enrich", "succeeded"),
            errorCode: "ENRICH_ROBOTS_DISALLOWED",
            errorMessage: "stale worker evidence",
          },
        ]}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open posting for manual capture" }),
    ).not.toBeInTheDocument();
  });
});
