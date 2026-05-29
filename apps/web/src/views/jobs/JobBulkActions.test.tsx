import type { ActionRunResponse } from "@jobhunter/contracts";
import { screen, waitFor } from "@testing-library/react";
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
    await user.click(screen.getByRole("button", { name: /delete permanently selected/i }));
    expect(onPermanentDelete).toHaveBeenCalledTimes(1);
  });

  it("calls onSetDeleted when switching tabs", async () => {
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
    await user.click(screen.getByRole("button", { name: /closed jobs/i }));
    expect(onSet).toHaveBeenCalledWith("closed");
    await user.click(screen.getByRole("button", { name: /deleted jobs/i }));
    expect(onSet).toHaveBeenCalledWith("deleted");
    await user.click(screen.getByRole("button", { name: /hidden jobs/i }));
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
});
