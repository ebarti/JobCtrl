import { JobCtrlApiError } from "@jobctrl/api-client";
import { IconArrowLeft } from "@tabler/icons-react";

import { ContactDeleteButton } from "../../contexts/outreach/components/ContactDeleteButton.js";
import { ContactEditButton } from "../../contexts/outreach/components/ContactEditButton.js";
import { ContactProvenanceList } from "../../contexts/outreach/components/ContactProvenanceList.js";
import { ContactRoleBadge } from "../../contexts/outreach/components/ContactRoleBadge.js";
import { OutreachThreadPanel } from "../../contexts/outreach/components/OutreachThreadPanel.js";
import { useContactDetailQuery } from "../../contexts/outreach/hooks/useContactDetailQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
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
    <div
      className="route-page route-page--contact-detail"
      aria-label="Contact details"
    >
      {errorMessage && !contact ? <Empty title={errorMessage} /> : null}
      {!contact && !errorMessage ? <Empty title="Loading contact." /> : null}
      {contact ? (
        <RouteWorkspace
          aria-label="Contact details"
          className="contact-detail-workspace"
          contentLabel="Outreach thread"
          inspectorLabel="Contact facts and provenance"
          header={
            <div className="contact-detail-workspace__header">
              <Button
                aria-label="Back to contacts"
                className="workspace-back"
                size="sm"
                type="button"
                variant="ghost"
                onClick={onClose}
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Contacts
              </Button>
              <span>
                <ContactRoleBadge role={contact.role} />
              </span>
              <div className="contact-detail-workspace__title">
                <small>{contact.employer ?? "No employer"}</small>
                <h1 data-typography="page-title">{contact.displayName}</h1>
                <p>
                  {contact.jobId
                    ? `Linked job ${contact.jobId}`
                    : "Not linked to a job"}{" "}
                  · updated {formatDateTime(contact.updatedAt)}
                </p>
              </div>
              <div className="contact-detail-actions">
                <ContactEditButton
                  contact={contact}
                  className={buttonVariants({
                    size: "sm",
                    variant: "outline",
                  })}
                />
                <ContactDeleteButton
                  className={buttonVariants({
                    size: "sm",
                    variant: "destructive",
                  })}
                  contactId={contact.contactId}
                  displayName={contact.displayName}
                  onDeleted={onClose}
                />
              </div>
            </div>
          }
          inspector={
            <Section title="Facts and provenance">
              <ContactProvenanceList attributes={contact.attributes} />
            </Section>
          }
        >
          <h2 className="sr-only">Outreach history</h2>
          <OutreachThreadPanel contactId={contact.contactId} />
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
