import type { ContactCreateRequest } from "@jobctrl/contracts";
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
import { useCreateContactMutation } from "../hooks/useCreateContactMutation.js";

export interface ContactCreateButtonProps {
  jobId?: string;
  employer?: string;
  label?: string;
  className?: string;
}

export function ContactCreateButton({
  jobId,
  employer,
  label = "add contact",
  className,
}: ContactCreateButtonProps) {
  const [open, setOpen] = useState(false);
  const createContact = useCreateContactMutation();

  const handleSubmit = async (request: ContactCreateRequest) => {
    await createContact.mutateAsync(request);
    setOpen(false);
  };

  const initialValues: Partial<ContactFormValues> | undefined = employer ? { employer } : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          createContact.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={className ?? "tab on"}>
          {label}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>
            Record a contact and the provenance of every fact you enter.
          </DialogDescription>
        </DialogHeader>
        <ContactForm
          submitLabel="add contact"
          pending={createContact.isPending}
          {...(createContact.error ? { errorMessage: createContact.error.message } : {})}
          {...(initialValues ? { initialValues } : {})}
          {...(jobId ? { lockedJobId: jobId } : {})}
          onSubmit={handleSubmit}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
