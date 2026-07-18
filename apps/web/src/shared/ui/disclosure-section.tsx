import { IconChevronDown } from "@tabler/icons-react";
import {
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible.js";

export interface DisclosureSectionProps
  extends Omit<
    ComponentPropsWithoutRef<typeof Collapsible>,
    "children" | "defaultOpen" | "onOpenChange" | "open" | "title"
  > {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly collapsedSummary?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly description: ReactNode;
  readonly headingLevel?: 2 | 3 | 4;
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
  readonly title: ReactNode;
}

/**
 * State-preserving configuration disclosure built on the owned Base UI
 * Collapsible wrapper. Hidden form controls stay mounted so draft state,
 * validation, and pending mutations survive repeated toggles.
 */
export function DisclosureSection({
  actions,
  children,
  className,
  collapsedSummary,
  defaultOpen = true,
  description,
  headingLevel = 2,
  onOpenChange,
  open,
  title,
  ...props
}: DisclosureSectionProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const expanded = open ?? localOpen;

  function setExpanded(nextOpen: boolean) {
    if (open === undefined) {
      setLocalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }

  return (
    <Collapsible
      {...props}
      className={cn("form-section configuration-section", className)}
      open={expanded}
      onOpenChange={setExpanded}
      render={<section />}
    >
      <div className="configuration-section__header">
        <CollapsibleTrigger
          className="configuration-section__trigger"
          data-typography="control"
        >
          <span className="configuration-section__title-group">
            <span
              aria-level={headingLevel}
              className="configuration-section__title"
              data-typography="component-title"
              role="heading"
            >
              {title}
            </span>
            <span
              className="configuration-section__description"
              data-typography="body"
            >
              {description}
            </span>
            {!expanded && collapsedSummary ? (
              <span
                className="configuration-section__summary"
                data-typography="metadata"
              >
                {collapsedSummary}
              </span>
            ) : null}
          </span>
          <IconChevronDown
            aria-hidden="true"
            className="configuration-section__indicator"
            size={16}
          />
        </CollapsibleTrigger>
        {actions ? <div className="configuration-section__actions">{actions}</div> : null}
      </div>
      <CollapsibleContent className="configuration-section__body" keepMounted>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
