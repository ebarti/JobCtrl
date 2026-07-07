import type { ContactListResponse, ContactSummary } from "@jobctl/contracts";

import { FilterableDataGrid } from "../../shared/ui/filterable-data-grid.js";
import { contactColumns } from "./columns.js";

export interface OutreachTableProps {
  data: ContactListResponse | null;
  loading: boolean;
  onOpenContact: (contactId: string) => void;
}

export function OutreachTable({ data, loading, onOpenContact }: OutreachTableProps) {
  return (
    <FilterableDataGrid<ContactSummary>
      title="Contacts table"
      data={data?.items ?? []}
      columns={contactColumns()}
      getRowId={(row) => row.contactId}
      loading={loading}
      loadingMessage="Loading contacts."
      emptyMessage="No contacts match."
      initialSort={{ columnId: "displayName", direction: "asc" }}
      onRowActivate={(row) => onOpenContact(row.contactId)}
      rowActivationLabel={(row) => `Open contact ${row.displayName}`}
      tableClassName="contacts-data-grid-table"
    />
  );
}
