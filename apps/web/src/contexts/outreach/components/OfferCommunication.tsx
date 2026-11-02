import { useId, useState } from "react";
import type { OutreachDraftKind } from "@jobctrl/contracts";
import { useContactsListQuery } from "../hooks/useContactsListQuery.js";
import { OutreachThreadPanel } from "./OutreachThreadPanel.js";
import { ContactRefreshNotice } from "./ContactRefreshNotice.js";
import { Field, FieldGroup, FieldLabel } from "../../../shared/ui/field.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";

const stages = [
  { value: "offer_negotiation", label: "Negotiate confirmed terms" },
  {
    value: "offer_clarification",
    label: "Ask about unknown terms or deadline",
  },
  { value: "offer_acceptance", label: "Confirm recorded acceptance" },
  { value: "offer_decline", label: "Confirm recorded decline" },
] as const;
/** Offer messages reuse every existing outreach review, copy and manual-send control. */
export function OfferCommunication({
  jobId,
  revisionId,
}: {
  jobId: string;
  revisionId: string;
}) {
  const id = useId();
  const contacts = useContactsListQuery({ jobId });
  const [contactId, setContactId] = useState<string | null>(null);
  const [kind, setKind] = useState<OutreachDraftKind>("offer_negotiation");
  return (
    <details>
      <summary>Draft an offer communication</summary>
      <p>
        Drafts use confirmed offer terms, canonical achievements and recorded
        compensation evidence. Review the gates and approve before copying. Send
        through your own channel, then log the send. Acceptance and decline
        drafts require your matching decision on these terms.
      </p>
      {contacts.error && !contacts.isRefetchError ? <p role="alert">{contacts.error.message}</p> : null}
      {contacts.error && !contacts.data ? <ContactRefreshNotice initial retry={() => { void contacts.refetch(); }} /> : null}
      {contacts.isRefetchError ? <ContactRefreshNotice retry={() => { void contacts.refetch(); }} /> : null}
      {contacts.isSuccess && !contacts.data?.items.length ? (
        <p>
          Link a confirmed contact in this job’s Contacts section to draft a
          message.
        </p>
      ) : contacts.data?.items.length ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-contact`}>Offer recipient</FieldLabel>
            <Select
              value={contactId}
              onValueChange={setContactId}
              items={contacts.data.items.map((contact) => ({
                value: contact.contactId,
                label: contact.displayName,
              }))}
            >
              <SelectTrigger id={`${id}-contact`}>
                <SelectValue placeholder="Choose a linked contact" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {contacts.data.items.map((contact) => (
                    <SelectItem
                      key={contact.contactId}
                      value={contact.contactId}
                    >
                      {contact.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-stage`}>
              Communication purpose
            </FieldLabel>
            <Select
              value={kind}
              items={stages}
              onValueChange={(value) => {
                if (value) setKind(value);
              }}
            >
              <SelectTrigger id={`${id}-stage`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {stages.map((stage) => (
                    <SelectItem key={stage.value} value={stage.value}>
                      {stage.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      ) : null}
      {contactId ? (
        <>
          <OutreachThreadPanel
            contactId={contactId}
            jobId={jobId}
            draftKind={kind}
            offerRevisionId={revisionId}
          />
        </>
      ) : null}
    </details>
  );
}
