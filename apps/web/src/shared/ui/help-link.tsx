import { IconExternalLink } from "@tabler/icons-react";
import type { AnchorHTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

export interface HelpLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href: string;
}

export function HelpLink({
  children,
  className,
  target,
  rel,
  ...props
}: HelpLinkProps) {
  return (
    <a
      className={cn("help-link", className)}
      target={target}
      rel={target === "_blank" ? "noreferrer" : rel}
      {...props}
    >
      <span>{children}</span>
      <IconExternalLink aria-hidden="true" className="help-link__icon" size={14} stroke={1.8} />
    </a>
  );
}
