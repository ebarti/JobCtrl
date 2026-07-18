import { IconRefresh } from "@tabler/icons-react";
import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
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
  const blocked = disabled || mutation.isPending;
  const buttonContent = (
    <>
      <IconRefresh aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Refreshing compensation" : label}</span>
    </>
  );
  const handleClick = () => {
    if (blocked) return;
    if (
      !window.confirm(
        "Refresh compensation for all jobs? This reparses posted salary text and reloads configured market compensation sources.",
      )
    ) {
      return;
    }
    mutation.mutate({}, onSuccess ? { onSuccess } : undefined);
  };

  if (render) {
    return render({
      "aria-describedby": ariaDescribedBy,
      "aria-label": label,
      children: buttonContent,
      className,
      disabled: blocked,
      onClick: handleClick,
      title: "Refresh posted and market compensation for all jobs.",
    });
  }

  return (
    <Button
      aria-describedby={ariaDescribedBy}
      aria-label={label}
      className={className}
      disabled={blocked}
      title="Refresh posted and market compensation for all jobs."
      type="button"
      onClick={handleClick}
    >
      {buttonContent}
    </Button>
  );
}
