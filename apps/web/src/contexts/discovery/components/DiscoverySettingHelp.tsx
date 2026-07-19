import { IconExternalLink, IconHelpCircle } from "@tabler/icons-react";

import { Button } from "../../../shared/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../shared/ui/popover.js";

export interface DiscoverySettingHelpContent {
  description: string;
  href: string;
  title: string;
}

export function DiscoverySettingHelp({
  description,
  href,
  title,
}: DiscoverySettingHelpContent) {
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
