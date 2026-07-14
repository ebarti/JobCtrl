import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "../lib/cn.js";
import { Field, FieldDescription, FieldError, FieldLabel } from "./field.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.js";

export interface SelectFieldOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface SelectFieldProps {
  readonly id?: string;
  readonly name?: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly options: readonly SelectFieldOption[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly onValueChange?: (value: string) => void;
}

export function SelectField({
  id,
  name,
  label,
  description,
  error,
  options,
  value,
  defaultValue,
  placeholder = "Select an option",
  disabled,
  required,
  className,
  triggerClassName,
  onValueChange,
}: SelectFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <Field className={className} data-invalid={Boolean(error) || undefined}>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <Select
        name={name}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        required={required}
        onValueChange={onValueChange}
      >
        <SelectTrigger
          id={controlId}
          className={cn("select-field__trigger", triggerClassName)}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error) || undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}
