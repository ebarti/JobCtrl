import type { JSX, ReactNode } from "react";

import { Button } from "../../../shared/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../shared/ui/collapsible.js";

export interface AuditEvidenceReference {
  readonly entryId: string;
  readonly title: string;
  readonly excerpt: string | null;
}

export interface AuditReferenceLabel {
  /** Canonical foreign key retained independently from its display label. */
  readonly id: string;
  readonly label: string;
}

export type ResolveAuditEvidenceReference = (
  evidenceId: string,
) => AuditEvidenceReference | null | undefined;

export function AuditTechnicalDetails({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            className="h-auto min-h-0 self-start px-0 py-0"
            size="sm"
            type="button"
            variant="link"
          />
        }
      >
        Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
