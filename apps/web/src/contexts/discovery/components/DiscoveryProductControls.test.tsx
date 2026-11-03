import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts as buildBaseTestPorts } from "../../../test/testPorts.js";
import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import {
  DISCOVERY_SOURCE_COLUMN_IDS,
  DISCOVERY_SOURCES_TABLE_ID,
  useSavedTableViewsStore,
  type SavedTablePresentation,
} from "../../../shared/stores/saved-table-views.js";
import {
  DiscoveryProductControls,
  type DiscoverySourceTableControls,
} from "./DiscoveryProductControls.js";

const NO_POLITENESS = {
  robotsDisallowedCount: 0,
  rateLimitedCount: 0,
  budgetExhaustedCount: 0,
  lastBlockedReason: null,
  lastBlockedAt: null,
} as const;

const SYNTHETIC_LIFECYCLE = "0".repeat(64);

function buildTestPorts(options?: Parameters<typeof buildBaseTestPorts>[0]) {
  const ports = buildBaseTestPorts(options);
  const queue = ports.api.manualCaptureQueue.bind(ports.api);
  const recovered = new Map<string, { base: string; current: string }>();
  let recoveryNumber = 0;
  let preparationNumber = 0;
  ports.api.manualCaptureQueue = async () => {
    const result = await queue();
    return { ...result, items: result.items.map((item) => {
      const lifecycleId = item.lifecycleId === undefined ? SYNTHETIC_LIFECYCLE : item.lifecycleId;
      const override = recovered.get(item.itemId);
      return { ...item, lifecycleId: override && (lifecycleId === override.base || lifecycleId === override.current)
        ? override.current : lifecycleId };
    }) };
  };
  if (!options?.api?.prepareManualCapture) {
    ports.api.prepareManualCapture = vi.fn(async (itemId, body) => {
      const lifecycleId = `f${(++preparationNumber).toString(16).padStart(63, "0")}`;
      recovered.set(itemId, { base: recovered.get(itemId)?.base ?? body.expectedLifecycleId ?? SYNTHETIC_LIFECYCLE, current: lifecycleId });
      return { ok: true as const, itemId, lifecycleId };
    });
  }
  if (!options?.api?.supersedeManualCapture) {
    ports.api.supersedeManualCapture = vi.fn(async (itemId, expectedLifecycleId) => {
      const lifecycleId = (++recoveryNumber).toString(16).padStart(64, "0");
      recovered.set(itemId, { base: recovered.get(itemId)?.base ?? expectedLifecycleId, current: lifecycleId });
      return { ok: true as const, itemId, lifecycleId };
    });
  }
  return ports;
}

function rejectedCapture(): Error & { status: 422; writeOutcomeUnknown: false } {
  return Object.assign(new Error("synthetic rejection"), { status: 422 as const, writeOutcomeUnknown: false as const });
}

async function recoverCapture(user: ReturnType<typeof userEvent.setup>, label = "Captured URL") {
  await user.click(screen.getByRole("button", { name: "Prevent earlier imports from saving" }));
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled());
}

beforeEach(() => {
  window.localStorage.removeItem("jh:saved-table-views");
  useSavedTableViewsStore.getState().reset();
});

describe("DiscoveryProductControls", () => {
  it("keeps a durably prepared capture fenced after a fresh reload until explicitly superseded", async () => {
    const itemId = "manual-reload-fence";
    const url = "https://example.test/jobs/reload-fence";
    let lifecycleId = "a".repeat(64);
    let unresolved = false;
    let content = "Original retained page";
    let importCount = 0;
    let rejectHeld: (error: Error) => void = () => {};
    const heldImport = new Promise<never>((_resolve, reject) => { rejectHeld = reject; });
    const ports = buildTestPorts({ api: {
      manualCaptureQueue: async () => ({ ok: true as const, items: [{ itemId, lifecycleId,
        originatingUrl: url, sourceId: "manual:test", reason: "login_required" as const,
        requiredAt: "2026-10-30", status: "pending" as const,
        retryContext: { ...(unresolved ? { manual_capture_import_unresolved: true } : {}),
          manual_capture_draft: { capture_mode: "pasted_text", captured_url: url, content,
            note: "", future_manual_action_required: false } },
      }] }),
      prepareManualCapture: vi.fn(async (_itemId, body) => {
        content = body.contentText ?? "";
        lifecycleId = "b".repeat(64);
        unresolved = true;
        return { ok: true as const, itemId, lifecycleId };
      }),
      importManualCapture: vi.fn(() => ++importCount === 1
        ? Promise.reject(new Error("synthetic lost acknowledgement")) : heldImport),
      supersedeManualCapture: vi.fn(async () => {
        lifecycleId = "c".repeat(64);
        unresolved = false;
        return { ok: true as const, itemId, lifecycleId };
      }),
    } });
    const user = userEvent.setup();
    const first = renderWithProviders(<DiscoveryProductControls />, { ports });
    await user.click(await screen.findByRole("button", { name: `Import ${url}` }));
    await screen.findByText(/Import outcome is unconfirmed and the capture remains/);
    first.unmount();
    renderWithProviders(<DiscoveryProductControls />, { ports });
    expect(await screen.findByLabelText("Pasted text")).toBeDisabled();
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Original retained page");
    await user.click(screen.getByRole("button", { name: "Prevent earlier imports from saving" }));
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toBeEnabled());
    await user.type(screen.getByLabelText("Pasted text"), " corrected");
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Original retained page corrected");
    const beforePreparation = screen.getByLabelText("Pasted text");
    await user.click(screen.getByRole("button", { name: `Import ${url}` }));
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).not.toBe(beforePreparation));
    const pendingDraft = screen.getByLabelText("Pasted text");
    expect(pendingDraft).toBeDisabled();
    expect(pendingDraft).toHaveValue("Original retained page corrected");
    await user.type(pendingDraft, " ignored while pending");
    expect(pendingDraft).toHaveValue("Original retained page corrected");
    rejectHeld(new Error("synthetic cleanup"));
    await screen.findByText(/Import outcome is unconfirmed and the capture remains/);
  });

  it.each([false, true])("preserves unsent edits if a delayed earlier preparation changes or removes the reviewed lifetime (removed: %s)", async (removed) => {
    const itemId = "manual-delayed-preparation";
    const url = "https://example.test/jobs/delayed-preparation";
    let lifecycleId = "a".repeat(64);
    let present = true;
    let content = "Original page";
    let unresolved = false;
    const importManualCapture = vi.fn();
    const supersedeManualCapture = vi.fn();
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: async () => ({ ok: true as const, items: present ? [{ itemId, lifecycleId,
        originatingUrl: url, sourceId: "manual:test", reason: "login_required" as const,
        requiredAt: "2026-10-30", status: "pending" as const,
        retryContext: { ...(unresolved ? { manual_capture_import_unresolved: true } : {}),
          manual_capture_draft: { capture_mode: "pasted_text", captured_url: url, content,
            note: "", future_manual_action_required: false } },
      }] : [] }),
      importManualCapture,
      supersedeManualCapture,
    } }) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " unsent local edit");
    await user.type(screen.getByLabelText("Note"), "Unsent note");
    lifecycleId = "b".repeat(64);
    content = "Earlier delayed submission";
    unresolved = true;
    present = !removed;
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(await screen.findByText("Your unsubmitted edits are available below.")).toBeInTheDocument();
    expect(screen.getByLabelText("Saved submission content")).toHaveValue("Original page unsent local edit");
    expect(screen.getByLabelText("Saved submission note")).toHaveValue("Unsent note");
    expect(importManualCapture).not.toHaveBeenCalled();
    expect(supersedeManualCapture).not.toHaveBeenCalled();
    if (!removed) {
      expect(screen.getByLabelText("Pasted text")).toHaveValue("Earlier delayed submission");
      expect(screen.getByLabelText("Pasted text")).toBeDisabled();
    }
  });

  it("preserves unsent edits if a legacy worker becomes unresolved without changing the review lifetime", async () => {
    const itemId = "manual-legacy-admission";
    const url = "https://example.test/jobs/legacy-admission";
    let lifecycleId = "a".repeat(64);
    let unresolved = false;
    const ports = buildTestPorts({ api: {
      manualCaptureQueue: async () => ({ ok: true as const, items: [{ itemId, lifecycleId,
        originatingUrl: url, sourceId: "manual:test", reason: "login_required" as const,
        requiredAt: "2026-10-30", status: "pending" as const,
        retryContext: { ...(unresolved ? { manual_capture_import_unresolved: true } : {}),
          manual_capture_draft: { capture_mode: "pasted_text", captured_url: url, content: "Saved page" } },
      }] }),
      supersedeManualCapture: async () => {
        unresolved = false;
        lifecycleId = "b".repeat(64);
        return { ok: true as const, itemId, lifecycleId };
      },
    } });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, { ports });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " local edit");
    unresolved = true;
    await act(async () => { await queryClient.invalidateQueries(); });
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toBeDisabled());
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Saved page local edit");
    await user.click(screen.getByRole("button", { name: "Prevent earlier imports from saving" }));
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toBeEnabled());
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Saved page local edit");
  });

  it.each([
    { state: "disabled", reason: null },
    { state: "active", reason: "Adapter configuration is required for this source." },
  ])("shows saved origins and preserves the $state source review fence", async ({ state, reason }) => {
    const promoteSourceLocatorCandidate = vi.fn();
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        promoteSourceLocatorCandidate,
        discoveryLocatorCandidates: async () => ({ ok: true, candidates: [{
          candidateId: "history-1", candidateUrl: "https://jobs.lever.co/synthetic-acme",
          sourceKind: "ats_api", confidence: 0, detectedAtsKind: "lever",
          employerDomainMatched: false, manualActionReason: "ambiguous_career_system",
          discoveredAt: "2026-10-18T09:00:00Z",
          proposal: {
            coordinateKey: "https://jobs.lever.co/synthetic-acme", sourceId: "lever:synthetic-acme",
            atsKind: "lever", boardToken: "synthetic-acme", completeness: "unknown", promotionBlockedReason: reason,
            overlaps: [{ sourceId: "lever:synthetic-acme", state, seedUrl: "https://jobs.lever.co/synthetic-acme" }],
            evidence: [{
              originJobId: "b0410000-0000-4000-8000-000000000001",
              originPostingUrl: "https://jobs.lever.co/synthetic-acme/posting-1",
              inputUrl: "https://jobs.lever.co/synthetic-acme/posting-1/apply", urlKind: "application_url",
              observations: [{ observationId: "obs-1", sourceId: "manual_capture:extension", runId: "saved-capture-run", observedUrl: "https://jobs.lever.co/synthetic-acme/posting-1", observedAt: "2026-10-18T09:00:00Z" }],
              extraction: { tier: "json_ld", enrichedAt: "2026-10-18T09:00:00Z", snapshotVersion: 3, descriptionSha256: "saved-description", snapshotSha256: "saved-snapshot" },
              sample: { title: "Platform Engineer", company: "Synthetic Acme", descriptionExcerpt: "Build reliable synthetic systems." },
            }],
          },
        }] }),
      } }),
    });
    expect(await screen.findByText(/Board: lever:synthetic-acme.*Completeness unknown/)).toBeInTheDocument();
    expect(screen.getByText(`Existing sources: lever:synthetic-acme (${state})`)).toBeInTheDocument();
    if (reason) expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByText(/Platform Engineer.*Synthetic Acme.*Build reliable synthetic systems/)).toBeInTheDocument();
    expect(screen.getByText(/Runs: saved-capture-run/)).toHaveTextContent("Extraction: json_ld · Snapshot: 3");
    expect(screen.getByRole("button", { name: "Promote https://jobs.lever.co/synthetic-acme" })).toBeDisabled();
    expect(promoteSourceLocatorCandidate).not.toHaveBeenCalled();
  });

  it("saves URL-owned source filters with local source-table presentation", async () => {
    function SourceTableHarness() {
      const [filters, setFilters] = useState<
        DiscoverySourceTableControls["filters"]
      >({
        state: {
          operator: "contains" as const,
          text: "",
          selectedValues: ["active"],
        },
      });
      const [sort, setSort] = useState<DiscoverySourceTableControls["sort"]>({
        columnId: "displayName",
        direction: "asc",
      });
      const [presentation, setPresentation] = useState<SavedTablePresentation>({
        columns: {
          order: [...DISCOVERY_SOURCE_COLUMN_IDS],
          hidden: [],
          widths: {},
        },
        density: null,
        grouping: null,
        colorRules: [],
      });

      return (
        <DiscoveryProductControls
          layout="tabs"
          sourceTable={{
            filters,
            sort,
            presentation,
            onFiltersChange: setFilters,
            onSortChange: setSort,
            onPresentationChange: setPresentation,
            onApplyView: (view) => {
              setFilters(view.urlFilters.sourceFilters ?? {});
              setSort(view.sort);
              setPresentation({
                columns: view.columns,
                density: view.density,
                grouping: view.grouping,
                colorRules: view.colorRules,
              });
            },
          }}
        />
      );
    }

    renderWithProviders(<SourceTableHarness />);
    const user = userEvent.setup();

    expect(
      await screen.findByRole("combobox", { name: "Saved table view" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /filter company column/i }),
    );
    await user.type(screen.getByLabelText("Company filter text"), "linkedin");
    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(
      screen.getByRole("button", { name: "Configure table columns" }),
    );
    await user.click(screen.getByRole("button", { name: "Compact" }));
    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(screen.getByRole("button", { name: "Save as view" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "LinkedIn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = useSavedTableViewsStore
      .getState()
      .views.find(
        (view) =>
          view.tableId === DISCOVERY_SOURCES_TABLE_ID &&
          view.name === "LinkedIn",
      );
    expect(saved).toMatchObject({
      density: "compact",
      sort: { columnId: "displayName", direction: "asc" },
      urlFilters: {
        sourceFilters: {
          displayName: {
            operator: "contains",
            text: "linkedin",
            selectedValues: [],
          },
          state: {
            operator: "contains",
            text: "",
            selectedValues: ["active"],
          },
        },
      },
    });
  });

  it("labels the demo source preview as bundled and network-free", async () => {
    const ports = buildTestPorts();
    ports.featureFlags = new DemoFeatureFlagAdapter();
    renderWithProviders(<DiscoveryProductControls />, { ports });

    expect(
      await screen.findByRole("button", {
        name: /bundled preview.*no fetch.*linkedin/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders source health, quarantine review, and manual capture queues", async () => {
    renderWithProviders(<DiscoveryProductControls />);

    await screen.findByText("JobStreaming LinkedIn");
    expect(screen.getByText("jobspy:linkedin")).toBeInTheDocument();
    expect(screen.getByText("Engineering Manager")).toBeInTheDocument();
    expect(
      screen.getByText("https://example.com/protected/job"),
    ).toBeInTheDocument();
    // The Access column surfaces the source's recorded politeness outcomes.
    expect(screen.getByText("rate limited")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /preview jobstreaming linkedin/i }),
    );
    expect(await screen.findByText("Product Engineer")).toBeInTheDocument();
  });

  it("renders readable source details and manual capture reasons", async () => {
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          discoverySources: vi.fn(async () => ({
            ok: true as const,
            sources: [
              {
                sourceId: "readable-source",
                kind: "employer_careers_page" as const,
                displayName: "Readable Source",
                owner: "user" as const,
                priority: "preferred" as const,
                state: "active" as const,
                policyId: "local:readable-source",
                recommendedState: "trusted" as const,
                lastRunId: "run-1",
                lastRunCompletedAt: "2026-05-15T10:00:00+00:00",
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 3,
                newJobs: 2,
                duplicateRate: 0.1,
                activeVerificationRate: 0.8,
                fullDescriptionSuccessRate: 0.7,
                applyUrlSuccessRate: 0.6,
                politeness: NO_POLITENESS,
                qualityTrend: "flat" as const,
              },
            ],
          })),
          manualCaptureQueue: vi.fn(async () => ({
            ok: true as const,
            items: [
              {
                itemId: "manual-ambiguous",
                originatingUrl: "https://example.com/jobs/?q={query}",
                sourceId: "example-source",
                reason: "ambiguous_career_system" as const,
                retryContext: { sourceId: "example-source" },
                requiredAt: "2026-05-15T10:00:00+00:00",
                status: "pending" as const,
              },
              {
                itemId: "manual-extension",
                originatingUrl: "https://example.com/jobs/browser-extension",
                sourceId: "manual_capture:extension",
                reason: "browser_extension_capture" as const,
                retryContext: { source: "browser_extension" },
                requiredAt: "2026-05-15T10:05:00+00:00",
                status: "pending" as const,
              },
              {
                itemId: "manual-robots",
                originatingUrl: "https://example.com/jobs/robots-denied",
                sourceId: "manual_url_import",
                reason: "robots_disallowed" as const,
                retryContext: { source: "jobs_url_import" },
                requiredAt: "2026-05-15T10:10:00+00:00",
                status: "pending" as const,
              },
            ],
          })),
        },
      }),
    });

    await screen.findByText("Readable Source");
    expect(screen.getByLabelText("Source registry summary")).toHaveTextContent(
      "1 active",
    );
    const sourceTable = screen.getByRole("table");
    expect(sourceTable).toHaveTextContent("Type");
    expect(sourceTable).toHaveTextContent("Employer careers page");
    expect(sourceTable).toHaveTextContent("preferred");
    expect(sourceTable).toHaveTextContent("trusted");
    expect(sourceTable).toHaveTextContent("3");
    expect(sourceTable).toHaveTextContent("2");
    expect(sourceTable).toHaveTextContent("80%");
    expect(sourceTable).toHaveTextContent("70%");
    const sourceType = within(sourceTable).getByText("Employer careers page");
    const priority = within(sourceTable).getByText("preferred");
    const recommendation = within(sourceTable).getByText("trusted");
    expect(sourceType).toHaveAttribute("data-typography", "label");
    expect(priority).toHaveClass("source-table-category");
    expect(recommendation).toHaveClass("source-table-category");
    expect(priority).not.toHaveClass("good", "warn", "bad");
    expect(within(sourceTable).getByText("active")).toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(within(sourceTable).getByText("active")).toHaveAttribute(
      "data-status-tone",
      "ok",
    );
    expect(screen.getByText(/Unconfirmed careers page/i)).toBeInTheDocument();
    expect(
      screen.getByText(/cannot confirm which careers system/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Browser extension capture/i)).toBeInTheDocument();
    expect(
      screen.getByText(/saved this posting from the browser extension/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Blocked by robots.txt/i)).toBeInTheDocument();
    expect(
      screen.getByText(/does not permit JobCtrl to fetch/i),
    ).toBeInTheDocument();
  });

  it("filters active sources by default on the discovery page table and sorts the registry", async () => {
    renderWithProviders(<DiscoveryProductControls layout="tabs" />, {
      ports: buildTestPorts({
        api: {
          discoverySources: vi.fn(async () => ({
            ok: true as const,
            sources: [
              {
                sourceId: "workday:salesforce",
                kind: "ats_api" as const,
                displayName: "Salesforce",
                owner: "system" as const,
                priority: "canonical" as const,
                state: "active" as const,
                policyId: "workday_api_canonical",
                recommendedState: "normal" as const,
                lastRunId: "run-1",
                lastRunCompletedAt: "2026-05-15T10:00:00+00:00",
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 3,
                newJobs: 0,
                duplicateRate: null,
                activeVerificationRate: null,
                fullDescriptionSuccessRate: null,
                applyUrlSuccessRate: null,
                politeness: NO_POLITENESS,
                qualityTrend: "unknown" as const,
              },
              {
                sourceId: "jobspy:indeed",
                kind: "broad_board" as const,
                displayName: "Indeed",
                owner: "system" as const,
                priority: "fallback" as const,
                state: "active" as const,
                policyId: "jobspy_board",
                recommendedState: "normal" as const,
                lastRunId: "run-2",
                lastRunCompletedAt: "2026-05-16T10:00:00+00:00",
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 8,
                newJobs: 1,
                duplicateRate: null,
                activeVerificationRate: null,
                fullDescriptionSuccessRate: null,
                applyUrlSuccessRate: null,
                politeness: NO_POLITENESS,
                qualityTrend: "unknown" as const,
              },
              {
                sourceId: "workday:hidden",
                kind: "ats_api" as const,
                displayName: "Hidden Co",
                owner: "system" as const,
                priority: "canonical" as const,
                state: "disabled" as const,
                policyId: "workday_api_canonical",
                recommendedState: "disabled" as const,
                lastRunId: null,
                lastRunCompletedAt: null,
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 1,
                newJobs: 0,
                duplicateRate: null,
                activeVerificationRate: null,
                fullDescriptionSuccessRate: null,
                applyUrlSuccessRate: null,
                politeness: NO_POLITENESS,
                qualityTrend: "unknown" as const,
              },
            ],
          })),
        },
      }),
    });

    await screen.findByRole("tab", { name: "Source registry" });
    expect(await screen.findByText("Salesforce")).toBeInTheDocument();
    const sourceTable = screen.getByRole("table");
    expect(screen.getAllByText("Workday ATS").length).toBeGreaterThan(0);
    expect(within(sourceTable).queryByText("Provider")).not.toBeInTheDocument();
    expect(within(sourceTable).queryByText("ats api")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden Co")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /filter company column/i }),
    );
    await user.type(screen.getByLabelText("Company filter text"), "sales");
    expect(within(sourceTable).getByText("Salesforce")).toBeInTheDocument();
    expect(within(sourceTable).queryByText("Indeed")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Company filter text"));
    await user.click(screen.getByRole("button", { name: /close/i }));

    await user.click(screen.getByRole("button", { name: /sort by observed/i }));
    await user.click(
      screen.getByRole("button", { name: /sort by observed \(ascending\)/i }),
    );

    const rows = within(sourceTable).getAllByRole("row");
    expect(within(rows[1]!).getByText("Indeed")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /filter state column/i }),
    );
    await user.click(screen.getByRole("checkbox", { name: "active" }));
    await waitFor(() => {
      expect(within(sourceTable).getByText("Hidden Co")).toBeInTheDocument();
    });
  });

  it("records feedback and manual capture actions through the API port", async () => {
    const recordDiscoveryFeedback = vi.fn(async () => ({
      ok: true as const,
      feedbackId: "feedback-1",
      jobKey: "https://example.com/jobs/quarantined",
      sourceId: "greenhouse-example",
      kind: "useful" as const,
      recordedAt: "2026-05-12T10:00:00+00:00",
    }));
    const importManualCapture = vi.fn(async () => ({
      ok: true as const,
      itemId: "manual-1",
      jobKey: "https://example.com/protected/job",
      importedAt: "2026-05-12T10:00:00+00:00",
      provenance: {
        sourceKind: "user_mediated_capture" as const,
        originatingUrl: "https://example.com/protected/job",
        captureMode: "copied_url" as const,
        futureManualActionRequired: false,
      },
    }));
    const promoteSourceLocatorCandidate = vi.fn(async () => ({
      ok: true as const,
      candidateId: "candidate-1",
      decision: "promote" as const,
      source: {
        sourceId: "greenhouse-example",
        kind: "ats_api" as const,
        displayName: "Greenhouse Example",
        owner: "user" as const,
        priority: "canonical" as const,
        state: "experimental" as const,
        policyId: "local:greenhouse-example",
        recommendedState: "normal" as const,
        lastRunId: null,
        lastRunCompletedAt: null,
        lastErrorClass: null,
        consecutiveFailures: 0,
        observedJobs: 0,
        newJobs: 0,
        duplicateRate: null,
        activeVerificationRate: null,
        fullDescriptionSuccessRate: null,
        applyUrlSuccessRate: null,
        politeness: NO_POLITENESS,
        qualityTrend: "unknown" as const,
      },
      decidedAt: "2026-05-12T10:00:00+00:00",
    }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          recordDiscoveryFeedback,
          importManualCapture,
          promoteSourceLocatorCandidate,
        },
      }),
    });

    await screen.findByText("Engineering Manager");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: /promote https:\/\/example.com\/careers/i,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /mark source greenhouse-example useful/i,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /import https:\/\/example.com\/protected\/job/i,
      }),
    );

    await waitFor(() =>
      expect(promoteSourceLocatorCandidate).toHaveBeenCalledTimes(1),
    );
    expect(promoteSourceLocatorCandidate).toHaveBeenCalledWith("candidate-1", {
      reason: "User promoted source locator candidate from product controls.",
    });
    await waitFor(() =>
      expect(recordDiscoveryFeedback).toHaveBeenCalledTimes(1),
    );
    expect(recordDiscoveryFeedback).toHaveBeenCalledWith({
      jobKey: "https://example.com/jobs/quarantined",
      sourceId: "greenhouse-example",
      kind: "useful",
    });
    await waitFor(() => expect(importManualCapture).toHaveBeenCalledTimes(1));
    expect(importManualCapture).toHaveBeenCalledWith("manual-1", {
      expectedLifecycleId: expect.stringMatching(/^f[0-9a-f]{63}$/),
      captureMode: "copied_url",
      capturedUrl: "https://example.com/protected/job",
      futureManualActionRequired: false,
    });
  });

  it("shows low-score role-match suggestions for approval", async () => {
    const roleMatchFeedbackSuggestions = vi.fn(async () => ({
      ok: true as const,
      suggestions: [
        {
          suggestionId: "role-title-exclusion-manager-test-engineering",
          status: "pending" as const,
          ruleKind: "exact_title_exclusion" as const,
          titlePattern: "manager test engineering",
          titleDisplay: "Manager, Test Engineering",
          reasonCode: "low_role_fit" as const,
          reason: "Role fit is 1/10 on a job scored 2/10.",
          sampleCount: 1,
          sourceIds: ["jobspy:linkedin"],
          evidence: [
            {
              jobKey: "https://example.com/jobs/test-engineering",
              title: "Manager, Test Engineering",
              company: "Monolithic Power Systems",
              sourceId: "jobspy:linkedin",
              fitScore: 2,
              roleFit: 1,
              reason: "Role fit is 1/10 on a job scored 2/10.",
              scoredAt: "2026-05-12T10:00:00+00:00",
            },
          ],
          createdAt: "2026-05-12T10:00:00+00:00",
          updatedAt: "2026-05-12T10:00:00+00:00",
          decidedAt: null,
          decisionReason: null,
        },
      ],
    }));
    const decideRoleMatchFeedbackSuggestion = vi.fn(async () => ({
      ok: true as const,
      suggestion: {
        suggestionId: "role-title-exclusion-manager-test-engineering",
        status: "approved" as const,
        ruleKind: "exact_title_exclusion" as const,
        titlePattern: "manager test engineering",
        titleDisplay: "Manager, Test Engineering",
        reasonCode: "low_role_fit" as const,
        reason: "Role fit is 1/10 on a job scored 2/10.",
        sampleCount: 1,
        sourceIds: ["jobspy:linkedin"],
        evidence: [],
        createdAt: "2026-05-12T10:00:00+00:00",
        updatedAt: "2026-05-12T10:01:00+00:00",
        decidedAt: "2026-05-12T10:01:00+00:00",
        decisionReason: "User approved low-score role-match suggestion.",
      },
    }));

    renderWithProviders(<DiscoveryProductControls layout="tabs" />, {
      ports: buildTestPorts({
        api: {
          roleMatchFeedbackSuggestions,
          decideRoleMatchFeedbackSuggestion,
        },
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Role matching" }));
    expect(
      await screen.findByText(/Exclude .Manager, Test Engineering./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Role fit is 1\/10/i)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: /approve role-match rule for manager, test engineering/i,
      }),
    );

    await waitFor(() =>
      expect(decideRoleMatchFeedbackSuggestion).toHaveBeenCalledWith(
        "role-title-exclusion-manager-test-engineering",
        {
          decision: "approve",
          reason: "User approved low-score role-match suggestion.",
        },
      ),
    );
  });

  it("asks for page content before resubmitting an evidenced historical failure", async () => {
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [{
          itemId: "legacy-1", originatingUrl: "https://example.com/jobs/legacy", sourceId: "legacy-source",
          reason: "login_required" as const, retryContext: { manual_capture_recovery_unverified: true },
          requiredAt: "2026-05-15T10:00:00+00:00", status: "imported" as const,
        }] })),
      } }),
    });
    expect(await screen.findByText(/Previous import has no matching saved snapshot/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /import https:\/\/example.com\/jobs\/legacy/i });
    expect(button).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(await screen.findByRole("option", { name: "Pasted text" }));
    await user.type(screen.getByLabelText("Pasted text"), "A newly supplied page");
    expect(button).toBeEnabled();
  });

  it("restores a retained capture and shows a failed retry without losing the content", async () => {
    const importManualCapture = vi.fn(async () => { throw rejectedCapture(); });
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({
          ok: true as const,
          items: [{
            itemId: "manual-retry", originatingUrl: "https://example.com/protected/retry",
            sourceId: "manual_capture:extension", reason: "browser_extension_capture" as const,
            retryContext: { manual_capture_page_decision: "posting_unverified", manual_capture_draft: {
              token: "attempt-1", capture_mode: "current_page", captured_url: "https://example.com/protected/retry",
              content: "<main>Synthetic retained page</main>", note: "Review", future_manual_action_required: true,
              page_determination_id: "synthetic-page-receipt",
            } },
            requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
          }],
        })),
        importManualCapture,
      } }),
    });
    const content = await screen.findByLabelText("Captured page content");
    expect(screen.getByText("The captured page was not identified as one job posting.")).toBeInTheDocument();
    expect(content).toHaveValue("<main>Synthetic retained page</main>");
    expect(screen.getByLabelText("Note")).toHaveValue("Review");
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toBeChecked();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.com\/protected\/retry/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the retained capture and try again");
    expect(screen.getByLabelText("Captured page content")).toHaveValue("<main>Synthetic retained page</main>");
    expect(importManualCapture).toHaveBeenCalledWith("manual-retry", expect.objectContaining({
      captureMode: "current_page", contentHtmlBase64: "PG1haW4+U3ludGhldGljIHJldGFpbmVkIHBhZ2U8L21haW4+",
    }));
  });

  it("preserves pre-submit edits through a failed import and enables retry", async () => {
    let rejectImport: (error: Error) => void = () => {};
    const pending = new Promise<never>((_resolve, reject) => { rejectImport = reject; });
    const item = {
      itemId: "manual-race", originatingUrl: "https://example.test/jobs/race",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let retryContext: Record<string, unknown> = {};
    let sourceId = item.sourceId;
    const queue = vi.fn(async () => ({ ok: true as const, items: [{ ...item, sourceId, retryContext }] }));
    const importManualCapture = vi.fn(() => pending);
    renderWithProviders(<DiscoveryProductControls layout="tabs" />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Manual capture" }));
    const button = await screen.findByRole("button", { name: /import https:\/\/example.test\/jobs\/race/i });
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(await screen.findByRole("option", { name: "Saved HTML" }));
    await user.type(screen.getByLabelText("Saved HTML"), "Submitted content with newer edits");
    await user.clear(screen.getByLabelText("Source URL"));
    await user.type(screen.getByLabelText("Source URL"), "https://example.test/jobs/new");
    await user.type(screen.getByLabelText("Note"), "Newer note");
    await user.click(screen.getByRole("checkbox", { name: "Needs manual follow-up" }));
    await user.click(button);
    expect(screen.getByRole("status")).toHaveTextContent("Importing capture");
    expect(screen.getByRole("combobox", { name: "Capture mode" })).toBeDisabled();
    expect(screen.getByLabelText("Saved HTML")).toBeDisabled();
    expect(screen.getByLabelText("Source URL")).toBeDisabled();
    expect(screen.getByLabelText("Note")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("checkbox", { name: "Needs manual follow-up" }));
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toBeChecked();
    await user.type(screen.getByLabelText("Saved HTML"), " ignored while pending");
    expect(screen.getByLabelText("Saved HTML")).toHaveValue("Submitted content with newer edits");
    await user.click(screen.getByRole("tab", { name: "Source registry" }));
    await user.click(screen.getByRole("tab", { name: "Manual capture" }));
    expect(screen.getByLabelText("Saved HTML")).toHaveValue("Submitted content with newer edits");
    expect(screen.getByLabelText("Saved HTML")).toBeDisabled();

    retryContext = { manual_capture_page_decision: "posting_unverified", manual_capture_draft: {
      token: "saved-token", capture_mode: "saved_html", captured_url: "https://example.test/jobs/new",
      content: "Submitted content with newer edits", note: "", future_manual_action_required: false,
    } };
    sourceId = "manual:refreshed";
    rejectImport(rejectedCapture());
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the retained capture and try again");
    await screen.findByText("manual:refreshed");
    expect(screen.getByText("The captured page was not identified as one job posting.")).toBeInTheDocument();
    expect(queue).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Saved HTML")).toHaveValue("Submitted content with newer edits");
    expect(screen.getByLabelText("Source URL")).toHaveValue("https://example.test/jobs/new");
    expect(screen.getByLabelText("Note")).toHaveValue("Newer note");
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toBeChecked();
    expect(screen.getByLabelText("Saved HTML")).toBeDisabled();
    await recoverCapture(user, "Saved HTML");

    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/race/i }));
    expect(importManualCapture).toHaveBeenLastCalledWith("manual-race", {
      expectedLifecycleId: expect.stringMatching(/^f[0-9a-f]{63}$/),
      captureMode: "saved_html", capturedUrl: "https://example.test/jobs/new",
      contentHtmlBase64: btoa("Submitted content with newer edits"), note: "Newer note", futureManualActionRequired: true,
    });
  });

  it("prevents unsubmitted edits while a successful capture import is pending", async () => {
    const item = {
      itemId: "manual-success", originatingUrl: "https://example.test/jobs/success",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: {
        token: "old", capture_mode: "pasted_text", captured_url: "https://example.test/jobs/success",
        content: "Saved page", note: "", future_manual_action_required: false,
      } },
    };
    const success = { ok: true as const, itemId: item.itemId, jobKey: item.originatingUrl,
      importedAt: "2026-05-15T11:00:00+00:00", provenance: {
        sourceKind: "user_mediated_capture" as const, originatingUrl: item.originatingUrl,
        captureMode: "pasted_text" as const, futureManualActionRequired: false,
      } };
    let finish: (value: typeof success) => void = () => {};
    const pending = new Promise<typeof success>((resolve) => { finish = resolve; });
    let active = true;
    const importManualCapture = vi.fn(() => pending);
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: active ? [item] : [] })),
        importManualCapture,
      } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.type(content, " edited before submit");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/success/i }));
    expect(content).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Capture mode" })).toBeDisabled();
    expect(screen.getByLabelText("Note")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("checkbox", { name: "Needs manual follow-up" }));
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).not.toBeChecked();
    await user.type(content, " ignored during import");
    expect(content).toHaveValue("Saved page edited before submit");
    expect(importManualCapture).toHaveBeenCalledWith("manual-success", expect.objectContaining({
      contentText: "Saved page edited before submit",
    }));
    active = false;
    finish(success);
    await screen.findByText("No manual captures.");
  });

  it("leaves other capture rows editable while one import is pending", async () => {
    let reject: (reason: Error) => void = () => {};
    const pending = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const items = ["one", "two"].map((id) => ({
      itemId: `manual-${id}`, originatingUrl: `https://example.test/jobs/${id}`,
      sourceId: `manual:${id}`, reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: {},
    }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items })),
        importManualCapture: vi.fn(() => pending),
      } }),
    });
    const user = userEvent.setup();
    await screen.findByText("manual:one");
    const first = () => screen.getByText("manual:one").closest<HTMLElement>(".manual-capture-row")!;
    const second = screen.getByText("manual:two").closest<HTMLElement>(".manual-capture-row")!;
    const originalFirst = first();
    await user.click(within(originalFirst).getByRole("button", { name: /import/i }));
    await waitFor(() => expect(first()).not.toBe(originalFirst));
    expect(within(first()).getByLabelText("Captured URL")).toBeDisabled();
    expect(within(second).getByLabelText("Captured URL")).toBeEnabled();
    expect(within(second).getByRole("button", { name: /import/i })).toBeEnabled();
    await user.type(within(second).getByLabelText("Note"), "Keep editing another capture");
    reject(rejectedCapture());
    expect(await within(first()).findByRole("alert")).toHaveTextContent("Review the retained capture");
    expect(within(first()).getByLabelText("Captured URL")).toBeDisabled();
    expect(within(second).getByLabelText("Note")).toHaveValue("Keep editing another capture");
  });

  it("holds a successful capture until a failed queue refresh can be retried", async () => {
    const item = {
      itemId: "manual-stale", originatingUrl: "https://example.test/jobs/stale",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: {
        token: "old", capture_mode: "pasted_text", captured_url: "https://example.test/jobs/stale",
        content: "Saved page", note: "", future_manual_action_required: false,
      } },
    };
    let calls = 0;
    const queue = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true as const, items: [item] };
      if (calls === 2) throw new Error("synthetic queue failure");
      return { ok: true as const, items: [] };
    });
    const importManualCapture = vi.fn(async () => ({
      ok: true as const, itemId: item.itemId, jobKey: item.originatingUrl,
      importedAt: "2026-05-15T11:00:00+00:00", provenance: {
        sourceKind: "user_mediated_capture" as const, originatingUrl: item.originatingUrl,
        captureMode: "pasted_text" as const, futureManualActionRequired: false,
      },
    }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.type(content, " edited before submit");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/stale/i }));
    expect(await screen.findByText("Import completed, but the capture queue could not refresh.")).toBeInTheDocument();
    expect(screen.getByText("Your submission completed. Its local copy is available below.")).toBeInTheDocument();
    expect(screen.queryByText(/submission's outcome is unconfirmed/i)).not.toBeInTheDocument();
    const retainedContent = screen.getByLabelText("Pasted text");
    expect(retainedContent).toBeDisabled();
    await user.type(retainedContent, " ignored while waiting");
    expect(retainedContent).toHaveValue("Saved page edited before submit");
    expect(importManualCapture).toHaveBeenCalledWith("manual-stale", expect.objectContaining({
      contentText: "Saved page edited before submit",
    }));
    await user.click(screen.getByRole("button", { name: "Retry queue refresh" }));
    await screen.findByText("No manual captures.");
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it("offers queue refresh retry even if the imported row already disappeared", async () => {
    const item = {
      itemId: "manual-gone", originatingUrl: "https://example.test/jobs/gone",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    };
    let calls = 0;
    const queue = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true as const, items: [item] };
      if (calls === 3) throw new Error("synthetic queue failure");
      return { ok: true as const, items: [] };
    });
    const success = {
        ok: true as const, itemId: item.itemId, jobKey: item.originatingUrl,
        importedAt: "2026-05-15T11:00:00+00:00", provenance: {
          sourceKind: "user_mediated_capture" as const, originatingUrl: item.originatingUrl,
          captureMode: "copied_url" as const, futureManualActionRequired: false,
        },
      };
    let finish: (value: typeof success) => void = () => {};
    const pending = new Promise<typeof success>((resolve) => { finish = resolve; });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture: vi.fn(() => pending) } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /import https:\/\/example.test\/jobs\/gone/i }));
    await act(async () => { await queryClient.invalidateQueries(); });
    await screen.findByText("No manual captures.");
    finish(success);
    await user.click(await screen.findByRole("button", { name: "Retry queue refresh" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry queue refresh" })).not.toBeInTheDocument());
    expect(queue).toHaveBeenCalledTimes(4);
  });

  it("keeps an unconfirmed import fenced through failed and still-pending queue reads", async () => {
    const item = {
      itemId: "manual-uncertain", originatingUrl: "https://example.test/jobs/uncertain",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: {
        capture_mode: "pasted_text", captured_url: "https://example.test/jobs/uncertain",
        content: "Saved page", note: "", future_manual_action_required: false,
      } },
    };
    let queueState: "pending" | "failure" | "gone" = "pending";
    const queue = vi.fn(async () => {
      if (queueState === "failure") throw new Error("queue unavailable");
      return { ok: true as const, items: queueState === "pending" ? [item] : [] };
    });
    const importManualCapture = vi.fn(async () => {
      queueState = "failure";
      throw new Error("connection lost after dispatch");
    });
    const view = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.type(content, " pre-submit edit");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/uncertain/i }));
    expect(await screen.findByText("Import outcome is unconfirmed. The capture queue could not refresh.")).toBeInTheDocument();
    expect(screen.queryByText(/Import failed\./)).not.toBeInTheDocument();
    await waitFor(() => expect(view.queryClient.getMutationCache().getAll().at(-1)?.state.error).toEqual(
      expect.objectContaining({ message: "Import outcome is unconfirmed. Check the capture queue before retrying." }),
    ));
    expect(content).toBeDisabled();
    expect(content).toHaveValue("Saved page pre-submit edit");
    view.rerender(<div />);
    view.rerender(<DiscoveryProductControls />);
    const restored = await screen.findByLabelText("Pasted text");
    expect(restored).toBeDisabled();
    expect(restored).toHaveValue("Saved page pre-submit edit");
    queueState = "pending";
    await user.click(screen.getByRole("button", { name: "Retry queue refresh" }));
    expect(await screen.findByText(/Import outcome is unconfirmed and the capture remains/)).toBeInTheDocument();
    expect(restored).toBeDisabled();
    expect(restored).toHaveValue("Saved page pre-submit edit");
    queueState = "gone";
    await user.click(screen.getByRole("button", { name: "Retry queue refresh" }));
    await screen.findByText("No manual captures.");
  });

  it("retains the import fence across a component unmount and remount", async () => {
    const item = {
      itemId: "manual-remount", originatingUrl: "https://example.test/jobs/remount",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: {
        capture_mode: "pasted_text", captured_url: "https://example.test/jobs/remount",
        content: "Submitted", note: "", future_manual_action_required: false,
      } },
    };
    const success = { ok: true as const, itemId: item.itemId, jobKey: item.originatingUrl,
      importedAt: "2026-05-15T11:00:00+00:00", provenance: {
        sourceKind: "user_mediated_capture" as const, originatingUrl: item.originatingUrl,
        captureMode: "pasted_text" as const, futureManualActionRequired: false,
      } };
    let finish: (value: typeof success) => void = () => {};
    const pending = new Promise<typeof success>((resolve) => { finish = resolve; });
    let active = true;
    const view = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: active ? [item] : [] })),
        importManualCapture: vi.fn(() => pending),
      } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " pre-submit edit");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/remount/i }));
    expect(screen.getByLabelText("Pasted text")).toBeDisabled();
    view.rerender(<div />);
    view.rerender(<DiscoveryProductControls />);
    const content = await screen.findByLabelText("Pasted text");
    expect(content).toBeDisabled();
    await user.type(content, " ignored while pending");
    expect(content).toHaveValue("Submitted pre-submit edit");
    active = false;
    finish(success);
    await screen.findByText("No manual captures.");
  });

  it("does not settle an import from a queue read started before it completed", async () => {
    const item = {
      itemId: "manual-old-read", originatingUrl: "https://example.test/jobs/old-read",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    };
    const success = { ok: true as const, itemId: item.itemId, jobKey: item.originatingUrl,
      importedAt: "2026-05-15T11:00:00+00:00", provenance: {
        sourceKind: "user_mediated_capture" as const, originatingUrl: item.originatingUrl,
        captureMode: "copied_url" as const, futureManualActionRequired: false,
      } };
    type QueueResult = { ok: true; items: typeof item[] };
    let finish: (value: typeof success) => void = () => {};
    let finishOldRead: (value: QueueResult) => void = () => {};
    const pending = new Promise<typeof success>((resolve) => { finish = resolve; });
    const oldRead = new Promise<QueueResult>((resolve) => { finishOldRead = resolve; });
    let calls = 0;
    const queue = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true as const, items: [item] };
      if (calls === 2) return oldRead;
      if (calls === 3) throw new Error("fresh read unavailable");
      return { ok: true as const, items: [] };
    });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture: vi.fn(() => pending) } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /import https:\/\/example.test\/jobs\/old-read/i }));
    const refreshing = queryClient.invalidateQueries();
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    finish(success);
    expect(await screen.findByText("Import completed, but the capture queue could not refresh.")).toBeInTheDocument();
    finishOldRead({ ok: true, items: [] });
    await act(async () => { await refreshing; });
    expect(screen.getByLabelText("Captured URL")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry queue refresh" }));
    await screen.findByText("No manual captures.");
  });

  it("allows another capture to import while the first needs queue refresh", async () => {
    const items = ["first", "second"].map((id) => ({
      itemId: id, originatingUrl: `https://example.test/jobs/${id}`,
      sourceId: `manual:${id}`, reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    }));
    let queueAvailable = true;
    const queue = vi.fn(async () => {
      if (!queueAvailable) throw new Error("queue unavailable");
      return { ok: true as const, items };
    });
    const importManualCapture = vi.fn(async (itemId: string) => {
      queueAvailable = false;
      return { ok: true as const, itemId, jobKey: "synthetic-job", importedAt: "2026-05-15T11:00:00Z", provenance: {
        sourceKind: "user_mediated_capture" as const, originatingUrl: `https://example.test/jobs/${itemId}`,
        captureMode: "copied_url" as const, futureManualActionRequired: false,
      } };
    });
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    await screen.findByText("manual:first");
    const first = () => screen.getByText("manual:first").closest<HTMLElement>(".manual-capture-row")!;
    const second = () => screen.getByText("manual:second").closest<HTMLElement>(".manual-capture-row")!;
    const originalFirst = first();
    await user.click(within(originalFirst).getByRole("button", { name: /import/i }));
    await waitFor(() => expect(first()).not.toBe(originalFirst));
    await within(first()).findByText("Import completed, but the capture queue could not refresh.");
    expect(within(first()).getByLabelText("Captured URL")).toBeDisabled();
    expect(within(second()).getByRole("button", { name: /import/i })).toBeEnabled();
    const originalSecond = second();
    await user.click(within(originalSecond).getByRole("button", { name: /import/i }));
    await waitFor(() => expect(second()).not.toBe(originalSecond));
    expect(importManualCapture).toHaveBeenCalledTimes(2);
    await within(second()).findByText("Import completed, but the capture queue could not refresh.");
    expect(within(first()).getByRole("button", { name: "Retry queue refresh" })).toBeEnabled();
    expect(within(second()).getByRole("button", { name: "Retry queue refresh" })).toBeEnabled();
  });

  it.each([
    { reason: "manual_capture_state_changed", terminal: true },
    { reason: "capture_replay_mismatch", terminal: true },
    { reason: "manual_capture_in_progress", terminal: false },
  ])("uses the structured $reason conflict without guessing from its message", async ({ reason, terminal }) => {
    const item = {
      itemId: "manual-conflict", originatingUrl: "https://example.test/jobs/conflict",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: {
        capture_mode: "pasted_text", captured_url: "https://example.test/jobs/conflict",
        content: "Saved page", note: "", future_manual_action_required: false,
      } },
    };
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
        importManualCapture: vi.fn(async () => {
          throw Object.assign(new Error("synthetic conflict"), {
            status: 409, writeOutcomeUnknown: false,
            responseBody: { error: "manual_capture_import_failed", reason },
          });
        }),
      } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/conflict/i }));
    if (terminal) {
      expect(await screen.findByRole("alert")).toHaveTextContent("Review the retained capture");
      expect(content).toBeDisabled();
      await recoverCapture(user, "Pasted text");
    } else {
      expect(await screen.findByText("Your submission did not start because another import was running.")).toBeInTheDocument();
      expect(content).toBeDisabled();
    }
  });

  it("keeps the unadmitted submission available when the competing import removes the row", async () => {
    const item = {
      itemId: "manual-conflict-winner", originatingUrl: "https://example.test/jobs/conflict-winner",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/conflict-winner",
        content: "Saved page", note: "", future_manual_action_required: false } },
    };
    let present = true;
    const view = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: present ? [item] : [] })),
        importManualCapture: vi.fn(async () => {
          present = false;
          throw Object.assign(new Error("another import"), { status: 409, writeOutcomeUnknown: false,
            responseBody: { reason: "manual_capture_in_progress" } });
        }),
      } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.type(content, " from the losing submission");
    await user.type(screen.getByLabelText("Note"), "Local note");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/conflict-winner/i }));
    expect(await screen.findByText(/Your submission did not start\. Its local copy/)).toBeInTheDocument();
    expect(screen.getByLabelText("Saved submission content")).toHaveValue("Saved page from the losing submission");
    expect(screen.getByLabelText("Saved submission note")).toHaveValue("Local note");
    view.rerender(<div />);
    view.rerender(<DiscoveryProductControls />);
    expect(await screen.findByLabelText("Saved submission content")).toHaveValue("Saved page from the losing submission");
    await user.click(screen.getByRole("button", { name: "Discard local copy" }));
    expect(screen.queryByLabelText("Saved submission content")).not.toBeInTheDocument();
  });

  it("lets the user explicitly fence earlier attempts before reviewing and retrying a conflict", async () => {
    const item = {
      itemId: "manual-conflict-ended", lifecycleId: "a".repeat(64), originatingUrl: "https://example.test/jobs/conflict-ended",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/conflict-ended",
        content: "Retained page", note: "", future_manual_action_required: false } },
    };
    let serverContent = "Retained page";
    const importer = vi.fn(async () => { serverContent = "Competing import's page"; throw Object.assign(new Error("another import"), {
      status: 409, writeOutcomeUnknown: false, responseBody: { reason: "manual_capture_in_progress" },
    }); });
    renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [{ ...item, retryContext: {
        manual_capture_draft: { ...item.retryContext.manual_capture_draft, content: serverContent },
      } }] })), importManualCapture: importer,
    } }) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " unadmitted edit");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/conflict-ended/i }));
    expect(await screen.findByLabelText("Saved submission content")).toHaveValue("Retained page unadmitted edit");
    expect(screen.getByLabelText("Pasted text")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Prevent earlier imports from saving" }));
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toBeEnabled());
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Retained page unadmitted edit");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/conflict-ended/i }));
    await screen.findByText("Your submission did not start because another import was running.");
    expect(importer).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Pasted text")).toBeDisabled();
  });

  it("keeps the local copy when the capture changes before explicit recovery", async () => {
    let lifecycleId = "a".repeat(64);
    let content = "Original page";
    const itemId = "manual-recovery-race";
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [{
        itemId, lifecycleId, originatingUrl: "https://example.test/jobs/recovery-race", sourceId: "manual:test",
        reason: "login_required" as const, requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
        retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/recovery-race",
          content, note: "", future_manual_action_required: false } },
      }] })),
      supersedeManualCapture: vi.fn(async () => {
        lifecycleId = "b".repeat(64); content = "New lifetime page";
        throw Object.assign(new Error("capture changed"), { status: 409, writeOutcomeUnknown: false });
      }),
      importManualCapture: vi.fn(async () => { throw Object.assign(new Error("another import"), {
        status: 409, writeOutcomeUnknown: false, responseBody: { reason: "manual_capture_in_progress" },
      }); }),
    } }) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " unadmitted");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/recovery-race/i }));
    await user.click(await screen.findByRole("button", { name: "Prevent earlier imports from saving" }));
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(await screen.findByLabelText("Saved submission content")).toHaveValue("Original page unadmitted");
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toHaveValue("New lifetime page"));
    expect(screen.getByLabelText("Pasted text")).toBeDisabled();
  });

  it.each([
    { status: 503, reason: "manual_capture_provider_failed" },
    { status: 500, reason: "manual_capture_database_failed" },
  ])("requires an explicit fence after a completed $reason", async ({ status, reason }) => {
    const item = {
      itemId: "manual-provider", originatingUrl: "https://example.test/jobs/provider",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/provider",
        content: "Retained page", note: "", future_manual_action_required: false } },
    };
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
        importManualCapture: vi.fn(async () => { throw Object.assign(new Error("provider unavailable"), {
          status, writeOutcomeUnknown: true, responseBody: { reason },
        }); }),
      } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.type(content, " submitted");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/provider/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the retained capture");
    expect(content).toBeDisabled();
    await recoverCapture(user, "Pasted text");
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Retained page submitted");
  });

  it.each([500, 503])("keeps an unstructured %s fenced even when a queue read still finds the capture", async (status) => {
    const item = {
      itemId: "manual-unknown-503", originatingUrl: "https://example.test/jobs/unknown-503",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    };
    renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
      importManualCapture: vi.fn(async () => { throw Object.assign(new Error("unavailable"), {
        status, writeOutcomeUnknown: true, responseBody: { error: "unavailable" },
      }); }),
    } }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^import https:\/\/example.test\/jobs\/unknown-503/i }));
    await screen.findByText(/Import outcome is unconfirmed and the capture remains/);
    expect(screen.getByLabelText("Captured URL")).toBeDisabled();
  });

  it("does not release a capture if recovery returns the same lifecycle", async () => {
    const lifecycleId = "a".repeat(64);
    const item = { itemId: "manual-invalid-recovery", lifecycleId, originatingUrl: "https://example.test/jobs/invalid-recovery",
      sourceId: "manual:test", reason: "login_required" as const, requiredAt: "2026-05-15T10:00:00+00:00",
      status: "pending" as const, retryContext: { manual_capture_draft: { capture_mode: "pasted_text",
        captured_url: "https://example.test/jobs/invalid-recovery", content: "Retained page" } } };
    renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
      importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
      supersedeManualCapture: vi.fn(async (_itemId, expectedLifecycleId) => ({ ok: true as const, itemId: item.itemId, lifecycleId: expectedLifecycleId })),
    } }) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " local edit");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/invalid-recovery/i }));
    await user.click(await screen.findByRole("button", { name: "Prevent earlier imports from saving" }));
    await screen.findByText("Could not prepare this capture for review. Its local copy is still available.");
    expect(screen.getByLabelText("Pasted text")).toBeDisabled();
    expect(screen.getByLabelText("Saved submission content")).toHaveValue("Retained page local edit");
  });

  it("keeps a local copy unconfirmed when the queue item disappears after a transport failure", async () => {
    const item = {
      itemId: "manual-unknown-gone", originatingUrl: "https://example.test/jobs/unknown-gone",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/unknown-gone",
        content: "Original page", note: "", future_manual_action_required: false } },
    };
    let present = true;
    renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: present ? [item] : [] })),
      importManualCapture: vi.fn(async () => { present = false; throw new Error("connection lost"); }),
    } }) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " my edit");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/unknown-gone/i }));
    expect(await screen.findByLabelText("Saved submission content")).toHaveValue("Original page my edit");
    expect(screen.getByText(/submission's outcome is unconfirmed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Your submission did not start/)).not.toBeInTheDocument();
  });

  it("does not submit or dismiss a capture from a server without lifecycle identities", async () => {
    const item = {
      itemId: "legacy-capture", originatingUrl: "https://example.test/jobs/legacy-capture",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    };
    const importer = vi.fn();
    const dismiss = vi.fn();
    renderWithProviders(<DiscoveryProductControls />, { ports: buildBaseTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
      importManualCapture: importer, dismissManualCapture: dismiss,
    } }) });
    expect(await screen.findByText(/review lifetime could not be verified/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/legacy-capture/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^dismiss https:\/\/example.test\/jobs\/legacy-capture/i })).toBeDisabled();
    expect(importer).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("forgets a rejected draft after dismissal and does not overwrite a reopened item", async () => {
    const item = {
      itemId: "manual-reopen", originatingUrl: "https://example.test/jobs/reopen",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let active = true;
    let content = "Old server page";
    const queue = vi.fn(async () => ({ ok: true as const, items: active ? [{ ...item, retryContext: {
      manual_capture_draft: { capture_mode: "pasted_text", captured_url: item.originatingUrl,
        content, note: "", future_manual_action_required: false },
    } }] : [] }));
    const view = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: queue,
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
        dismissManualCapture: vi.fn(async () => {
          active = false;
          return { ok: true as const, itemId: item.itemId, status: "dismissed" as const, dismissedAt: "2026-05-15T11:00:00Z" };
        }),
      } }),
    });
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Pasted text");
    await user.clear(field);
    await user.type(field, "Old rejected edit");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/reopen/i }));
    await screen.findByRole("alert");
    await recoverCapture(user, "Pasted text");
    await user.click(screen.getByRole("button", { name: /dismiss https:\/\/example.test\/jobs\/reopen/i }));
    await screen.findByText("No manual captures.");
    active = true;
    content = "New reopened server page";
    await act(async () => { await view.queryClient.invalidateQueries(); });
    expect(await screen.findByLabelText("Pasted text")).toHaveValue("New reopened server page");
  });

  it("forgets the old edit when dismissal and reopening happen between queue reads", async () => {
    const item = {
      itemId: "manual-quick-reopen", originatingUrl: "https://example.test/jobs/quick-reopen",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let content = "Old server page";
    const queue = vi.fn(async () => ({ ok: true as const, items: [{ ...item, retryContext: {
      manual_capture_draft: { capture_mode: "pasted_text", captured_url: item.originatingUrl,
        content, note: "", future_manual_action_required: false },
    } }] }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: queue,
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
        dismissManualCapture: vi.fn(async () => {
          content = "New reopened server page";
          return { ok: true as const, itemId: item.itemId, status: "dismissed" as const, dismissedAt: "2026-05-15T11:00:00Z" };
        }),
      } }),
    });
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Pasted text");
    await user.clear(field);
    await user.type(field, "Old rejected edit");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/quick-reopen/i }));
    await screen.findByRole("alert");
    await recoverCapture(user, "Pasted text");
    await user.click(screen.getByRole("button", { name: /dismiss https:\/\/example.test\/jobs\/quick-reopen/i }));
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toHaveValue("New reopened server page"));
  });

  it.each([false, true])("does not restore a dismissed client's edits after another client reopens the same item (absent read: %s)", async (observeAbsent) => {
    const item = {
      itemId: "manual-cross-client", originatingUrl: "https://example.test/jobs/cross-client",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let lifecycleId = "a".repeat(64);
    let content = "Old page";
    let present = true;
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: present ? [{ ...item, lifecycleId, retryContext: {
          manual_capture_draft: { capture_mode: "pasted_text", captured_url: item.originatingUrl,
            content, note: "", future_manual_action_required: false },
        } }] : [] })),
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
      } }),
    });
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Pasted text");
    await user.type(field, " dismissed local edit");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/cross-client/i }));
    await screen.findByRole("alert");
    if (observeAbsent) {
      present = false;
      await act(async () => { await queryClient.invalidateQueries(); });
      await screen.findByText("No manual captures.");
    }
    present = true;
    lifecycleId = "b".repeat(64);
    content = "New reopened page";
    await act(async () => { await queryClient.invalidateQueries(); });
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toHaveValue("New reopened page"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["conflict", "transport"] as const)("preserves a held submission when a new lifetime arrives before the %s response", async (result) => {
    const itemId = "manual-held-cross-client";
    let lifecycleId = "a".repeat(64);
    let content = "Old page";
    let rejectImport: (error: Error) => void = () => {};
    const pending = new Promise<never>((_resolve, reject) => { rejectImport = reject; });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, { ports: buildTestPorts({ api: {
      manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [{
        itemId, lifecycleId, originatingUrl: "https://example.test/jobs/held-cross-client", sourceId: "manual:test",
        reason: "login_required" as const, requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
        retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/held-cross-client",
          content, note: "", future_manual_action_required: false } },
      }] })),
      importManualCapture: vi.fn(() => pending),
    } }) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " held edit");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/held-cross-client/i }));
    lifecycleId = "b".repeat(64);
    content = "New reopened page";
    await act(async () => { await queryClient.invalidateQueries(); });
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toHaveValue("New reopened page"));
    expect(screen.getByLabelText("Pasted text")).toBeDisabled();
    rejectImport(result === "conflict" ? Object.assign(new Error("another import"), { status: 409, writeOutcomeUnknown: false,
      responseBody: { reason: "manual_capture_in_progress" } }) : new Error("connection lost"));
    expect(await screen.findByLabelText("Saved submission content")).toHaveValue("Old page held edit");
    if (result === "transport") {
      expect(screen.getByText(/submission's outcome is unconfirmed/i)).toBeInTheDocument();
      expect(screen.queryByText(/Your submission did not start/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(/Your submission did not start/)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Pasted text")).toHaveValue("New reopened page");
  });

  it("fences only the dismissed row while its post-dismissal read is held", async () => {
    const makeItem = (id: string, content: string) => ({
      itemId: id, originatingUrl: `https://example.test/jobs/${id}`,
      sourceId: `manual:${id}`, reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: `https://example.test/jobs/${id}`,
        content, note: "", future_manual_action_required: false } },
    });
    const initial = [makeItem("held-dismiss", "Old server page"), makeItem("other", "Other page")];
    type QueueResult = { ok: true; items: typeof initial };
    let finishRefresh: (value: QueueResult) => void = () => {};
    const heldRefresh = new Promise<QueueResult>((resolve) => { finishRefresh = resolve; });
    let reads = 0;
    const queue = vi.fn(async () => {
      reads += 1;
      return reads === 4 ? heldRefresh : { ok: true as const, items: initial };
    });
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: queue,
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
        dismissManualCapture: vi.fn(async () => ({
          ok: true as const, itemId: "held-dismiss", status: "dismissed" as const, dismissedAt: "2026-05-15T11:00:00Z",
        })),
      } }),
    });
    const user = userEvent.setup();
    await screen.findByText("manual:held-dismiss");
    const first = () => screen.getByText("manual:held-dismiss").closest<HTMLElement>(".manual-capture-row")!;
    const other = screen.getByText("manual:other").closest<HTMLElement>(".manual-capture-row")!;
    const originalFirst = first();
    await user.type(within(originalFirst).getByLabelText("Pasted text"), " submitted");
    await user.click(within(originalFirst).getByRole("button", { name: /import/i }));
    await waitFor(() => expect(first()).not.toBe(originalFirst));
    await within(first()).findByRole("alert");
    await user.click(within(first()).getByRole("button", { name: "Prevent earlier imports from saving" }));
    await waitFor(() => expect(within(screen.getByText("manual:held-dismiss").closest<HTMLElement>(".manual-capture-row")!).getByLabelText("Pasted text")).toBeEnabled());
    await user.click(within(screen.getByText("manual:held-dismiss").closest<HTMLElement>(".manual-capture-row")!).getByRole("button", { name: /^dismiss /i }));
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(4));
    expect(screen.queryByText("manual:held-dismiss")).not.toBeInTheDocument();
    expect(within(other).getByLabelText("Pasted text")).toBeEnabled();
    finishRefresh({ ok: true, items: [makeItem("held-dismiss", "New reopened server page"), initial[1]!] });
    const reopened = (await screen.findByText("manual:held-dismiss")).closest<HTMLElement>(".manual-capture-row")!;
    expect(within(reopened).getByLabelText("Pasted text")).toHaveValue("New reopened server page");
    await waitFor(() => expect(within(reopened).getByLabelText("Pasted text")).toBeEnabled());
  });

  it("retains the rejected edit when dismissal fails", async () => {
    const item = {
      itemId: "manual-dismiss-failure", originatingUrl: "https://example.test/jobs/dismiss-failure",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/dismiss-failure",
        content: "Saved page", note: "", future_manual_action_required: false } },
    };
    const dismissManualCapture = vi.fn(async () => { throw new Error("synthetic dismissal failure"); });
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
        dismissManualCapture,
      } }),
    });
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Pasted text");
    await user.type(field, " submitted");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/dismiss-failure/i }));
    await screen.findByRole("alert");
    await recoverCapture(user, "Pasted text");
    const dismiss = screen.getByRole("button", { name: /dismiss https:\/\/example.test\/jobs\/dismiss-failure/i });
    await user.click(dismiss);
    await waitFor(() => expect(dismissManualCapture).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(dismiss).toBeEnabled());
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Saved page submitted");
    expect(screen.getByRole("alert")).toHaveTextContent("Review the retained capture");
  });

  it("removes a confirmed dismissal even if the following queue read fails", async () => {
    const item = {
      itemId: "manual-dismiss-read-failure", originatingUrl: "https://example.test/jobs/dismiss-read-failure",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    };
    const queue = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, items: [item] })
      .mockResolvedValueOnce({ ok: true as const, items: [item] })
      .mockResolvedValueOnce({ ok: true as const, items: [item] })
      .mockRejectedValue(new Error("synthetic queue failure"));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: queue,
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
        dismissManualCapture: vi.fn(async () => ({
          ok: true as const, itemId: item.itemId, status: "dismissed" as const, dismissedAt: "2026-05-15T11:00:00Z",
        })),
      } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^import https:\/\/example.test\/jobs\/dismiss-read-failure/i }));
    await screen.findByRole("alert");
    await recoverCapture(user);
    await user.click(screen.getByRole("button", { name: /^dismiss https:\/\/example.test\/jobs\/dismiss-read-failure/i }));
    expect(await screen.findByText("No manual captures.")).toBeInTheDocument();
    expect(await screen.findByText("synthetic queue failure")).toBeInTheDocument();
  });

  it("ignores a queue read started before a confirmed dismissal", async () => {
    const makeItem = (content: string) => ({
      itemId: "manual-old-dismiss-read", originatingUrl: "https://example.test/jobs/old-dismiss-read",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/old-dismiss-read",
        content, note: "", future_manual_action_required: false } },
    });
    type QueueResult = { ok: true; items: ReturnType<typeof makeItem>[] };
    let finishOldRead: (value: QueueResult) => void = () => {};
    const oldRead = new Promise<QueueResult>((resolve) => { finishOldRead = resolve; });
    let reads = 0;
    const queue = vi.fn(async (): Promise<QueueResult> => {
      reads += 1;
      if (reads === 4) return oldRead;
      return { ok: true, items: [makeItem(reads >= 5 ? "New reopened page" : "Old page")] };
    });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: queue,
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
        dismissManualCapture: vi.fn(async () => ({
          ok: true as const, itemId: "manual-old-dismiss-read", status: "dismissed" as const, dismissedAt: "2026-05-15T11:00:00Z",
        })),
      } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " submitted");
    await user.click(screen.getByRole("button", { name: /^import https:\/\/example.test\/jobs\/old-dismiss-read/i }));
    await screen.findByRole("alert");
    await recoverCapture(user, "Pasted text");
    const oldRefresh = queryClient.invalidateQueries();
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(4));
    await user.click(screen.getByRole("button", { name: /^dismiss https:\/\/example.test\/jobs\/old-dismiss-read/i }));
    await waitFor(() => expect(screen.getByLabelText("Pasted text")).toHaveValue("New reopened page"));
    finishOldRead({ ok: true, items: [makeItem("Old page")] });
    await act(async () => { await oldRefresh; });
    expect(screen.getByLabelText("Pasted text")).toHaveValue("New reopened page");
  });

  it("reports a known rejection when its queue refresh fails", async () => {
    const item = {
      itemId: "manual-rejected-refresh", originatingUrl: "https://example.test/jobs/rejected-refresh",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const, retryContext: {},
    };
    const queue = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, items: [item] })
      .mockRejectedValueOnce(new Error("synthetic queue failure"))
      .mockResolvedValue({ ok: true as const, items: [item] });
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture: vi.fn(async () => { throw rejectedCapture(); }) } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /import https:\/\/example.test\/jobs\/rejected-refresh/i }));
    expect(await screen.findByText("Import failed, but the capture queue could not refresh.")).toBeInTheDocument();
    expect(screen.getByLabelText("Captured URL")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry queue refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the retained capture");
    expect(screen.getByLabelText("Captured URL")).toBeDisabled();
    await recoverCapture(user);
  });

  it("restores corrections made after a rejected import on remount", async () => {
    const item = {
      itemId: "manual-corrected", originatingUrl: "https://example.test/jobs/corrected",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
      retryContext: { manual_capture_draft: { capture_mode: "pasted_text", captured_url: "https://example.test/jobs/corrected",
        content: "Saved page", note: "", future_manual_action_required: false } },
    };
    const view = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: {
        manualCaptureQueue: vi.fn(async () => ({ ok: true as const, items: [item] })),
        importManualCapture: vi.fn(async () => { throw rejectedCapture(); }),
      } }),
    });
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Pasted text");
    await user.type(field, " submitted");
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/corrected/i }));
    await screen.findByRole("alert");
    await recoverCapture(user, "Pasted text");
    await user.type(screen.getByLabelText("Pasted text"), " corrected");
    view.rerender(<div />);
    view.rerender(<DiscoveryProductControls />);
    expect(await screen.findByLabelText("Pasted text")).toHaveValue("Saved page submitted corrected");
  });

  it("refreshes a capture draft that has not been edited locally", async () => {
    const item = {
      itemId: "manual-fresh", originatingUrl: "https://example.test/jobs/fresh",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let retryContext: Record<string, unknown> = {};
    const queue = vi.fn(async () => ({ ok: true as const, items: [{ ...item, retryContext }] }));
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue } }),
    });
    await screen.findByRole("button", { name: /import https:\/\/example.test\/jobs\/fresh/i });
    retryContext = { manual_capture_draft: {
      token: "new-token", capture_mode: "pasted_text", captured_url: item.originatingUrl,
      content: "New server draft", note: "Fresh note", future_manual_action_required: true,
    } };
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(await screen.findByLabelText("Pasted text")).toHaveValue("New server draft");
    expect(screen.getByLabelText("Note")).toHaveValue("Fresh note");
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toBeChecked();
  });

  it("keeps an edited note while importing newer untouched server fields", async () => {
    const item = {
      itemId: "manual-sync", originatingUrl: "https://example.test/jobs/sync",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let retryContext: Record<string, unknown> = { manual_capture_draft: {
      token: "old", capture_mode: "pasted_text", captured_url: item.originatingUrl,
      content: "Old server page", note: "", future_manual_action_required: false,
    } };
    let active = true;
    const queue = vi.fn(async () => ({ ok: true as const, items: active ? [{ ...item, retryContext }] : [] }));
    const importManualCapture = vi.fn(async () => {
      active = false;
      return { ok: true as const, itemId: item.itemId, jobKey: item.originatingUrl,
        importedAt: "2026-05-15T11:00:00+00:00", provenance: {
          sourceKind: "user_mediated_capture" as const, originatingUrl: item.originatingUrl,
          captureMode: "pasted_text" as const, futureManualActionRequired: true,
        } };
    });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    expect(await screen.findByLabelText("Pasted text")).toHaveValue("Old server page");
    await user.type(screen.getByLabelText("Note"), "My local note");
    retryContext = { manual_capture_page_decision: "access_blocked", manual_capture_draft: {
      token: "new", capture_mode: "pasted_text", captured_url: "https://example.test/jobs/new",
      content: "Newer server page", note: "Server note", future_manual_action_required: true,
    } };
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(await screen.findByText("The captured page was identified as a login or access challenge.")).toBeInTheDocument();
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Newer server page");
    expect(screen.getByLabelText("Source URL")).toHaveValue("https://example.test/jobs/new");
    expect(screen.getByLabelText("Note")).toHaveValue("My local note");
    expect(screen.getByRole("checkbox", { name: "Needs manual follow-up" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/sync/i }));
    expect(importManualCapture).toHaveBeenLastCalledWith("manual-sync", {
      expectedLifecycleId: expect.stringMatching(/^f[0-9a-f]{63}$/),
      captureMode: "pasted_text", capturedUrl: "https://example.test/jobs/new",
      contentText: "Newer server page", note: "My local note", futureManualActionRequired: true,
    });
    await screen.findByText("No manual captures.");
  });

  it("binds a failed page decision to the displayed content, URL, and capture mode", async () => {
    const item = {
      itemId: "manual-decision", originatingUrl: "https://example.test/jobs/decision",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    const makeDraft = (content: string, note: string) => ({ manual_capture_draft: {
      token: content, capture_mode: "pasted_text", captured_url: item.originatingUrl,
      content, note, future_manual_action_required: false,
    } });
    let retryContext: Record<string, unknown> = makeDraft("Old server page", "Old note");
    const queue = vi.fn(async () => ({ ok: true as const, items: [{ ...item, retryContext }] }));
    const importManualCapture = vi.fn(async () => {
      retryContext = { ...makeDraft("My local page", "New server note"), manual_capture_page_decision: "posting_unverified" };
      throw rejectedCapture();
    });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    const content = await screen.findByLabelText("Pasted text");
    await user.clear(content);
    await user.type(content, "My local page");
    retryContext = { ...makeDraft("New server page", "New server note"), manual_capture_page_decision: "access_blocked" };
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(content).toHaveValue("My local page");
    await waitFor(() => expect(screen.getByLabelText("Note")).toHaveValue("New server note"));
    expect(screen.queryByText("The captured page was identified as a login or access challenge.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/decision/i }));
    expect(importManualCapture).toHaveBeenLastCalledWith("manual-decision", expect.objectContaining({
      contentText: "My local page", note: "New server note",
    }));
    const decision = "The captured page was not identified as one job posting.";
    expect(await screen.findByText(decision)).toBeInTheDocument();
    await recoverCapture(user, "Pasted text");
    await user.clear(screen.getByLabelText("Source URL"));
    expect(screen.queryByText(decision)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Source URL"), item.originatingUrl);
    expect(screen.getByText(decision)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(await screen.findByRole("option", { name: "Saved HTML" }));
    expect(screen.queryByText(decision)).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(await screen.findByRole("option", { name: "Pasted text" }));
    expect(screen.getByText(decision)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Pasted text"), " changed");
    expect(screen.queryByText(decision)).not.toBeInTheDocument();
  });

  it("fences locally edited content when a refresh switches to URL-only capture", async () => {
    const item = {
      itemId: "manual-mode", originatingUrl: "https://example.test/jobs/mode",
      sourceId: "manual:test", reason: "login_required" as const,
      requiredAt: "2026-05-15T10:00:00+00:00", status: "pending" as const,
    };
    let retryContext: Record<string, unknown> = { manual_capture_draft: {
      token: "old", capture_mode: "pasted_text", captured_url: item.originatingUrl,
      content: "Saved page", note: "", future_manual_action_required: false,
    } };
    const queue = vi.fn(async () => ({ ok: true as const, items: [{ ...item, retryContext }] }));
    const importManualCapture = vi.fn(async () => { throw rejectedCapture(); });
    const { queryClient } = renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({ api: { manualCaptureQueue: queue, importManualCapture } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Pasted text"), " with edits");
    retryContext = { manual_capture_draft: {
      token: "new", capture_mode: "copied_url", captured_url: item.originatingUrl,
      content: "", note: "", future_manual_action_required: false,
    } };
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(await screen.findByText(/Choose a content capture mode/)).toBeInTheDocument();
    expect(screen.getByLabelText("Edited content")).toHaveValue("Saved page with edits");
    const button = screen.getByRole("button", { name: /import https:\/\/example.test\/jobs\/mode/i });
    expect(button).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(await screen.findByRole("option", { name: "Pasted text" }));
    expect(screen.getByLabelText("Pasted text")).toHaveValue("Saved page with edits");
    expect(button).toBeEnabled();
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(await screen.findByRole("option", { name: "Copied URL" }));
    expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Discard edited content" }));
    expect(screen.queryByLabelText("Edited content")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    await user.click(button);
    expect(importManualCapture).toHaveBeenLastCalledWith("manual-mode", {
      expectedLifecycleId: expect.stringMatching(/^f[0-9a-f]{63}$/),
      captureMode: "copied_url", capturedUrl: item.originatingUrl, futureManualActionRequired: false,
    });
  });

  it("imports pasted manual capture content with follow-up provenance", async () => {
    const importManualCapture = vi.fn(async () => ({
      ok: true as const,
      itemId: "manual-1",
      jobKey: "https://example.com/protected/job",
      importedAt: "2026-05-12T10:00:00+00:00",
      provenance: {
        sourceKind: "user_mediated_capture" as const,
        originatingUrl: "https://example.com/protected/job",
        captureMode: "pasted_text" as const,
        futureManualActionRequired: true,
      },
    }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          importManualCapture,
        },
      }),
    });

    await screen.findByText("https://example.com/protected/job");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Capture mode" }));
    await user.click(
      await screen.findByRole("option", { name: "Pasted text" }),
    );
    await user.type(
      screen.getByLabelText("Pasted text"),
      "Visible user-provided posting text.",
    );
    await user.type(
      screen.getByLabelText("Note"),
      "Captured after local login.",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Needs manual follow-up" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /import https:\/\/example.com\/protected\/job/i,
      }),
    );

    await waitFor(() => expect(importManualCapture).toHaveBeenCalledTimes(1));
    expect(importManualCapture).toHaveBeenCalledWith("manual-1", {
      expectedLifecycleId: expect.stringMatching(/^f[0-9a-f]{63}$/),
      captureMode: "pasted_text",
      capturedUrl: "https://example.com/protected/job",
      contentText: "Visible user-provided posting text.",
      note: "Captured after local login.",
      futureManualActionRequired: true,
    });
  });

  it("rejects source locator candidates through the API port", async () => {
    const rejectSourceLocatorCandidate = vi.fn(async () => ({
      ok: true as const,
      candidateId: "candidate-1",
      decision: "reject" as const,
      source: null,
      decidedAt: "2026-05-12T10:00:00+00:00",
    }));

    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          rejectSourceLocatorCandidate,
        },
      }),
    });

    await screen.findByText("https://example.com/careers");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: /reject https:\/\/example.com\/careers/i,
      }),
    );

    await waitFor(() =>
      expect(rejectSourceLocatorCandidate).toHaveBeenCalledTimes(1),
    );
    expect(rejectSourceLocatorCandidate).toHaveBeenCalledWith("candidate-1", {
      reason: "User rejected source locator candidate from product controls.",
    });
  });
});
