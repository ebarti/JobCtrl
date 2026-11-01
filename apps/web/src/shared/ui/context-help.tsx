import { IconHelpCircle } from "@tabler/icons-react";

import { Button } from "./button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";

export interface ContextHelpProps {
  readonly label: string;
  readonly description: string;
}

/** A short, keyboard-accessible explanation beside a displayed value or section. */
export function ContextHelp({ label, description }: ContextHelpProps) {
  const name = `Help for ${label}`;
  return (
    <Popover modal>
      <PopoverTrigger
        render={
          <Button
            aria-label={name}
            className="context-help-trigger"
            size="content"
            title={name}
            type="button"
            variant="ghost"
          />
        }
      >
        <IconHelpCircle aria-hidden="true" size={15} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={`${label} explanation`}
        className="w-80 max-w-[calc(100vw-2rem)]"
        role="dialog"
        side="bottom"
        sideOffset={6}
      >
        <div className="grid gap-2">
          <p data-typography="component-title">{label}</p>
          <p data-typography="body">{description}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
