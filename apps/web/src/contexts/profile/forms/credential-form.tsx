import {
  type CredentialKey,
  type CredentialsResponse,
  CredentialUpdateRequestSchema,
  type CredentialUpdateRequest,
} from "@jobctrl/contracts";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { useDeleteCredentialMutation } from "../hooks/useDeleteCredentialMutation.js";
import { useUpdateCredentialMutation } from "../hooks/useUpdateCredentialMutation.js";

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
      setStatusMessage("");
      updateCredential.reset();
      deleteCredential.reset();
      let response: CredentialsResponse;
      try {
        response = await updateCredential.mutateAsync(value);
      } catch {
        return;
      }
      formApi.reset({ key: credentialKey, value: EMPTY_VALUE });
      const checked = response.credentials.find(
        (entry) => entry.key === credentialKey,
      )?.configured;
      setStatusMessage(
        checked === true
          ? `${label} saved in Keychain. Restart the JobCtrl worker to use it.`
          : `${label} was submitted to Keychain, but JobCtrl could not verify it. Retry the Keychain check before making another change.`,
      );
    },
  });

  useEffect(() => {
    form.reset({ key: credentialKey, value: EMPTY_VALUE });
  }, [form, credentialKey]);

  const removeCredential = () => {
    setStatusMessage("");
    updateCredential.reset();
    deleteCredential.reset();
    deleteCredential.mutate(credentialKey, {
      onSuccess: (response) => {
        form.reset({ key: credentialKey, value: EMPTY_VALUE });
        setStatusMessage(
          response.credentials.find((entry) => entry.key === credentialKey)
            ?.configured === false
            ? `${label} removed from Keychain. Restart the JobCtrl worker to apply the change.`
            : `${label} removal was submitted, but JobCtrl could not verify it. Retry the Keychain check before making another change.`,
        );
      },
    });
  };

  const removing = deleteCredential.isPending;
  const inspectionUnknown =
    unavailableReason === "inspection_failed" ||
    (configured === null && unavailableReason !== "unsupported_platform");
  const unsupportedPlatform = unavailableReason === "unsupported_platform";
  const environmentManaged = effectiveSource === "environment";
  const canEditKeychain = editable ?? (available && !inspectionUnknown && !environmentManaged);
  const mutationError = updateCredential.error ?? deleteCredential.error;
  const mutationErrorMessage = credentialMutationErrorMessage(mutationError);
  const inputId = `credential-${credentialKey.toLowerCase()}`;
  const credentialDescriptionId = `${inputId}-description`;
  const describedBy = [
    credentialDescriptionId,
    !canEditKeychain ? unavailableDescriptionId : undefined,
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
      <span className={`tag ${configured === true ? "ok" : "muted"}`}>
        {environmentManaged
          ? "managed by environment"
          : unsupportedPlatform
          ? "environment only"
          : inspectionUnknown
            ? "unable to check"
            : configured === true
              ? "stored in Keychain"
              : "not in Keychain"}
      </span>
      <label className="title-stack" htmlFor={inputId}>
        <b>{label}</b>
      </label>
      <span id={credentialDescriptionId}>{credentialKey}</span>
      <form.Field name="value">
        {(field) => (
          <input
            id={inputId}
            name={credentialKey}
            aria-describedby={describedBy}
            disabled={!canEditKeychain}
            placeholder={
              environmentManaged
                ? "Managed by launch environment"
                : unsupportedPlatform
                ? "Use environment configuration on this platform"
                : inspectionUnknown
                  ? "Keychain inspection unavailable"
                  : !available
                    ? "Keychain edits paused until inspection succeeds"
                    : configured === true
                      ? "Stored in Keychain"
                      : "Paste value to store in Keychain"
            }
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
              disabled={
                !canEditKeychain ||
                !canSubmit ||
                !isDirty ||
                isSubmitting ||
                removing
              }
            >
              {isSubmitting ? "saving" : "save"}
            </button>
          )}
        </form.Subscribe>
        <button
          className="tab"
          type="button"
          disabled={!canEditKeychain || configured !== true || removing}
          onClick={removeCredential}
        >
          {removing ? "removing" : "remove"}
        </button>
      </span>
      {statusMessage ? (
        <span className="status-line" role="status">
          {statusMessage}
        </span>
      ) : null}
      {mutationErrorMessage ? (
        <span
          aria-label="Keychain update failed"
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
  if (error instanceof JobCtrlApiError && error.status === 503) {
    return "Keychain is unavailable. Unlock Keychain Access, then retry.";
  }
  if (error instanceof JobCtrlApiError && error.status === 409) {
    return "Keychain editing is unavailable on this platform. Use environment configuration instead.";
  }
  return "JobCtrl could not update Keychain. Retry after checking Keychain Access.";
}
