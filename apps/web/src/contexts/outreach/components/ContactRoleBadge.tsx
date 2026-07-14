import type { ContactRole } from "@jobctrl/contracts";
import type { JSX } from "react";

import { StatusLabel } from "../../../shared/ui/status-label.js";
import { contactRoleLabel } from "../lib/contact-copy.js";

export interface ContactRoleBadgeProps {
  role: ContactRole;
}

export function ContactRoleBadge({ role }: ContactRoleBadgeProps): JSX.Element {
  const label = contactRoleLabel(role);
  return (
    <StatusLabel className={`contact-role-${role}`} title={`Contact role: ${label}`} tone="muted">
      {label}
    </StatusLabel>
  );
}
