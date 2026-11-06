import {
  type CredentialKey,
  type CredentialsResponse,
  CredentialUpdateRequestSchema,
  type CredentialUpdateRequest,
} from "../../settings/credentials.js";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useCredentialEditFence } from "../../settings/credentials.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { useDeleteCredentialMutation } from "../hooks/useDeleteCredentialMutation.js";
import { useUpdateCredentialMutation } from "../hooks/useUpdateCredentialMutation.js";
import { credentialRecoveryMessage } from "../lib/credential-recovery-message.js";

export interface CredentialFormProps {
  credentialKey: CredentialKey;
  label: string;
  configured: boolean | null;
  available?: boolean;
  unavailableReason?: "inspection_failed" | "unsupported_platform";
  unavailableDescriptionId?: string;
  effectiveSource?: CredentialsResponse["credentials"][number]["effectiveSource"];
  editable?: boolean;
}

const EMPTY_VALUE: CredentialUpdateRequest["value"] = "";

export function CredentialForm({
  credentialKey,
  label,
  configured,
  available = true,
  unavailableReason,
  unavailableDescriptionId,
  effectiveSource,
  editable,
}: CredentialFormProps) {
  const updateCredential = useUpdateCredentialMutation();
  const fence = useCredentialEditFence();
  const deleteCredential = useDeleteCredentialMutation();
  const [statusMessage, setStatusMessage] = useState("");

  const form = useForm({
    defaultValues: {
      key: credentialKey,
      value: EMPTY_VALUE,
    } satisfies CredentialUpdateRequest,
    validators: {
      onSubmit: ({ value }) => {
        const result = CredentialUpdateRequestSchema.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid credential");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      if (updateCredential.isPending || deleteCredential.isPending) return;
      setStatusMessage("");
      updateCredential.reset();
      deleteCredential.reset();
      const submittedValue = value.value;
      let response: CredentialsResponse;
      try {
        response = await updateCredential.mutateAsync(fence.request(value));
      } catch {
        return;
      }
      const newerInput = formApi.getFieldValue("value") !== submittedValue;
      fence.accept(response.revision, newerInput);
      const checked = response.credentials.find(
        (entry) => entry.key === credentialKey,
      )?.configured;
      if (checked === true && !newerInput) formApi.reset({ key: credentialKey, value: EMPTY_VALUE });
      const result = checked === true
        ? `${label} saved in the native credential store. Newly started actions use it immediately.`
        : `${label} was submitted, but JobCtrl could not verify it. Your input remains here; check credential status before another change.`;
      setStatusMessage(`${result}${newerInput ? " Newer input remains unsaved." : ""}`);
    },
  });

  useEffect(() => {
    form.reset({ key: credentialKey, value: EMPTY_VALUE });
  }, [form, credentialKey]);

  const removeCredential = async () => {
    if (updateCredential.isPending || deleteCredential.isPending) return;
    setStatusMessage("");
    updateCredential.reset();
    deleteCredential.reset();
    const submittedValue = form.getFieldValue("value");
    try {
      const response = await deleteCredential.mutateAsync(credentialKey, fence.request({}).expectedRevision);
      const newerInput = form.getFieldValue("value") !== submittedValue;
      fence.accept(response.revision, newerInput);
      const confirmed = response.credentials.find((entry) => entry.key === credentialKey)?.configured === false;
      if (confirmed && !newerInput) form.reset({ key: credentialKey, value: EMPTY_VALUE });
      const result = confirmed
        ? `${label} removed from the native credential store. Newly started actions use the updated configuration.`
        : `${label} removal was submitted, but could not be verified. Your input remains here; check credential status before another change.`;
      setStatusMessage(`${result}${newerInput ? " Newer input remains unsaved." : ""}`);
    } catch { /* Retain the draft and the mutation's visible failure result. */ }
  };

  const removing = deleteCredential.isPending;
  const inspectionUnknown =
    unavailableReason === "inspection_failed" ||
    (configured === null && unavailableReason !== "unsupported_platform");
  const unsupportedPlatform = unavailableReason === "unsupported_platform";
  const environmentManaged = effectiveSource === "environment";
  const canEditCredentialStore =
    available &&
    !inspectionUnknown &&
    !environmentManaged &&
    (editable ?? true);
  const mutationError = updateCredential.error ?? deleteCredential.error;
  const mutationErrorMessage = credentialMutationErrorMessage(mutationError);
  const inputId = `credential-${credentialKey.toLowerCase()}`;
  const credentialDescriptionId = `${inputId}-description`;
  const describedBy = [
    credentialDescriptionId,
    !canEditCredentialStore ? unavailableDescriptionId : undefined,
  ].filter((value): value is string => value !== undefined).join(" ");
  return (
    <form
      className="credential-row-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <StatusBadge
        aria-label={`${label} status`}
        className="credential-row-status"
        tone={configured === true ? "ok" : inspectionUnknown ? "warn" : "muted"}
      >
        {environmentManaged
          ? "managed by environment"
          : unsupportedPlatform
          ? "environment only"
          : inspectionUnknown
            ? "unable to check"
            : configured === true
              ? "stored securely"
              : "not configured"}
      </StatusBadge>
      <FieldGroup className="credential-row-field-group">
        <Field
          className="credential-row-field"
          data-disabled={!canEditCredentialStore ? true : undefined}
          orientation="horizontal"
        >
          <FieldContent className="credential-row-identity">
            <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
            <FieldDescription
              className="credential-row-key"
              id={credentialDescriptionId}
            >
              {credentialKey}
            </FieldDescription>
          </FieldContent>
          <form.Field name="value">
            {(field) => (
              <Input
                aria-describedby={describedBy}
                disabled={!canEditCredentialStore}
                id={inputId}
                name={credentialKey}
                placeholder={
                  environmentManaged
                    ? "Managed by launch environment"
                    : unsupportedPlatform
                    ? "Use environment configuration on this platform"
                    : inspectionUnknown
                      ? "credential store inspection unavailable"
                      : !available
                        ? "credential store edits paused until inspection succeeds"
                        : configured === true
                          ? "Stored in credential store"
                          : "Paste value to store in credential store"
                }
                type="password"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => { fence.capture(); field.handleChange(event.target.value); }}
              />
            )}
          </form.Field>
        </Field>
      </FieldGroup>
      <div className="credential-row-actions">
        <form.Subscribe
          selector={(state) => ({
            canSubmit: state.canSubmit,
            isSubmitting: state.isSubmitting,
            isDirty: state.isDirty,
          })}
        >
          {({ canSubmit, isSubmitting, isDirty }) => (
            <Button
              aria-label={`Save ${label}`}
              size="sm"
              type="submit"
              disabled={
                !canEditCredentialStore || fence.stale ||
                !canSubmit ||
                !isDirty ||
                isSubmitting ||
                removing
              }
            >
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          )}
        </form.Subscribe>
        <Button
          aria-label={`Remove ${label}`}
          size="sm"
          type="button"
          variant="outline"
          disabled={!canEditCredentialStore || fence.stale || configured !== true || removing || updateCredential.isPending}
          onClick={() => void removeCredential()}
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
      {fence.stale ? <span className="status-line warning" role="alert">Credential configuration changed. Your draft remains here. <Button type="button" variant="outline" onClick={fence.review}>Review current credential status</Button></span> : null}
      {statusMessage ? (
        <span className="status-line" role="status">
          {statusMessage}
        </span>
      ) : null}
      {mutationErrorMessage ? (
        <span
          aria-label="credential store update failed"
          className="status-line warning"
          role="alert"
        >
          {mutationErrorMessage}
        </span>
      ) : null}
    </form>
  );
}

function credentialMutationErrorMessage(error: Error | null): string {
  if (!error) {
    return "";
  }
  const recovery = credentialRecoveryMessage(error);
  if (recovery) return recovery;
  if (error instanceof JobCtrlApiError && error.status === 503) {
    return "The credential store is unavailable. Check credential status before trying again.";
  }
  if (error instanceof JobCtrlApiError && error.status === 409) {
    return "Credential configuration changed or is environment-managed. Your input remains here; check credential status before retrying.";
  }
  return "The credential change could not be confirmed. Your input remains here; check credential status before retrying.";
}
