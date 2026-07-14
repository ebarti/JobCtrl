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
import { SectionTabs, SectionTabsList } from "../../shared/ui/section-tabs.js";
import { TabsContent, TabsTrigger } from "../../shared/ui/tabs.js";

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
  const stateTitle = errorMessage || "Loading contact.";

  return (
    <div
      className="route-page route-page--contact-detail"
      aria-label="Contact details"
    >
      {!contact ? (
        <section className="detail-route-state" aria-label="Contact state">
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
          <Empty title={stateTitle} />
        </section>
      ) : null}
      {contact ? (
        <SectionTabs className="contact-detail-tabs" defaultValue="outreach">
          <RouteWorkspace
            aria-label="Contact details"
            className="contact-detail-workspace"
            contentLabel="Contact workspace panels"
            inspectorLabel="Contact summary"
            tabs={
              <nav aria-label="Contact detail panels">
                <SectionTabsList>
                  <TabsTrigger value="outreach">Outreach</TabsTrigger>
                  <TabsTrigger value="provenance">Provenance</TabsTrigger>
                </SectionTabsList>
              </nav>
            }
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
                <span className="contact-detail-workspace__status">
                  <ContactRoleBadge role={contact.role} />
                </span>
                <div className="contact-detail-workspace__title">
                  <small>{contact.employer ?? "No employer"}</small>
                  <h1>{contact.displayName}</h1>
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
                    className={buttonVariants({ size: "sm", variant: "outline" })}
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
              <div className="contact-detail-workspace__inspector">
                <Section title="Contact summary">
                  <dl className="detail-list">
                    <div>
                      <dt>Role</dt>
                      <dd>{contact.role || "-"}</dd>
                    </div>
                    <div>
                      <dt>Employer</dt>
                      <dd>{contact.employer || "-"}</dd>
                    </div>
                    <div>
                      <dt>Job</dt>
                      <dd>{contact.jobId || "-"}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatDateTime(contact.updatedAt)}</dd>
                    </div>
                  </dl>
                </Section>
              </div>
            }
          >
            <TabsContent
              className="contact-detail-workspace__panel"
              forceMount
              value="outreach"
            >
              <OutreachThreadPanel contactId={contact.contactId} />
            </TabsContent>
            <TabsContent
              className="contact-detail-workspace__panel"
              forceMount
              value="provenance"
            >
              <Section title="Facts and provenance">
                <ContactProvenanceList attributes={contact.attributes} />
              </Section>
            </TabsContent>
          </RouteWorkspace>
        </SectionTabs>
      ) : null}
    </div>
  );
}
