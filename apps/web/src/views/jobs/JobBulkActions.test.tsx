import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { JobBulkActions } from "./JobBulkActions.js";

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

describe("<JobBulkActions>", () => {
  it("invokes onMutateSelected when the danger button is clicked", async () => {
    const user = userEvent.setup();
    const onMutate = vi.fn();
    render(
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
    render(
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
    render(
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
    render(
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
    render(
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
    render(
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
    render(
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
    render(
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
    await user.click(screen.getByRole("button", { name: /deleted jobs/i }));
    expect(onSet).toHaveBeenCalledWith("deleted");
    await user.click(screen.getByRole("button", { name: /hidden jobs/i }));
    expect(onSet).toHaveBeenCalledWith("hidden");
  });
});
