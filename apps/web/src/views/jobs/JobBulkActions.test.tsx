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
        onMutateSelected={onMutate}
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
        onMutateSelected={() => {}}
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
        onMutateSelected={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /restore selected/i })).toBeInTheDocument();
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
        onMutateSelected={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /deleted jobs/i }));
    expect(onSet).toHaveBeenCalledWith("deleted");
  });
});
