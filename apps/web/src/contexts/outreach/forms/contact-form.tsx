import {
  CONTACT_ATTRIBUTE_KINDS,
  ContactCreateRequestSchema,
  type ContactAttributeKind,
  type ContactCreateRequest,
  type ContactRole,
} from "@jobctrl/contracts";
import { CONTACT_ROLES } from "@jobctrl/domain-types";
import { useForm } from "@tanstack/react-form";

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
          <label className="field">
            <span>Role</span>
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
          </label>
        )}
      </form.Field>
      <form.Field name="employer">
        {(field) => (
          <label className="field">
            <span>Employer</span>
            <input
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="jobId">
        {(field) => (
          <label className="field">
            <span>Job</span>
            <input
              value={field.state.value}
              disabled={Boolean(lockedJobId)}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <fieldset className="contact-attribute-rows">
        <legend>Facts</legend>
        <form.Field name="attributes" mode="array">
          {(attributesField) => (
            <>
              {attributesField.state.value.map((_, index) => (
                <div className="contact-attribute-row" key={index}>
                  <form.Field name={`attributes[${index}].kind`}>
                    {(kindField) => (
                      <label className="field compact">
                        <span>Kind</span>
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
                      </label>
                    )}
                  </form.Field>
                  <form.Field name={`attributes[${index}].value`}>
                    {(valueField) => (
                      <label className="field compact">
                        <span>Value</span>
                        <input
                          value={valueField.state.value}
                          onBlur={valueField.handleBlur}
                          onChange={(event) =>
                            valueField.handleChange(event.target.value)
                          }
                        />
                      </label>
                    )}
                  </form.Field>
                  <button
                    type="button"
                    className="tab"
                    aria-label={`Remove fact ${index + 1}`}
                    onClick={() => attributesField.removeValue(index)}
                  >
                    remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="tab"
                onClick={() =>
                  attributesField.pushValue({ kind: "email", value: "" })
                }
              >
                add fact
              </button>
            </>
          )}
        </form.Field>
      </fieldset>
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
            <button
              type="submit"
              className="tab on"
              disabled={pending || isSubmitting}
            >
              {pending || isSubmitting ? "saving" : submitLabel}
            </button>
            {onCancel ? (
              <button type="button" className="tab" onClick={onCancel}>
                cancel
              </button>
            ) : null}
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
