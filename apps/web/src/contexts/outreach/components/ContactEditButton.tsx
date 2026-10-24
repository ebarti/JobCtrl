import { JobCtrlApiError } from "@jobctrl/api-client";
import type { ContactCreateRequest, ContactDetail } from "@jobctrl/contracts";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../shared/ui/dialog.js";
import { Button } from "../../../shared/ui/button.js";
import { ContactForm, type ContactFormValues } from "../forms/contact-form.js";
import { useUpdateContactMutation } from "../hooks/useUpdateContactMutation.js";
import { useContactDetailQuery } from "../hooks/useContactDetailQuery.js";
import { ContactProvenanceList } from "./ContactProvenanceList.js";
import { contactRoleLabel, toContactAttributeKind } from "../lib/contact-copy.js";

export interface ContactEditButtonProps {
  contact: ContactDetail;
  label?: string;
  className?: string;
}

function toFormValues(contact: ContactDetail): Partial<ContactFormValues> {
  return {
    role: contact.role,
    employer: contact.employer ?? "",
    jobId: contact.jobId ?? "",
    attributes: contact.attributes.map((attribute) => ({
      kind: toContactAttributeKind(attribute.kind),
      value: attribute.value,
    })),
  };
}

export function ContactEditButton({ contact, label = "Edit", className }: ContactEditButtonProps) {
  const [open, setOpen] = useState(false);
  const updateContact = useUpdateContactMutation();
  const currentContact = useContactDetailQuery(contact.contactId);
  const [session, setSession] = useState(contact);
  const [base, setBase] = useState(contact.fingerprint);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<ContactDetail | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const loadLatest = async () => {
    setLoadingLatest(true);
    setReadError(null);
    const result = await currentContact.refetch();
    if (result.isSuccess) setLatest(result.data.contact);
    else setReadError("Could not load the latest contact. Your draft is retained; try again.");
    setLoadingLatest(false);
  };

  const handleSubmit = async (request: ContactCreateRequest) => {
    if (conflict) return;
    try {
      await updateContact.mutateAsync({
        contactId: session.contactId,
        body: { ...request, employer: request.employer ?? null, jobId: request.jobId ?? null, expectedFingerprint: base },
      });
      setOpen(false);
    } catch (error) {
      if (error instanceof JobCtrlApiError && error.status === 409) {
        setConflict(true);
        setLatest(null);
      }
      // The mutation renders the failure. Keep the mounted form and pinned
      // snapshot intact through rollback and query invalidation.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSession(contact);
          setBase(contact.fingerprint);
          setConflict(false);
          setLatest(null);
          setReadError(null);
          updateContact.reset();
        }
        setOpen(next);
        if (!next) {
          updateContact.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" {...(className ? { className } : {})}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
          <DialogDescription>
            Update this contact. Fact provenance is recorded server-side on save.
          </DialogDescription>
        </DialogHeader>
        {conflict ? (
          <section aria-label="Contact save conflict" className="min-w-0 break-words">
            <p role="alert">This contact changed. Your draft is retained below. Load and review the latest record, then reconcile your fields before saving again.</p>
            <Button type="button" variant="outline" disabled={loadingLatest} onClick={() => void loadLatest()}>
              {loadingLatest ? "Loading…" : "Load latest contact"}
            </Button>
            {readError ? <p role="alert">{readError}</p> : null}
            {latest ? (
              <div>
                <h3>Latest saved contact</h3>
                <dl>
                  <dt>Role</dt><dd>{contactRoleLabel(latest.role)}</dd>
                  <dt>Employer</dt><dd>{latest.employer ?? "None"}</dd>
                  <dt>Job</dt><dd>{latest.jobId ?? "None"}</dd>
                </dl>
                <ContactProvenanceList attributes={latest.attributes} />
                <Button type="button" className="h-auto whitespace-normal text-left" onClick={() => {
                  setBase(latest.fingerprint);
                  setConflict(false);
                  updateContact.reset();
                }}>I reviewed the latest contact; keep my draft</Button>
              </div>
            ) : null}
          </section>
        ) : null}
        <ContactForm
          submitLabel="save contact"
          pending={updateContact.isPending}
          saveBlocked={conflict}
          {...(updateContact.error ? { errorMessage: updateContact.error.message } : {})}
          initialValues={toFormValues(session)}
          onSubmit={handleSubmit}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
