import type { ContactListResponse, ContactSummary } from "@jobctrl/contracts";

import { useIsMobile } from "../../shared/hooks/use-mobile.js";
import { FilterableDataGrid } from "../../shared/ui/filterable-data-grid.js";
import { ContactMobileRow, contactColumns } from "./columns.js";

export interface OutreachTableProps {
  data: ContactListResponse | null;
  loading: boolean;
  onOpenContact: (contactId: string) => void;
}

export function OutreachTable({
  data,
  loading,
  onOpenContact,
}: OutreachTableProps) {
  const isMobile = useIsMobile();
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
      mobileLayout="cards"
      {...(isMobile
        ? {
            mobileListLabel: "Contacts",
            renderMobileRow: (row) => <ContactMobileRow row={row} />,
          }
        : {})}
      onRowActivate={(row) => onOpenContact(row.contactId)}
      rowActivationAppearance={isMobile ? "visible" : "focus-only"}
      rowActivationLabel={(row) => `Open contact ${row.displayName}`}
      tableClassName="contacts-data-grid-table"
    />
  );
}
