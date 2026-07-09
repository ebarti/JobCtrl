import type { ActionRunResponse } from "@jobctrl/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function queued(action: ActionRunResponse["action"], jobKey: string): ActionRunResponse {
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
  it("separates job views from row actions and uses concise action labels", () => {
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

    const viewSwitcher = screen.getByRole("radiogroup", { name: "Job views" });
    expect(viewSwitcher).toHaveClass("job-view-switcher");
    expect(viewSwitcher).toHaveAttribute("data-variant", "outline");
    expect(within(viewSwitcher).getByRole("radio", { name: "deleted" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(viewSwitcher).getByRole("radio", { name: "active" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("button", { name: "hide selected" })).toHaveTextContent(/^hide$/);
    expect(
      screen.getByRole("button", { name: "permanently delete selected" }),
    ).toHaveTextContent(/^permanently delete$/);
    expect(screen.getByRole("button", { name: "restore selected" })).toHaveTextContent(
      /^restore$/,
    );
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
    expect(screen.getByRole("button", { name: /delete selected/i })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: /restore selected/i })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /unhide selected/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^hide selected$/i })).not.toBeInTheDocument();
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

    expect(screen.queryByRole("button", { name: /retry selected/i })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /continue pending prep/i }));

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

    expect(screen.getByRole("button", { name: /continue pending prep/i })).toBeDisabled();
    const retryAllFailed = screen.getByRole("button", { name: /retry all failed/i });
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

    expect(screen.queryByRole("button", { name: /continue pending prep/i })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /permanently delete selected/i }));
    expect(onPermanentDelete).toHaveBeenCalledTimes(1);
  });

  it("calls onSetDeleted when switching views", async () => {
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
    await user.click(screen.getByRole("radio", { name: /^closed$/i }));
    expect(onSet).toHaveBeenCalledWith("closed");
    await user.click(screen.getByRole("radio", { name: /^deleted$/i }));
    expect(onSet).toHaveBeenCalledWith("deleted");
    await user.click(screen.getByRole("radio", { name: /^hidden$/i }));
    expect(onSet).toHaveBeenCalledWith("hidden");
  });

  it("sets the selected rescore limit high enough for more than 100 selected jobs", async () => {
    const user = userEvent.setup();
    const selectedJobKeys = Array.from({ length: 101 }, (_, index) => `job-${index + 1}`);
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
        ports: buildTestPorts({ api: { rescoreJobsNotOnCurrentScoringPolicy } }),
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
    const selectedJobKeys = Array.from({ length: 101 }, (_, index) => `job-${index + 1}`);
    const retailorCurrentPolicy = vi.fn(async () => queued("retailor_current_policy", "pipeline"));
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

    await user.click(screen.getByRole("button", { name: "re-tailor selected" }));

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
    const refreshAllCompensation = vi.fn(async () => queued("refresh_compensation", "pipeline"));
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

    await user.click(screen.getByRole("button", { name: "refresh compensation" }));

    await waitFor(() => expect(refreshAllCompensation).toHaveBeenCalledWith({}));
  });
});
