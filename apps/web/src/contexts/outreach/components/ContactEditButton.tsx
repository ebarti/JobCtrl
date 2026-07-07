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
import { ContactForm, type ContactFormValues } from "../forms/contact-form.js";
import { useUpdateContactMutation } from "../hooks/useUpdateContactMutation.js";
import { toContactAttributeKind } from "../lib/contact-copy.js";

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

export function ContactEditButton({ contact, label = "edit", className }: ContactEditButtonProps) {
  const [open, setOpen] = useState(false);
  const updateContact = useUpdateContactMutation();

  const handleSubmit = async (request: ContactCreateRequest) => {
    await updateContact.mutateAsync({ contactId: contact.contactId, body: request });
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          updateContact.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={className ?? "tab"}>
          {label}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
          <DialogDescription>
            Update this contact. Fact provenance is recorded server-side on save.
          </DialogDescription>
        </DialogHeader>
        <ContactForm
          submitLabel="save contact"
          pending={updateContact.isPending}
          {...(updateContact.error ? { errorMessage: updateContact.error.message } : {})}
          initialValues={toFormValues(contact)}
          onSubmit={handleSubmit}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
