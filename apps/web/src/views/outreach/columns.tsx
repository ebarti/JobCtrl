import type { ContactSummary } from "@jobctl/contracts";

import { ContactProvenanceSummary } from "../../contexts/outreach/components/ContactProvenanceSummary.js";
import { ContactRoleBadge } from "../../contexts/outreach/components/ContactRoleBadge.js";
import { contactRoleLabel } from "../../contexts/outreach/lib/contact-copy.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

export function contactColumns(): Array<DataGridColumn<ContactSummary>> {
  return [
    {
      id: "displayName",
      label: "Name",
      sortable: true,
      rowHeader: true,
      getFilterValue: (row) => row.displayName,
      render: (row) => <TitleStack primary={row.displayName} />,
    },
    {
      id: "role",
      label: "Role",
      sortable: true,
      getSortValue: (row) => contactRoleLabel(row.role),
      getFilterValue: (row) => contactRoleLabel(row.role),
      render: (row) => <ContactRoleBadge role={row.role} />,
    },
    {
      id: "employer",
      label: "Employer",
      sortable: true,
      getFilterValue: (row) => row.employer || "-",
      render: (row) => <span className="muted-cell">{row.employer || "-"}</span>,
    },
    {
      id: "jobId",
      label: "Job",
      sortable: true,
      getFilterValue: (row) => row.jobId || "-",
      render: (row) => <span className="mono">{row.jobId || "-"}</span>,
    },
    {
      id: "provenance",
      label: "Provenance",
      getFilterValue: (row) => row.sourceKinds.join(" ") || "none",
      getFilterSearchValue: (row) => `${row.sourceKinds.join(" ")} ${row.confirmedCount}/${row.attributeCount}`,
      render: (row) => <ContactProvenanceSummary contact={row} />,
    },
  ];
}
