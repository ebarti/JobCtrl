import type { ContactSummary } from "@jobctrl/contracts";

import { ContactProvenanceSummary } from "../../contexts/outreach/components/ContactProvenanceSummary.js";
import { ContactRoleBadge } from "../../contexts/outreach/components/ContactRoleBadge.js";
import { contactRoleLabel } from "../../contexts/outreach/lib/contact-copy.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

export function ContactMobileRow({ row }: { readonly row: ContactSummary }) {
  return (
    <div className="contact-mobile-row">
      <div className="contact-mobile-row__identity">
        <span data-typography="strong-body">{row.displayName}</span>
        <ContactRoleBadge role={row.role} />
      </div>
      <span className="contact-mobile-row__employer" data-typography="body">
        {row.employer || "No employer recorded"}
      </span>
      <ContactProvenanceSummary contact={row} />
      {row.jobId ? (
        <span className="contact-mobile-row__job" data-typography="metadata">
          Linked job: <code>{row.jobId}</code>
        </span>
      ) : null}
    </div>
  );
}

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
      render: (row) => (
        <span className="muted-cell">{row.employer || "-"}</span>
      ),
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
      getFilterSearchValue: (row) =>
        `${row.sourceKinds.join(" ")} ${row.confirmedCount}/${row.attributeCount}`,
      render: (row) => <ContactProvenanceSummary contact={row} />,
    },
  ];
}
