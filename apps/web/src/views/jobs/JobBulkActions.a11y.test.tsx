import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { renderWithProviders } from "../../test/render.js";
import { JobBulkActions } from "./JobBulkActions.js";

describe("<JobBulkActions> a11y", () => {
  it("has no axe violations with queue tabs and selected actions", async () => {
    const view = renderWithProviders(
      <JobBulkActions
        search={jobsSearchSchema.parse({ deleted: "active" })}
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

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
