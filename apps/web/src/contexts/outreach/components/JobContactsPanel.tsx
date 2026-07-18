import type { ContactSummary } from "@jobctrl/contracts";
import { useState } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { Button } from "../../../shared/ui/button.js";
import { useContactDetailQuery } from "../hooks/useContactDetailQuery.js";
import { useContactsListQuery } from "../hooks/useContactsListQuery.js";
import { ContactCreateButton } from "./ContactCreateButton.js";
import { ContactProvenanceList } from "./ContactProvenanceList.js";
import { ContactProvenanceSummary } from "./ContactProvenanceSummary.js";
import { ContactRoleBadge } from "./ContactRoleBadge.js";
import { ContactResearchPanel } from "./ContactResearchPanel.js";

export interface JobContactsPanelProps {
  jobId: string;
  employer?: string;
}

function JobContactProvenance({ contactId }: { contactId: string }) {
  const detailQuery = useContactDetailQuery(contactId);
  if (detailQuery.error instanceof Error) {
    return <div className="banner inline">{detailQuery.error.message}</div>;
  }
  if (!detailQuery.data) {
    return <Empty title="Loading provenance." />;
  }
  return <ContactProvenanceList attributes={detailQuery.data.contact.attributes} />;
}

function JobContactCard({ contact }: { contact: ContactSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="job-contact-row">
      <div className="job-contact-head">
        <ContactRoleBadge role={contact.role} />
        <span className="job-contact-name">{contact.displayName}</span>
        <ContactProvenanceSummary contact={contact} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide provenance" : "Show provenance"}
        </Button>
      </div>
      {open ? <JobContactProvenance contactId={contact.contactId} /> : null}
    </li>
  );
}

export function JobContactsPanel({ jobId, employer }: JobContactsPanelProps) {
  const contactsQuery = useContactsListQuery({ jobId });
  const contacts = contactsQuery.data?.items ?? [];
  const errorMessage = contactsQuery.error instanceof Error ? contactsQuery.error.message : "";

  return (
    <section className="section job-contacts-section" aria-label="Contacts">
      <div className="job-contacts-head">
        <h3>Contacts</h3>
        <ContactCreateButton jobId={jobId} {...(employer ? { employer } : {})} label="Add contact" />
      </div>
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {contacts.length === 0 && !errorMessage ? (
        <Empty title="No contacts linked to this job yet." />
      ) : (
        <ul className="job-contacts-list">
          {contacts.map((contact) => (
            <JobContactCard key={contact.contactId} contact={contact} />
          ))}
        </ul>
      )}
      <ContactResearchPanel jobId={jobId} {...(employer ? { employer } : {})} />
    </section>
  );
}
