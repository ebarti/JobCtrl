import { IconExternalLink, IconHelpCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { Button } from "./button.js";
import { FieldLabel } from "./field.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover.js";

export interface SettingHelpContent {
  description: string;
  href: string;
  title: string;
}

export function SettingHelp({
  description,
  href,
  title,
}: SettingHelpContent) {
  const accessibleName = `Help for ${title}`;

  return (
    <Popover modal>
      <PopoverTrigger
        render={
          <Button
            aria-label={accessibleName}
            className="size-6 rounded-full"
            size="content"
            title={accessibleName}
            type="button"
            variant="ghost"
          />
        }
      >
        <IconHelpCircle aria-hidden="true" size={14} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={`${title} help`}
        className="w-80 max-w-[calc(100vw-2rem)]"
        role="dialog"
        side="bottom"
        sideOffset={6}
      >
        <div className="grid gap-2.5">
          <p data-typography="component-title">{title}</p>
          <p className="text-muted-foreground" data-typography="body">
            {description}
          </p>
          <a
            className="inline-flex w-fit items-center gap-1.5 text-primary underline-offset-4 hover:underline"
            data-typography="control"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            Open documentation
            <IconExternalLink aria-hidden="true" size={14} />
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SettingLabelWithHelp({
  children,
  help,
  htmlFor,
  id,
}: {
  children: ReactNode;
  help: SettingHelpContent;
  htmlFor: string;
  id?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <FieldLabel htmlFor={htmlFor} id={id}>
        {children}
      </FieldLabel>
      <SettingHelp {...help} />
    </div>
  );
}
