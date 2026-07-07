import type { ContactRole } from "@jobctrl/contracts";
import type { JSX } from "react";

import { contactRoleLabel } from "../lib/contact-copy.js";

export interface ContactRoleBadgeProps {
  role: ContactRole;
}

export function ContactRoleBadge({ role }: ContactRoleBadgeProps): JSX.Element {
  const label = contactRoleLabel(role);
  return (
    <span className={`tag contact-role-${role}`} title={`Contact role: ${label}`}>
      {label}
    </span>
  );
}
