import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useCallback, useState } from "react";

import { usePorts } from "../providers/PortsProvider.js";
import { cn } from "../lib/cn.js";
import { Button } from "./button.js";

export interface CopyableCommandProps {
  command: string;
  className?: string;
  label?: string;
}

export function CopyableCommand({
  command,
  className,
  label = "Copy command",
}: CopyableCommandProps) {
  const ports = usePorts();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void ports.clipboard.write(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [command, ports.clipboard]);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 font-mono text-[13px]",
        className,
      )}
    >
      <code className="truncate">{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={onCopy}
        className="h-7 w-7"
      >
        {copied ? (
          <IconCheck className="h-4 w-4" />
        ) : (
          <IconCopy className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}
