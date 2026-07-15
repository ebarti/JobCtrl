import { JobCtrlApiError } from "@jobctrl/api-client";

import { ContactDeleteButton } from "../../contexts/outreach/components/ContactDeleteButton.js";
import { ContactEditButton } from "../../contexts/outreach/components/ContactEditButton.js";
import { ContactProvenanceList } from "../../contexts/outreach/components/ContactProvenanceList.js";
import { ContactRoleBadge } from "../../contexts/outreach/components/ContactRoleBadge.js";
import { OutreachThreadPanel } from "../../contexts/outreach/components/OutreachThreadPanel.js";
import { useContactDetailQuery } from "../../contexts/outreach/hooks/useContactDetailQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { DetailDrawer } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";

export interface OutreachDetailDrawerProps {
  contactId: string;
  onClose: () => void;
}

function detailErrorTitle(error: unknown): string {
  if (error instanceof JobCtrlApiError && error.status === 404) {
    return "Contact not found.";
  }
  return error instanceof Error ? error.message : "";
}

export function OutreachDetailDrawer({
  contactId,
  onClose,
}: OutreachDetailDrawerProps) {
  const { data, error } = useContactDetailQuery(contactId);
  const errorMessage = detailErrorTitle(error);
  const contact = data?.contact;

  return (
    <DetailDrawer
      className="contact-detail-drawer"
      description="Review the selected contact's facts, provenance, and outreach history."
      onDismiss={onClose}
      title="Contact details"
    >
      {errorMessage && !contact ? <Empty title={errorMessage} /> : null}
      {!contact && !errorMessage ? <Empty title="Loading contact." /> : null}
      {contact ? (
        <>
          <div className="drawer-head">
            <span>
              <ContactRoleBadge role={contact.role} />
            </span>
            <span>
              <small>{contact.employer ?? "No employer"}</small>
              <h2>{contact.displayName}</h2>
              <p>
                {contact.jobId
                  ? `Linked job ${contact.jobId}`
                  : "Not linked to a job"}{" "}
                · updated {formatDateTime(contact.updatedAt)}
              </p>
            </span>
          </div>
          <div className="contact-detail-actions">
            <ContactEditButton contact={contact} />
            <ContactDeleteButton
              contactId={contact.contactId}
              displayName={contact.displayName}
              onDeleted={onClose}
            />
          </div>
          <Section title="Facts and provenance">
            <ContactProvenanceList attributes={contact.attributes} />
          </Section>
          <OutreachThreadPanel contactId={contact.contactId} />
        </>
      ) : null}
    </DetailDrawer>
  );
}
