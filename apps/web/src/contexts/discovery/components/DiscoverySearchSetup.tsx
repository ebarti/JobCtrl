import type { ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../shared/ui/dialog.js";

export function DiscoverySearchSetup({ open, onOpenChange, reason, action }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly reason?: string | undefined;
  readonly action?: ReactNode;
}) {
  return <Dialog open={open && Boolean(reason)} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>Set up search cost tracking</DialogTitle><DialogDescription>{reason}</DialogDescription></DialogHeader>
      <p>Your search has not started. Your saved Search preferences remain in place.</p>
      {action}
    </DialogContent>
  </Dialog>;
}
