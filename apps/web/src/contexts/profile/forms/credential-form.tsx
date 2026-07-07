import {
  type CredentialKey,
  CredentialUpdateRequestSchema,
  type CredentialUpdateRequest,
} from "@jobctl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { useDeleteCredentialMutation } from "../hooks/useDeleteCredentialMutation.js";
import { useUpdateCredentialMutation } from "../hooks/useUpdateCredentialMutation.js";

export interface CredentialFormProps {
  credentialKey: CredentialKey;
  label: string;
  configured: boolean;
}

const EMPTY_VALUE: CredentialUpdateRequest["value"] = "";

export function CredentialForm({ credentialKey, label, configured }: CredentialFormProps) {
  const updateCredential = useUpdateCredentialMutation();
  const deleteCredential = useDeleteCredentialMutation();
  const [statusMessage, setStatusMessage] = useState("");

  const form = useForm({
    defaultValues: { key: credentialKey, value: EMPTY_VALUE } satisfies CredentialUpdateRequest,
    validators: {
      onSubmit: ({ value }) => {
        const result = CredentialUpdateRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid credential");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      await updateCredential.mutateAsync(value);
      formApi.reset({ key: credentialKey, value: EMPTY_VALUE });
      setStatusMessage(`${label} saved in Keychain`);
    },
  });

  useEffect(() => {
    form.reset({ key: credentialKey, value: EMPTY_VALUE });
  }, [form, credentialKey]);

  const removeCredential = () => {
    setStatusMessage("");
    deleteCredential.mutate(credentialKey, {
      onSuccess: () => {
        form.reset({ key: credentialKey, value: EMPTY_VALUE });
        setStatusMessage(`${label} removed from Keychain`);
      },
    });
  };

  const removing = deleteCredential.isPending;
  return (
    <form
      className="credential-row-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <span className={`tag ${configured ? "ok" : "muted"}`}>
        {configured ? "configured" : "missing"}
      </span>
      <span className="title-stack">
        <b>{label}</b>
        <span>{credentialKey}</span>
      </span>
      <form.Field name="value">
        {(field) => (
          <input
            aria-label={label}
            placeholder={configured ? "Stored in Keychain" : "Paste value to store in Keychain"}
            type="password"
            value={field.state.value}
            onBlur={field.handleBlur}
            onChange={(event) => field.handleChange(event.target.value)}
          />
        )}
      </form.Field>
      <span className="row-actions">
        <form.Subscribe
          selector={(state) => ({
            canSubmit: state.canSubmit,
            isSubmitting: state.isSubmitting,
            isDirty: state.isDirty,
          })}
        >
          {({ canSubmit, isSubmitting, isDirty }) => (
            <button
              className="tab on"
              type="submit"
              disabled={!canSubmit || !isDirty || isSubmitting || removing}
            >
              {isSubmitting ? "saving" : "save"}
            </button>
          )}
        </form.Subscribe>
        <button
          className="tab"
          type="button"
          disabled={!configured || removing}
          onClick={removeCredential}
        >
          {removing ? "removing" : "remove"}
        </button>
      </span>
      {statusMessage ? <span className="status-line">{statusMessage}</span> : null}
    </form>
  );
}
