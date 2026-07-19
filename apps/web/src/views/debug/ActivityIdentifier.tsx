import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useCallback, useState } from "react";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Button } from "../../shared/ui/button.js";

export function ActivityIdentifier({ eventId }: { readonly eventId: string }) {
  const { clipboard } = usePorts();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copy = useCallback(() => {
    setCopyStatus("idle");
    void clipboard
      .write(eventId)
      .then(() => {
        setCopyStatus("copied");
        window.setTimeout(() => setCopyStatus("idle"), 1_500);
      })
      .catch(() => setCopyStatus("failed"));
  }, [clipboard, eventId]);

  const copied = copyStatus === "copied";

  return (
    <span className="activity-identifier" data-row-activation-ignore>
      <code data-typography="code">{eventId}</code>
      <Button
        aria-label={`Copy event ID ${eventId}`}
        className="activity-identifier__copy"
        size="icon"
        title={
          copied
            ? "Event ID copied"
            : copyStatus === "failed"
              ? "Copy failed. Try again"
              : "Copy event ID"
        }
        type="button"
        variant="ghost"
        onClick={copy}
      >
        {copied ? (
          <IconCheck aria-hidden="true" size={14} />
        ) : (
          <IconCopy aria-hidden="true" size={14} />
        )}
      </Button>
      {copyStatus === "failed" ? (
        <span className="sr-only" role="alert">
          Could not copy event ID. Try again.
        </span>
      ) : null}
    </span>
  );
}
