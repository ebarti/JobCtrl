import { IconRefresh } from "@tabler/icons-react";
import { useState, type JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../../shared/ui/dialog.js";
import { useRefreshAllCompensationMutation } from "../hooks/useRefreshCompensationMutation.js";

type RefreshAllCompensationActionRender = (props: {
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-label": string;
  readonly children: JSX.Element;
  readonly className: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly title: string;
}) => JSX.Element;

export interface RefreshAllCompensationButtonProps {
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly ariaDescribedBy?: string;
  readonly onSuccess?: () => void;
  /**
   * Renders the action with a caller-owned interactive primitive. This lets a
   * menu own its item semantics while preserving this control's behavior.
   */
  readonly render?: RefreshAllCompensationActionRender;
}

export function RefreshAllCompensationButton({
  className = "tab",
  label = "Refresh compensation",
  disabled = false,
  ariaDescribedBy,
  onSuccess,
  render,
}: RefreshAllCompensationButtonProps): JSX.Element {
  const mutation = useRefreshAllCompensationMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "refreshAllCompensation");
  const blocked = disabled || mutation.isPending || !availability.available;
  const buttonContent = (
    <>
      <IconRefresh aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Refreshing compensation" : label}</span>
    </>
  );
  const handleClick = () => {
    if (blocked) return;
    setConfirmOpen(true);
  };
  const trigger = render
    ? render({
      "aria-describedby": ariaDescribedBy,
      "aria-label": label,
      children: buttonContent,
      className,
      disabled: blocked,
      onClick: handleClick,
      title: "Refresh posted and market compensation for all jobs.",
    })
    : <Button
      aria-describedby={ariaDescribedBy}
      aria-label={label}
      className={className}
      disabled={blocked}
      title="Refresh posted and market compensation for all jobs."
      type="button"
      onClick={handleClick}
    >
      {buttonContent}
    </Button>;

  return <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
    <DialogTrigger render={trigger} />
    <DialogContent>
      <DialogHeader><DialogTitle>Refresh compensation for all jobs?</DialogTitle>
        <DialogDescription>This reparses posted salary text and reloads configured market compensation sources.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
        <Button type="button" disabled={blocked} onClick={() => { setConfirmOpen(false); mutation.mutate({}, onSuccess ? { onSuccess } : undefined); }}>Refresh compensation</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
