import {
  type CredentialKey,
  type CredentialsResponse,
  CredentialUpdateRequestSchema,
  type CredentialUpdateRequest,
} from "@jobctrl/contracts";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import {
  AdaptiveFieldGrid,
  AdaptiveFieldSpan,
} from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
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
  const canEditKeychain =
    available &&
    !inspectionUnknown &&
    !environmentManaged &&
    (editable ?? true);
  const mutationError = updateCredential.error ?? deleteCredential.error;
  const mutationErrorMessage = credentialMutationErrorMessage(mutationError);
  const inputId = `credential-${credentialKey.toLowerCase()}`;
  const credentialDescriptionId = `${inputId}-description`;
  const credentialStatus = environmentManaged
    ? "Managed by environment"
    : unsupportedPlatform
      ? "Environment only"
      : inspectionUnknown
        ? "Unable to check"
        : configured === true
          ? "Stored in Keychain"
          : "Not in Keychain";
  const disabledReason = environmentManaged
    ? "Managed by the launch environment."
    : unsupportedPlatform
      ? "Use environment configuration on this platform."
      : inspectionUnknown
        ? "Keychain inspection is unavailable."
        : !available
          ? "Keychain edits are paused until inspection succeeds."
          : editable === false
            ? "This credential is read-only."
            : null;
  const describedBy = [
    credentialDescriptionId,
    !canEditKeychain ? unavailableDescriptionId : undefined,
  ].filter((value): value is string => value !== undefined).join(" ");
  return (
    <form
      className="credential-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <AdaptiveFieldGrid
        className="credential-form__grid"
        columns={2}
        density="compact"
        minColumnWidth={240}
      >
        <form.Field name="value">
          {(field) => (
            <Field className="credential-form__field" data-disabled={!canEditKeychain || undefined}>
              <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
              <Input
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
              <FieldDescription id={credentialDescriptionId}>
                <span className="credential-form__key">{credentialKey}</span>
                <span className="credential-form__status">{credentialStatus}</span>
                {disabledReason ? (
                  <span className="credential-form__disabled-reason">{disabledReason}</span>
                ) : null}
              </FieldDescription>
            </Field>
          )}
        </form.Field>
        <AdaptiveFieldSpan className="credential-form__footer" span="full">
          <div className="credential-form__actions">
            <form.Subscribe
              selector={(state) => ({
                canSubmit: state.canSubmit,
                isSubmitting: state.isSubmitting,
                isDirty: state.isDirty,
              })}
            >
              {({ canSubmit, isSubmitting, isDirty }) => (
                <Button
                  disabled={
                    !canEditKeychain ||
                    !canSubmit ||
                    !isDirty ||
                    isSubmitting ||
                    removing
                  }
                  size="sm"
                  type="submit"
                >
                  {isSubmitting ? "Saving…" : "Save"}
                </Button>
              )}
            </form.Subscribe>
            <Button
              disabled={!canEditKeychain || configured !== true || removing}
              size="sm"
              type="button"
              variant="outline"
              onClick={removeCredential}
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </div>
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
        </AdaptiveFieldSpan>
      </AdaptiveFieldGrid>
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
