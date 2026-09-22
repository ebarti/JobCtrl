import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { renderWithProviders } from "../../test/render.js";
import { JobBulkActions } from "./JobBulkActions.js";

describe("<JobBulkActions> a11y", () => {
  it("has no axe violations with mixed-state selected actions", async () => {
    const view = renderWithProviders(
      <JobBulkActions
        search={jobsSearchSchema.parse({ deleted: "active" })}
        selectedCount={2}
        selectedJobStates={["active", "hidden"]}
        hasItems
        hasAnyMatching
        loading={false}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onClearSelection={() => {}}
        onDeleteSelected={() => {}}
        onUnhideSelected={() => {}}
        onHideSelected={() => {}}
        onPermanentlyDeleteSelected={() => {}}
      />,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
