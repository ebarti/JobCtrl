import {
  CONTACT_ATTRIBUTE_KINDS,
  ContactCreateRequestSchema,
  type ContactAttributeKind,
  type ContactCreateRequest,
  type ContactRole,
} from "@jobctrl/contracts";
import { CONTACT_ROLES } from "@jobctrl/domain-types";
import { useForm } from "@tanstack/react-form";
import { useId } from "react";

import { Button } from "../../../shared/ui/button.js";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import {
  contactAttributeKindLabel,
  contactRoleLabel,
} from "../lib/contact-copy.js";

export interface ContactAttributeRow {
  kind: ContactAttributeKind;
  value: string;
}

export interface ContactFormValues {
  role: ContactRole;
  employer: string;
  jobId: string;
  attributes: ContactAttributeRow[];
}

export interface ContactFormProps {
  submitLabel: string;
  pending: boolean;
  onSubmit: (request: ContactCreateRequest) => void | Promise<void>;
  initialValues?: Partial<ContactFormValues>;
  lockedJobId?: string;
  errorMessage?: string;
  onCancel?: () => void;
}

function defaultFormValues(
  initial: Partial<ContactFormValues> | undefined,
  lockedJobId: string | undefined,
): ContactFormValues {
  const attributes =
    initial?.attributes && initial.attributes.length > 0
      ? initial.attributes.map((attribute) => ({ ...attribute }))
      : [{ kind: "name" as const, value: "" }];
  return {
    role: initial?.role ?? "other",
    employer: initial?.employer ?? "",
    jobId: lockedJobId ?? initial?.jobId ?? "",
    attributes,
  };
}

function assembleCandidate(values: ContactFormValues) {
  const employer = values.employer.trim();
  const jobId = values.jobId.trim();
  return {
    role: values.role,
    employer: employer ? employer : undefined,
    jobId: jobId ? jobId : undefined,
    attributes: values.attributes
      .map((attribute) => ({
        kind: attribute.kind,
        value: attribute.value.trim(),
      }))
      .filter((attribute) => attribute.value.length > 0),
  };
}

export function ContactForm({
  submitLabel,
  pending,
  onSubmit,
  initialValues,
  lockedJobId,
  errorMessage,
  onCancel,
}: ContactFormProps) {
  const formId = useId();
  const form = useForm({
    defaultValues: defaultFormValues(initialValues, lockedJobId),
    validators: {
      onSubmit: ({ value }) => {
        const result = ContactCreateRequestSchema.safeParse(
          assembleCandidate(value),
        );
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid contact.");
      },
    },
    onSubmit: async ({ value }) => {
      const result = ContactCreateRequestSchema.safeParse(
        assembleCandidate(value),
      );
      if (!result.success) {
        return;
      }
      await onSubmit(result.data);
    },
  });

  return (
    <form
      className="contact-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {errorMessage ? (
        <div className="banner inline">{errorMessage}</div>
      ) : null}
      <form.Field name="role">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor={`${formId}-role`}>Role</FieldLabel>
            <Select
              items={CONTACT_ROLES.map((role) => ({
                label: contactRoleLabel(role),
                value: role,
              }))}
              value={field.state.value}
              onValueChange={(value) => {
                if (value !== null) field.handleChange(value as ContactRole);
              }}
            >
              <SelectTrigger
                id={`${formId}-role`}
                aria-label="Role"
                className="w-full"
                onBlur={field.handleBlur}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {CONTACT_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {contactRoleLabel(role)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="employer">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor={`${formId}-employer`}>Employer</FieldLabel>
            <Input
              id={`${formId}-employer`}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="jobId">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor={`${formId}-job`}>Job</FieldLabel>
            <Input
              id={`${formId}-job`}
              value={field.state.value}
              disabled={Boolean(lockedJobId)}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <FieldSet className="contact-attribute-rows">
        <FieldLegend>Facts</FieldLegend>
        <form.Field name="attributes" mode="array">
          {(attributesField) => (
            <>
              {attributesField.state.value.map((_, index) => (
                <div className="contact-attribute-row" key={index}>
                  <form.Field name={`attributes[${index}].kind`}>
                    {(kindField) => (
                      <Field className="field compact">
                        <FieldLabel htmlFor={`${formId}-attribute-${index}-kind`}>
                          Kind
                        </FieldLabel>
                        <Select
                          items={CONTACT_ATTRIBUTE_KINDS.map((kind) => ({
                            label: contactAttributeKindLabel(kind),
                            value: kind,
                          }))}
                          value={kindField.state.value}
                          onValueChange={(value) => {
                            if (value !== null) {
                              kindField.handleChange(
                                value as ContactAttributeKind,
                              );
                            }
                          }}
                        >
                          <SelectTrigger
                            id={`${formId}-attribute-${index}-kind`}
                            aria-label="Kind"
                            className="w-full"
                            onBlur={kindField.handleBlur}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {CONTACT_ATTRIBUTE_KINDS.map((kind) => (
                                <SelectItem key={kind} value={kind}>
                                  {contactAttributeKindLabel(kind)}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name={`attributes[${index}].value`}>
                    {(valueField) => (
                      <Field className="field compact">
                        <FieldLabel htmlFor={`${formId}-attribute-${index}-value`}>
                          Value
                        </FieldLabel>
                        <Input
                          id={`${formId}-attribute-${index}-value`}
                          value={valueField.state.value}
                          onBlur={valueField.handleBlur}
                          onChange={(event) =>
                            valueField.handleChange(event.target.value)
                          }
                        />
                      </Field>
                    )}
                  </form.Field>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove fact ${index + 1}`}
                    onClick={() => attributesField.removeValue(index)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  attributesField.pushValue({ kind: "email", value: "" })
                }
              >
                Add fact
              </Button>
            </>
          )}
        </form.Field>
      </FieldSet>
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? (
            <div className="banner inline">{message}</div>
          ) : null;
        }}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="form-actions">
            <Button
              type="submit"
              disabled={pending || isSubmitting}
            >
              {pending || isSubmitting ? "Saving…" : submitLabel}
            </Button>
            {onCancel ? (
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
