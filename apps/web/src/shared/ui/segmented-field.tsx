import type { ReactNode } from "react";
import { useId } from "react";

import { Field, FieldDescription, FieldLabel } from "./field.js";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.js";

export interface SegmentedFieldOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedFieldProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly options: readonly SegmentedFieldOption[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
}

export function SegmentedField({
  label,
  description,
  options,
  value,
  onValueChange,
  disabled,
  className,
  ariaLabel,
}: SegmentedFieldProps) {
  const descriptionId = useId();

  return (
    <Field className={className}>
      <FieldLabel>{label}</FieldLabel>
      <ToggleGroup
        type="single"
        value={value}
        variant="outline"
        spacing={0}
        disabled={disabled}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : "Select an option")}
        aria-describedby={description ? descriptionId : undefined}
        className="segmented-field"
        onValueChange={(next) => {
          if (next) onValueChange(next);
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            aria-label={typeof option.label === "string" ? option.label : option.value}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {description ? (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      ) : null}
    </Field>
  );
}
