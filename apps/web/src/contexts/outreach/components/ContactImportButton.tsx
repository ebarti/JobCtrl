import { useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../shared/ui/dialog.js";
import { ContactImportWizard } from "../forms/contact-import-wizard.js";

export interface ContactImportButtonProps {
  label?: string;
  className?: string;
}

export function ContactImportButton({
  label = "Import CSV",
  className,
}: ContactImportButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            {...(className ? { className } : {})}
          />
        }
      >
        {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import contacts from CSV</DialogTitle>
          <DialogDescription>
            Paste CSV rows to import contacts. Every imported fact is recorded with imported-list
            provenance.
          </DialogDescription>
        </DialogHeader>
        <ContactImportWizard onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
