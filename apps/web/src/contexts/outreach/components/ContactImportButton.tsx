import { useId, useState } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
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
  label = "Import contacts",
  className,
}: ContactImportButtonProps) {
  const [open, setOpen] = useState(false);
  const unavailableReasonId = useId();
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "importContacts",
  );

  if (!availability.available) {
    return (
      <>
        <Button
          aria-describedby={unavailableReasonId}
          {...(className ? { className } : {})}
          disabled
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
        <span className="meta" id={unavailableReasonId}>
          CSV and vCard import are available in the local app. This demo never accepts
          personal contact data. <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      </>
    );
  }

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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            Preview CSV or vCard 3.0/4.0 content before committing it. Every imported fact is
            recorded with filename provenance.
          </DialogDescription>
        </DialogHeader>
        <ContactImportWizard onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
