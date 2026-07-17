import type { ActionRunResponse } from "@jobctrl/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../demo/ports.js";
import { renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { JobBulkActions } from "./JobBulkActions.js";

const originalConfirm = globalThis.window?.confirm;

const baseSearch = {
  q: "",
  stage: "all" as const,
  state: "all" as const,
  applyStatus: "all" as const,
  deleted: "active" as const,
  sort: "discovered_at" as const,
  dir: "desc" as const,
  page: 1,
  pageSize: 50,
};

function queued(
  action: ActionRunResponse["action"],
  jobKey: string,
): ActionRunResponse {
  return {
    ok: true,
    runId: `run-${action}`,
    actionId: `action-${action}`,
    action,
    status: "queued",
    jobKey,
    command: { action, jobKey },
  };
}

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: originalConfirm,
    });
  }
});

describe("<JobBulkActions>", () => {
  it("renders queue navigation as tabs above the bulk actions", () => {
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, deleted: "deleted" }}
        selectedCount={2}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );

    const queueTabs = screen.getByRole("tablist", { name: "Job queues" });
    expect(queueTabs).toHaveClass("jobs-queue-tabs");
    expect(
      within(queueTabs).getByRole("tab", { name: "Deleted" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(queueTabs).getByRole("tab", { name: "Active" }),
    ).toHaveAttribute("aria-selected", "false");
    expect(
      within(queueTabs).queryByRole("tab", { name: "Closed" }),
    ).not.toBeInTheDocument();
    const queueRow = queueTabs.closest(".jobs-queue-navigation");
    const actionsRow = document.querySelector(".jobs-bulk-actions");
    expect(queueRow?.nextElementSibling).toBe(actionsRow);
    expect(
      screen.getByRole("button", { name: "hide selected" }),
    ).toHaveTextContent(/^hide$/);
    const permanentlyDelete = screen.getByRole("button", {
      name: "permanently delete selected",
    });
    expect(permanentlyDelete).toHaveTextContent(/^permanently delete$/);
    expect(permanentlyDelete).toHaveClass(
      "bg-destructive",
      "hover:bg-destructive/90",
      "focus-visible:ring-destructive",
    );
    expect(
      screen.getByRole("button", { name: "restore selected" }),
    ).toHaveTextContent(/^restore$/);
  });

  it("uses destructive Button states only for destructive lifecycle actions", () => {
    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );

    const deleteSelected = screen.getByRole("button", {
      name: "delete selected",
    });
    expect(deleteSelected).toBeDisabled();
    expect(deleteSelected).toHaveClass(
      "bg-destructive",
      "hover:bg-destructive/90",
      "focus-visible:ring-destructive",
      "disabled:bg-destructive/60",
      "disabled:opacity-100",
    );

    const hideSelected = screen.getByRole("button", { name: "hide selected" });
    expect(hideSelected).toHaveClass("border-border", "bg-card");
    expect(hideSelected).not.toHaveClass("bg-destructive");
  });

  it("keeps legacy lifecycle links readable without adding a Closed tab", () => {
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, deleted: "closed" }}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );

    expect(
      screen.queryByRole("tab", { name: "Closed" }),
    ).not.toBeInTheDocument();
    for (const name of ["Active", "Deleted", "Hidden"]) {
      expect(screen.getByRole("tab", { name })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }
    const legacyContext = screen.getByText(
      "Viewing posting availability exceptions from a legacy link.",
    );
    expect(legacyContext).toHaveAttribute("role", "status");
    expect(
      screen.queryByRole("button", { name: "rescore outdated scores" }),
    ).not.toBeInTheDocument();
  });

  it("omits the redundant selection instruction when nothing is selected", () => {
    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );

    expect(screen.queryByText("select jobs to manage")).not.toBeInTheDocument();
  });

  it("invokes onMutateSelected when the danger button is clicked", async () => {
    const user = userEvent.setup();
    const onMutate = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={3}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={onMutate}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /delete selected/i }));
    expect(onMutate).toHaveBeenCalledTimes(1);
  });

  it("disables the danger button when nothing is selected", () => {
    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /delete selected/i }),
    ).toBeDisabled();
  });

  it("flips to a restore label when the deleted tab is active", () => {
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, deleted: "deleted" }}
        selectedCount={2}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /restore selected/i }),
    ).toBeInTheDocument();
  });

  it("flips to an unhide label when the hidden tab is active", () => {
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, deleted: "hidden" }}
        selectedCount={2}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /unhide selected/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^hide selected$/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes onHideSelected from active jobs", async () => {
    const user = userEvent.setup();
    const onHide = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={1}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={onHide}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /hide selected/i }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("shows retry actions for active failed jobs", async () => {
    const user = userEvent.setup();
    const onRetrySelected = vi.fn();
    const onRetryAll = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, state: "failed" }}
        selectedCount={2}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
        onRetryFailedSelected={onRetrySelected}
        onRetryAllFailed={onRetryAll}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry selected/i }));
    await user.click(screen.getByRole("button", { name: /retry all failed/i }));

    expect(onRetrySelected).toHaveBeenCalledTimes(1);
    expect(onRetryAll).toHaveBeenCalledTimes(1);
  });

  it("disables unavailable demo automation without blocking local job organization", () => {
    const ports = buildTestPorts();
    ports.featureFlags = new DemoFeatureFlagAdapter();
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, state: "failed" }}
        selectedCount={2}
        selectedJobKeys={["job-1", "job-2"]}
        staleCount={1}
        selectedStaleKeys={["job-1"]}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
      { ports },
    );

    for (const name of [
      "refresh compensation",
      "rescore selected",
      "re-tailor selected",
      "retry selected",
      "continue pending prep",
      "retry all failed",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(
        /Disabled automation actions require the local app.*job organization remains available/i,
      );
    }
    expect(
      screen.getByRole("button", { name: "reset stale selected" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "hide selected" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "delete selected" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/getting-started",
    );
  });

  it("shows retry all failed for active jobs outside the failed filter", async () => {
    const user = userEvent.setup();
    const onRetryAll = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, state: "pending" }}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
        onRetryAllFailed={onRetryAll}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /retry selected/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry all failed/i }));

    expect(onRetryAll).toHaveBeenCalledTimes(1);
  });

  it("shows continue pending prep for active jobs", async () => {
    const user = userEvent.setup();
    const onRunPendingPreparation = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, state: "pending" }}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
        onRunPendingPreparation={onRunPendingPreparation}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /continue pending prep/i }),
    );

    expect(onRunPendingPreparation).toHaveBeenCalledTimes(1);
  });

  it("keeps retry all failed available while pending preparation is loading", async () => {
    const user = userEvent.setup();
    const onRetryAll = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, state: "pending" }}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        pendingPreparationLoading
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
        onRetryAllFailed={onRetryAll}
      />,
    );

    expect(
      screen.getByRole("button", { name: /continue pending prep/i }),
    ).toBeDisabled();
    const retryAllFailed = screen.getByRole("button", {
      name: /retry all failed/i,
    });
    expect(retryAllFailed).not.toBeDisabled();

    await user.click(retryAllFailed);

    expect(onRetryAll).toHaveBeenCalledTimes(1);
  });

  it("hides continue pending prep outside active jobs", () => {
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, deleted: "hidden" }}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /continue pending prep/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes permanent delete from deleted jobs", async () => {
    const user = userEvent.setup();
    const onPermanentDelete = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={{ ...baseSearch, deleted: "deleted" }}
        selectedCount={1}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={onPermanentDelete}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /permanently delete selected/i }),
    );
    expect(onPermanentDelete).toHaveBeenCalledTimes(1);
  });

  it("navigates remaining queues by click and keyboard", async () => {
    const user = userEvent.setup();
    const onSet = vi.fn();
    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={onSet}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );
    expect(
      screen.queryByRole("tab", { name: "Closed" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Deleted" }));
    expect(onSet).toHaveBeenCalledWith("deleted");
    await user.click(screen.getByRole("tab", { name: "Hidden" }));
    expect(onSet).toHaveBeenCalledWith("hidden");

    const activeTab = screen.getByRole("tab", { name: "Active" });
    await user.click(activeTab);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Deleted" })).toHaveFocus();
    expect(onSet).toHaveBeenCalledWith("deleted");
  });

  it("sets the selected rescore limit high enough for more than 100 selected jobs", async () => {
    const user = userEvent.setup();
    const selectedJobKeys = Array.from(
      { length: 101 },
      (_, index) => `job-${index + 1}`,
    );
    const rescoreJobsNotOnCurrentScoringPolicy = vi.fn(async () =>
      queued("rescore_jobs_not_on_current_scoring_policy", "pipeline"),
    );
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: () => true,
    });

    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={selectedJobKeys.length}
        selectedJobKeys={selectedJobKeys}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
      {
        ports: buildTestPorts({
          api: { rescoreJobsNotOnCurrentScoringPolicy },
        }),
      },
    );

    await user.click(screen.getByRole("button", { name: "rescore selected" }));

    await waitFor(() =>
      expect(rescoreJobsNotOnCurrentScoringPolicy).toHaveBeenCalledWith({
        jobKeys: selectedJobKeys,
        limit: selectedJobKeys.length,
        dryRun: false,
      }),
    );
  });

  it("sets the selected re-tailor limit high enough for more than 100 selected jobs", async () => {
    const user = userEvent.setup();
    const selectedJobKeys = Array.from(
      { length: 101 },
      (_, index) => `job-${index + 1}`,
    );
    const retailorCurrentPolicy = vi.fn(async () =>
      queued("retailor_current_policy", "pipeline"),
    );
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: () => true,
    });

    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={selectedJobKeys.length}
        selectedJobKeys={selectedJobKeys}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
      {
        ports: buildTestPorts({ api: { retailorCurrentPolicy } }),
      },
    );

    await user.click(
      screen.getByRole("button", { name: "re-tailor selected" }),
    );

    await waitFor(() =>
      expect(retailorCurrentPolicy).toHaveBeenCalledWith({
        jobKeys: selectedJobKeys,
        limit: selectedJobKeys.length,
        dryRun: false,
        suppressExistingArtifacts: true,
        tailorModels: [],
      }),
    );
  });

  it("posts an all-jobs compensation refresh from the toolbar", async () => {
    const user = userEvent.setup();
    const refreshAllCompensation = vi.fn(async () =>
      queued("refresh_compensation", "pipeline"),
    );
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: () => true,
    });

    renderWithProviders(
      <JobBulkActions
        search={baseSearch}
        selectedCount={0}
        hasItems
        hasAnyMatching
        loading={false}
        onSetDeleted={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onPrimaryAction={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
      {
        ports: buildTestPorts({ api: { refreshAllCompensation } }),
      },
    );

    await user.click(
      screen.getByRole("button", { name: "refresh compensation" }),
    );

    await waitFor(() =>
      expect(refreshAllCompensation).toHaveBeenCalledWith({}),
    );
  });
});
