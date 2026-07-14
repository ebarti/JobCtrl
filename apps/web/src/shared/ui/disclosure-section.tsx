import { IconChevronRight } from "@tabler/icons-react";
import { type HTMLAttributes, type ReactNode, useId, useState } from "react";

import { cn } from "../lib/cn.js";
import { HelpLink } from "./help-link.js";

export interface DisclosureSectionProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly collapsedSummary?: ReactNode;
  readonly actions?: ReactNode;
  readonly helpHref?: string;
  readonly helpLabel?: string;
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}

export function DisclosureSection({
  title,
  description,
  collapsedSummary,
  actions,
  helpHref,
  helpLabel = "Read documentation",
  defaultOpen = true,
  open,
  onOpenChange,
  children,
  className,
  ...props
}: DisclosureSectionProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const bodyId = useId();
  const expanded = open ?? localOpen;

  function setExpanded(next: boolean) {
    if (open === undefined) {
      setLocalOpen(next);
    }
    onOpenChange?.(next);
  }

  return (
    <section
      className={cn("disclosure-section", className)}
      data-state={expanded ? "open" : "closed"}
      {...props}
    >
      <header className="disclosure-section__header">
        <button
          type="button"
          className="disclosure-section__trigger"
          aria-controls={bodyId}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <IconChevronRight
            className="disclosure-section__chevron"
            aria-hidden="true"
            size={18}
            stroke={1.9}
          />
          <span className="disclosure-section__heading">
            <span className="disclosure-section__title" role="heading" aria-level={2}>
              {title}
            </span>
            {description ? (
              <span className="disclosure-section__description">{description}</span>
            ) : null}
            {!expanded && collapsedSummary ? (
              <span className="disclosure-section__summary">{collapsedSummary}</span>
            ) : null}
          </span>
        </button>
        {helpHref || actions ? (
          <div className="disclosure-section__tools">
            {helpHref ? (
              <HelpLink href={helpHref} target="_blank">
                {helpLabel}
              </HelpLink>
            ) : null}
            {actions}
          </div>
        ) : null}
      </header>
      <div id={bodyId} className="disclosure-section__body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
