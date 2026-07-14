import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useId } from "react";

import { cn } from "../lib/cn.js";
import { Checkbox } from "./checkbox.js";

export interface ChoiceControlProps
  extends Omit<ComponentPropsWithoutRef<typeof Checkbox>, "children"> {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly disabledReason?: ReactNode;
  readonly locked?: boolean;
}

export function ChoiceControl({
  id,
  label,
  description,
  disabledReason,
  locked = false,
  disabled,
  className,
  ...props
}: ChoiceControlProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const descriptionId = `${controlId}-description`;
  const isDisabled = disabled || locked;

  return (
    <div
      className={cn("choice-control", className)}
      data-disabled={isDisabled || undefined}
      data-locked={locked || undefined}
    >
      <Checkbox
        id={controlId}
        disabled={isDisabled}
        aria-labelledby={labelId}
        aria-describedby={description || disabledReason ? descriptionId : undefined}
        {...props}
      />
      <label className="choice-control__copy" htmlFor={controlId}>
        <span className="choice-control__label" id={labelId}>{label}</span>
        {description || disabledReason ? (
          <span className="choice-control__description" id={descriptionId}>
            {disabledReason ?? description}
          </span>
        ) : null}
      </label>
      {locked ? <span className="choice-control__state">Required</span> : null}
    </div>
  );
}
