import { IconRefresh } from "@tabler/icons-react";
import type { JSX } from "react";

import { useRefreshAllCompensationMutation } from "../hooks/useRefreshCompensationMutation.js";

export interface RefreshAllCompensationButtonProps {
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly ariaDescribedBy?: string;
  readonly onSuccess?: () => void;
}

export function RefreshAllCompensationButton({
  className = "tab",
  label = "refresh compensation",
  disabled = false,
  ariaDescribedBy,
  onSuccess,
}: RefreshAllCompensationButtonProps): JSX.Element {
  const mutation = useRefreshAllCompensationMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <button
      aria-describedby={ariaDescribedBy}
      aria-label={label}
      className={className}
      disabled={blocked}
      title="Refresh posted and market compensation for all jobs."
      type="button"
      onClick={() => {
        if (blocked) return;
        if (
          !window.confirm(
            "Refresh compensation for all jobs? This reparses posted salary text and reloads configured market compensation sources.",
          )
        ) {
          return;
        }
        mutation.mutate({}, onSuccess ? { onSuccess } : undefined);
      }}
    >
      <IconRefresh aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "refreshing comp" : label}</span>
    </button>
  );
}
