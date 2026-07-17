import { axe } from "jest-axe";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeJobsPage, sampleJob } from "../../test/fixtures/projections.js";
import { JobsTable } from "./JobsTable.js";

describe("<JobsTable> a11y", () => {
  it("keeps the focus-only row activation control accessible", async () => {
    const view = render(
      <JobsTable
        data={makeJobsPage([sampleJob])}
        loading={false}
        sorting={[{ id: "discovered_at", desc: true }]}
        onSortingChange={() => {}}
        rowSelection={{}}
        onRowSelectionChange={() => {}}
        allMatchingSelected={false}
        page={1}
        pageSize={50}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        onOpenJob={() => {}}
        columnOrder={[]}
        onColumnOrderChange={() => {}}
      />,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
