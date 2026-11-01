import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import {
  SecretCredentialKeys,
  type CredentialBatchUpdateRequest,
  type CredentialKey,
} from "@jobctrl/contracts";

import { Button } from "../../../shared/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../shared/ui/dialog.js";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useUpdateCredentialsBatchMutation } from "../hooks/useUpdateCredentialsBatchMutation.js";
import { credentialRecoveryMessage } from "../lib/credential-recovery-message.js";
import {
  buildClaudeCredentialBatch,
  buildGoogleCredentialBatch,
  removeClaudeProviderBatch,
  removeGoogleProviderBatch,
  type ClaudeMode,
  type GoogleMode,
} from "../lib/provider-credential-plans.js";

const claudeValuesSchema = z
  .object({
    mode: z.enum([
      "anthropic_api_key",
      "vertex",
      "bedrock",
      "anthropic_aws",
      "foundry",
    ]),
    apiKey: z.string(),
    vertexProjectId: z.string(),
    vertexRegion: z.string(),
    awsRegion: z.string(),
    awsProfile: z.string(),
    awsWorkspaceId: z.string(),
    foundryResource: z.string(),
    googleApplicationCredentials: z.string(),
  })
  .superRefine((values, context) => {
    const requireValue = (value: string, path: string, message: string) => {
      if (!value.trim()) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      }
    };
    if (values.mode === "anthropic_api_key") {
      requireValue(values.apiKey, "apiKey", "Paste an Anthropic API key.");
    } else if (values.mode === "vertex") {
      requireValue(values.vertexProjectId, "vertexProjectId", "Enter the Google Cloud project ID.");
      requireValue(values.vertexRegion, "vertexRegion", "Enter the Vertex AI region.");
    } else if (values.mode === "anthropic_aws") {
      requireValue(values.awsWorkspaceId, "awsWorkspaceId", "Enter the Claude Platform workspace ID.");
    } else if (values.mode === "foundry") {
      requireValue(values.foundryResource, "foundryResource", "Enter the Microsoft Foundry resource name.");
    }
  });

const googleValuesSchema = z
  .object({
    mode: z.enum(["gemini_api_key", "vertex"]),
    apiKey: z.string(),
    projectId: z.string(),
    location: z.string(),
    googleApplicationCredentials: z.string(),
  })
  .superRefine((values, context) => {
    if (values.mode === "gemini_api_key" && !values.apiKey.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: "Paste a Gemini API key.",
      });
    }
    if (values.mode === "vertex" && !values.projectId.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "Enter the Google Cloud project ID.",
      });
    }
    if (values.mode === "vertex" && !values.location.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["location"],
        message: "Enter the Vertex location.",
      });
    }
  });

interface ProviderFormProps {
  configured: boolean;
  currentMode?: string | null | undefined;
  environmentManagedKeys?: readonly CredentialKey[];
  inspectionBlocked?: boolean;
  secretStorageAvailable?: boolean;
}

export function ClaudeProviderForm({
  configured,
  currentMode,
  environmentManagedKeys = [],
  inspectionBlocked = false,
  secretStorageAvailable = true,
}: ProviderFormProps) {
  const update = useUpdateCredentialsBatchMutation();
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalError, setRemovalError] = useState("");
  const effectiveMode = claudeModeFromStatus(currentMode);
  const environmentManaged = activeModeManagedByEnvironment(
    effectiveMode,
    environmentManagedKeys,
    CLAUDE_MODE_CREDENTIAL_KEYS,
  );
  const sharedAdcEnvironmentManaged = environmentManagedKeys.includes(
    "GOOGLE_APPLICATION_CREDENTIALS",
  );
  const initialMode = effectiveMode ?? (secretStorageAvailable ? "anthropic_api_key" : "vertex");
  const modeBaseline = useRef<{ value: ClaudeMode; version: number }>({ value: initialMode, version: 0 });
  const editVersion = useRef(0);
  const savedEditVersion = useRef(0);
  const form = useForm({
    defaultValues: {
      mode: initialMode as ClaudeMode,
      apiKey: "",
      vertexProjectId: "",
      vertexRegion: "global",
      awsRegion: "",
      awsProfile: "",
      awsWorkspaceId: "",
      foundryResource: "",
      googleApplicationCredentials: "",
    },
    onSubmit: async ({ value, formApi }) => {
      if (inspectionBlocked) return;
      setMessage("");
      setSaveError("");
      if (environmentManaged && value.mode === effectiveMode) {
        setMessage("Claude's active mode is managed by the launch environment. Choose another mode to save local settings.");
        return;
      }
      const parsed = claudeValuesSchema.safeParse(value);
      if (!parsed.success) {
        setMessage(parsed.error.issues[0]?.message ?? "Review the Claude setup fields.");
        return;
      }
      const submittedValues = { ...value };
      const baselineVersion = modeBaseline.current.version;
      const submittedEditVersion = editVersion.current;
      try {
        const request = withoutUnavailableSecrets(
          withoutEnvironmentManaged(buildClaudeCredentialBatch(parsed.data), environmentManagedKeys),
          secretStorageAvailable,
        );
        if (request.operations.length === 0) {
          setMessage("Claude setup is managed by the launch environment and is read-only here.");
          return;
        }
        await update.mutateAsync(request);
        const changed = (Object.keys(submittedValues) as Array<keyof typeof submittedValues>)
          .some((field) => formApi.state.values[field] !== submittedValues[field]);
        if (request.operations.some((operation) => operation.operation === "set" && operation.key === "ANTHROPIC_API_KEY")
          && formApi.getFieldValue("apiKey") === submittedValues.apiKey) formApi.setFieldValue("apiKey", "");
        if (request.operations.some((operation) => operation.operation === "set" && operation.key === "GOOGLE_APPLICATION_CREDENTIALS")
          && formApi.getFieldValue("googleApplicationCredentials") === submittedValues.googleApplicationCredentials) formApi.setFieldValue("googleApplicationCredentials", "");
        const statusChanged = modeBaseline.current.version !== baselineVersion;
        savedEditVersion.current = submittedEditVersion;
        if (!statusChanged) modeBaseline.current = { value: submittedValues.mode, version: baselineVersion + 1 };
        else if (editVersion.current === submittedEditVersion && formApi.getFieldValue("mode") === submittedValues.mode) {
          formApi.setFieldValue("mode", modeBaseline.current.value, { dontUpdateMeta: true });
        }
        setMessage(changed || statusChanged
          ? "Claude provider settings saved. The form has changed since submission; review it before saving again. Restart JobCtrl to load the saved settings."
          : "Claude provider settings saved. Restart JobCtrl to load them.");
      } catch (error) {
        setSaveError(providerMutationMessage(error));
      }
    },
  });
  useEffect(() => {
    const selected = claudeModeFromStatus(currentMode);
    if (selected) {
      const base = modeBaseline.current;
      if (form.getFieldValue("mode") === base.value && editVersion.current === savedEditVersion.current) {
        form.setFieldValue("mode", selected, { dontUpdateMeta: true });
      } else if (selected !== base.value) {
        setMessage("Claude provider status changed while you were editing. Your form is retained; review it before saving.");
      }
      if (selected !== base.value) modeBaseline.current = { value: selected, version: base.version + 1 };
    }
  }, [currentMode, form]);

  async function removeProvider() {
    if (inspectionBlocked) return;
    setMessage("");
    setRemovalError("");
    if (environmentManaged) {
      setRemovalError("Claude setup is managed by the launch environment and remains effective.");
      return;
    }
    const inputAtRemoval = form.getFieldValue("apiKey");
    try {
      const request = withoutUnavailableSecrets(
        withoutEnvironmentManaged(removeClaudeProviderBatch(), environmentManagedKeys),
        secretStorageAvailable,
      );
      if (request.operations.length === 0) {
        setRemovalError("Claude setup is managed by the launch environment and cannot be removed here.");
        return;
      }
      await update.mutateAsync(request);
      if (form.getFieldValue("apiKey") === inputAtRemoval) form.setFieldValue("apiKey", "");
      setRemovalOpen(false);
      setMessage("Claude provider settings removed. Restart JobCtrl to stop using this provider.");
    } catch (error) {
      setRemovalError(providerRemovalMessage("Claude", error));
    }
  }

  return (
    <form className="provider-form" onChangeCapture={() => { editVersion.current += 1; }} onSubmit={(event) => submitForm(event, form.handleSubmit)}>
      <fieldset className="contents" disabled={inspectionBlocked}>
      <legend className="sr-only">Claude setup fields</legend>
      <form.Field name="mode">
        {(field) => (
          <ProviderChoices
            legend="Choose how Claude authenticates"
            name="claude-auth-mode"
            value={field.state.value}
            onChange={field.handleChange}
            options={CLAUDE_OPTIONS}
            disabled={inspectionBlocked}
            disabledValues={[
              ...(secretStorageAvailable ? [] : ["anthropic_api_key" as ClaudeMode]),
              ...(environmentManaged && effectiveMode ? [effectiveMode] : []),
            ]}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => (
          <div className="provider-mode-fields" aria-live="polite">
            {mode === "anthropic_api_key" ? (
              <form.Field name="apiKey">
                {(field) => (
                  <SecretField
                    id="claude-api-key"
                    name={field.name}
                    label="Anthropic API key"
                    help="Stored only in macOS Keychain. JobCtrl never returns the value after saving."
                    required
                    disabled={!secretStorageAvailable || environmentManagedKeys.includes("ANTHROPIC_API_KEY")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            ) : mode === "vertex" ? (
              <>
                <CloudGuidance command="gcloud auth application-default login">
                  Set up ADC outside JobCtrl, then enter the project details below. See the <a href="https://jobctrl.dev/user/configuration#claude">JobCtrl Claude guide</a>.
                </CloudGuidance>
                <form.Field name="vertexProjectId">
                  {(field) => (
                    <TextField id="claude-vertex-project" label="Google Cloud project ID" required field={field} />
                  )}
                </form.Field>
                <form.Field name="vertexRegion">
                  {(field) => (
                    <TextField
                      id="claude-vertex-region"
                      label="Vertex AI region"
                      help="Use global when your enabled models support it."
                      required
                      field={field}
                    />
                  )}
                </form.Field>
                <form.Field name="googleApplicationCredentials">
                  {(field) => (
                    <SecretField
                      id="claude-google-application-credentials"
                      name={field.name}
                      label="Existing service-account JSON path (optional)"
                      help="Write-only. Leave blank to use normal gcloud Application Default Credentials. JobCtrl never uploads or copies the file."
                      disabled={sharedAdcEnvironmentManaged}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                    />
                  )}
                </form.Field>
              </>
            ) : mode === "bedrock" ? (
              <>
                <CloudGuidance command="aws sso login --profile your-profile">
                  Configure AWS credentials with the AWS CLI or its default credential chain. JobCtrl does not collect access keys or credential files.
                </CloudGuidance>
                <form.Field name="awsProfile">
                  {(field) => <TextField id="claude-bedrock-profile" label="AWS profile (optional)" field={field} />}
                </form.Field>
                <form.Field name="awsRegion">
                  {(field) => (
                    <TextField
                      id="claude-bedrock-region"
                      label="AWS region (optional)"
                      help="Leave blank to use the region from the selected AWS profile."
                      field={field}
                    />
                  )}
                </form.Field>
              </>
            ) : mode === "anthropic_aws" ? (
              <>
                <CloudGuidance command="aws sso login --profile your-profile">
                  Configure AWS credentials externally. This route needs a Claude Platform on AWS workspace ID in addition to the AWS credential chain.
                </CloudGuidance>
                <form.Field name="awsWorkspaceId">
                  {(field) => (
                    <TextField id="claude-aws-workspace" label="Workspace ID" required field={field} />
                  )}
                </form.Field>
                <form.Field name="awsProfile">
                  {(field) => <TextField id="claude-aws-profile" label="AWS profile (optional)" field={field} />}
                </form.Field>
                <form.Field name="awsRegion">
                  {(field) => <TextField id="claude-aws-region" label="AWS region (optional)" field={field} />}
                </form.Field>
              </>
            ) : (
              <>
                <CloudGuidance command="az login">
                  Configure Microsoft Entra ID through the Azure CLI or Azure default credential chain. JobCtrl does not collect Azure credential files.
                </CloudGuidance>
                <form.Field name="foundryResource">
                  {(field) => (
                    <TextField id="claude-foundry-resource" label="Microsoft Foundry resource name" required field={field} />
                  )}
                </form.Field>
              </>
            )}
          </div>
        )}
      </form.Subscribe>
      </fieldset>
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => (
          <>
            <ProviderFormActions
              pending={update.isPending}
              message={message}
              saveError={saveError}
              removalError={removalOpen ? "" : removalError}
              saveLabel="Save Claude setup"
              readOnly={inspectionBlocked || (environmentManaged && mode === effectiveMode)}
              removeAction={
                removalOpen || (configured && !environmentManaged) ? (
                  <ProviderRemovalDialog
                    disabled={inspectionBlocked}
                    error={removalError}
                    open={removalOpen}
                    pending={update.isPending}
                    provider="Claude"
                    onConfirm={() => void removeProvider()}
                    onOpenChange={(open) => {
                      if (open) setRemovalError("");
                      setRemovalOpen(open);
                    }}
                  />
                ) : null
              }
            />
            {environmentManaged ? (
              <p className="provider-form-message" role="status">Claude's active setup includes values owned by the launch environment. Those fields and provider removal stay read-only; other editable settings can still be saved.</p>
            ) : null}
          </>
        )}
      </form.Subscribe>
    </form>
  );
}

export function GoogleProviderForm({
  configured,
  currentMode,
  environmentManagedKeys = [],
  inspectionBlocked = false,
  secretStorageAvailable = true,
}: ProviderFormProps) {
  const update = useUpdateCredentialsBatchMutation();
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalError, setRemovalError] = useState("");
  const effectiveMode = googleModeFromStatus(currentMode);
  const environmentManaged = activeModeManagedByEnvironment(
    effectiveMode,
    environmentManagedKeys,
    GOOGLE_MODE_CREDENTIAL_KEYS,
  );
  const sharedAdcEnvironmentManaged = environmentManagedKeys.includes(
    "GOOGLE_APPLICATION_CREDENTIALS",
  );
  const initialMode = effectiveMode ?? (secretStorageAvailable ? "gemini_api_key" : "vertex");
  const modeBaseline = useRef<{ value: GoogleMode; version: number }>({ value: initialMode, version: 0 });
  const editVersion = useRef(0);
  const savedEditVersion = useRef(0);
  const form = useForm({
    defaultValues: {
      mode: initialMode as GoogleMode,
      apiKey: "",
      projectId: "",
      location: "us-central1",
      googleApplicationCredentials: "",
    },
    onSubmit: async ({ value, formApi }) => {
      if (inspectionBlocked) return;
      setMessage("");
      setSaveError("");
      if (environmentManaged && value.mode === effectiveMode) {
        setMessage("Google's active mode is managed by the launch environment. Choose another mode to save local settings.");
        return;
      }
      const parsed = googleValuesSchema.safeParse(value);
      if (!parsed.success) {
        setMessage(parsed.error.issues[0]?.message ?? "Review the Google setup fields.");
        return;
      }
      const submittedValues = { ...value };
      const baselineVersion = modeBaseline.current.version;
      const submittedEditVersion = editVersion.current;
      try {
        const request = withoutUnavailableSecrets(
          withoutEnvironmentManaged(buildGoogleCredentialBatch(parsed.data), environmentManagedKeys),
          secretStorageAvailable,
        );
        if (request.operations.length === 0) {
          setMessage("Google setup is managed by the launch environment and is read-only here.");
          return;
        }
        await update.mutateAsync(request);
        const changed = (Object.keys(submittedValues) as Array<keyof typeof submittedValues>)
          .some((field) => formApi.state.values[field] !== submittedValues[field]);
        if (request.operations.some((operation) => operation.operation === "set" && operation.key === "GEMINI_API_KEY")
          && formApi.getFieldValue("apiKey") === submittedValues.apiKey) formApi.setFieldValue("apiKey", "");
        if (request.operations.some((operation) => operation.operation === "set" && operation.key === "GOOGLE_APPLICATION_CREDENTIALS")
          && formApi.getFieldValue("googleApplicationCredentials") === submittedValues.googleApplicationCredentials) formApi.setFieldValue("googleApplicationCredentials", "");
        const statusChanged = modeBaseline.current.version !== baselineVersion;
        savedEditVersion.current = submittedEditVersion;
        if (!statusChanged) modeBaseline.current = { value: submittedValues.mode, version: baselineVersion + 1 };
        else if (editVersion.current === submittedEditVersion && formApi.getFieldValue("mode") === submittedValues.mode) {
          formApi.setFieldValue("mode", modeBaseline.current.value, { dontUpdateMeta: true });
        }
        setMessage(changed || statusChanged
          ? "Google provider settings saved. The form has changed since submission; review it before saving again. Restart JobCtrl to load the saved settings."
          : "Google provider settings saved. Restart JobCtrl to load them.");
      } catch (error) {
        setSaveError(providerMutationMessage(error));
      }
    },
  });
  useEffect(() => {
    const selected = googleModeFromStatus(currentMode);
    if (selected) {
      const base = modeBaseline.current;
      if (form.getFieldValue("mode") === base.value && editVersion.current === savedEditVersion.current) {
        form.setFieldValue("mode", selected, { dontUpdateMeta: true });
      } else if (selected !== base.value) {
        setMessage("Google provider status changed while you were editing. Your form is retained; review it before saving.");
      }
      if (selected !== base.value) modeBaseline.current = { value: selected, version: base.version + 1 };
    }
  }, [currentMode, form]);

  async function removeProvider() {
    if (inspectionBlocked) return;
    setMessage("");
    setRemovalError("");
    if (environmentManaged) {
      setRemovalError("Google setup is managed by the launch environment and remains effective.");
      return;
    }
    const inputAtRemoval = form.getFieldValue("apiKey");
    try {
      const request = withoutUnavailableSecrets(
        withoutEnvironmentManaged(removeGoogleProviderBatch(), environmentManagedKeys),
        secretStorageAvailable,
      );
      if (request.operations.length === 0) {
        setRemovalError("Google setup is managed by the launch environment and cannot be removed here.");
        return;
      }
      await update.mutateAsync(request);
      if (form.getFieldValue("apiKey") === inputAtRemoval) form.setFieldValue("apiKey", "");
      setRemovalOpen(false);
      setMessage("Google provider settings removed. Restart JobCtrl to stop using this provider.");
    } catch (error) {
      setRemovalError(providerRemovalMessage("Google", error));
    }
  }

  return (
    <form className="provider-form" onChangeCapture={() => { editVersion.current += 1; }} onSubmit={(event) => submitForm(event, form.handleSubmit)}>
      <fieldset className="contents" disabled={inspectionBlocked}>
      <legend className="sr-only">Google setup fields</legend>
      <form.Field name="mode">
        {(field) => (
          <ProviderChoices
            legend="Choose how Google authenticates"
            name="google-auth-mode"
            value={field.state.value}
            onChange={field.handleChange}
            options={GOOGLE_OPTIONS}
            disabled={inspectionBlocked}
            disabledValues={[
              ...(secretStorageAvailable ? [] : ["gemini_api_key" as GoogleMode]),
              ...(environmentManaged && effectiveMode ? [effectiveMode] : []),
            ]}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => (
          <div className="provider-mode-fields" aria-live="polite">
            {mode === "gemini_api_key" ? (
              <form.Field name="apiKey">
                {(field) => (
                  <SecretField
                    id="gemini-api-key"
                    name={field.name}
                    label="Gemini API key"
                    help="Stored only in macOS Keychain and never returned by the API."
                    required
                    disabled={!secretStorageAvailable || environmentManagedKeys.includes("GEMINI_API_KEY")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            ) : (
              <>
                <CloudGuidance command="gcloud auth application-default login">
                  Set up ADC outside JobCtrl, then enter the project details below. See the <a href="https://jobctrl.dev/user/configuration#google">JobCtrl Google guide</a>.
                </CloudGuidance>
                <form.Field name="projectId">
                  {(field) => <TextField id="google-vertex-project" label="Google Cloud project ID" required field={field} />}
                </form.Field>
                <form.Field name="location">
                  {(field) => <TextField id="google-vertex-location" label="Vertex location" required field={field} />}
                </form.Field>
                <form.Field name="googleApplicationCredentials">
                  {(field) => (
                    <SecretField
                      id="google-application-credentials"
                      name={field.name}
                      label="Existing service-account JSON path (optional)"
                      help="Write-only. Leave blank to use normal gcloud Application Default Credentials. JobCtrl never uploads or copies the file."
                      disabled={sharedAdcEnvironmentManaged}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                    />
                  )}
                </form.Field>
              </>
            )}
          </div>
        )}
      </form.Subscribe>
      </fieldset>
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => (
          <>
            <ProviderFormActions
              pending={update.isPending}
              message={message}
              saveError={saveError}
              removalError={removalOpen ? "" : removalError}
              saveLabel="Save Google setup"
              readOnly={inspectionBlocked || (environmentManaged && mode === effectiveMode)}
              removeAction={
                removalOpen || (configured && !environmentManaged) ? (
                  <ProviderRemovalDialog
                    disabled={inspectionBlocked}
                    error={removalError}
                    open={removalOpen}
                    pending={update.isPending}
                    provider="Google"
                    onConfirm={() => void removeProvider()}
                    onOpenChange={(open) => {
                      if (open) setRemovalError("");
                      setRemovalOpen(open);
                    }}
                  />
                ) : null
              }
            />
            {environmentManaged ? (
              <p className="provider-form-message" role="status">Google's active setup includes values owned by the launch environment. Those fields and provider removal stay read-only; other editable settings can still be saved.</p>
            ) : null}
          </>
        )}
      </form.Subscribe>
    </form>
  );
}

interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

function ProviderChoices<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  disabled = false,
  disabledValues = [],
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  disabled?: boolean;
  disabledValues?: readonly T[];
}) {
  return (
    <FieldSet className="provider-choice-fieldset">
      <FieldLegend>{legend}</FieldLegend>
      <FieldGroup className="provider-choice-list">
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          const optionDisabled = disabled || disabledValues.includes(option.value);
          return (
            <FieldLabel
              className="provider-choice w-full"
              htmlFor={id}
              key={option.value}
              onClick={(event) => {
                const control = event.currentTarget.control;
                if (optionDisabled || !control || event.target === control) return;
                event.preventDefault();
                control.focus();
                control.click();
              }}
            >
              <Input
                checked={value === option.value}
                id={id}
                name={name}
                type="radio"
                value={option.value}
                disabled={optionDisabled}
                onChange={() => onChange(option.value)}
              />
              <span>
                <strong data-typography="strong-body">{option.label}</strong>
                <span data-typography="metadata">{option.description}</span>
              </span>
            </FieldLabel>
          );
        })}
      </FieldGroup>
    </FieldSet>
  );
}

function SecretField({
  id,
  name,
  label,
  help,
  required = false,
  value,
  onBlur,
  onChange,
  disabled = false,
}: {
  id: string;
  name: string;
  label: string;
  help: string;
  required?: boolean;
  value: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const helpId = `${id}-help`;
  return (
    <Field className="field provider-field">
      <FieldLabel htmlFor={id}>{label}{required ? " (required)" : ""}</FieldLabel>
      <div className="secret-input-row">
        <Input
          aria-describedby={helpId}
          autoComplete="off"
          id={id}
          name={name}
          disabled={disabled}
          required={required}
          type={revealed ? "text" : "password"}
          value={value}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          aria-pressed={revealed}
          className="secret-reveal"
          type="button"
          disabled={disabled}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? "Hide" : "Show"}
        </Button>
      </div>
      <FieldDescription className="field-hint" id={helpId}>{help}</FieldDescription>
    </Field>
  );
}

function TextField({
  id,
  label,
  help,
  required = false,
  field,
}: {
  id: string;
  label: string;
  help?: string;
  required?: boolean;
  field: {
    name: string;
    state: { value: string };
    handleBlur: () => void;
    handleChange: (value: string) => void;
  };
}) {
  const helpId = help ? `${id}-help` : undefined;
  return (
    <Field className="field provider-field">
      <FieldLabel htmlFor={id}>{label}{required ? " (required)" : ""}</FieldLabel>
      <Input
        aria-describedby={helpId}
        id={id}
        name={field.name}
        required={required}
        type="text"
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      />
      {help ? <FieldDescription className="field-hint" id={helpId}>{help}</FieldDescription> : null}
    </Field>
  );
}

function CloudGuidance({ command, children }: { command: string; children: ReactNode }) {
  return (
    <div className="provider-cloud-guidance">
      <p>{children}</p>
      <code>{command}</code>
    </div>
  );
}

function ProviderFormActions({
  pending,
  message,
  saveError,
  removalError,
  saveLabel,
  removeAction,
  readOnly = false,
}: {
  pending: boolean;
  message: string;
  saveError: string;
  removalError: string;
  saveLabel: string;
  removeAction?: ReactNode;
  readOnly?: boolean;
}) {
  return (
    <div className="provider-form-footer">
      <Button disabled={pending || readOnly} type="submit">
        {pending ? "Saving…" : saveLabel}
      </Button>
      {removeAction}
      <div aria-live="polite" className="provider-form-message" role="status">
        {message}
      </div>
      {saveError ? <div className="provider-form-message warning" role="alert">{saveError}</div> : null}
      {removalError ? <div className="provider-form-message warning" role="alert">{removalError}</div> : null}
    </div>
  );
}

function ProviderRemovalDialog({
  provider,
  open,
  pending,
  disabled,
  error,
  onOpenChange,
  onConfirm,
}: {
  provider: "Claude" | "Google";
  open: boolean;
  pending: boolean;
  disabled: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={pending || disabled} type="button" variant="outline">
          Remove {provider} setup
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {provider} provider setup?</DialogTitle>
          <DialogDescription>
            This removes the provider's non-secret connection settings from config.json and its API key from macOS Keychain.
            External vendor CLI and cloud credentials are unchanged. Restart JobCtrl afterward
            so its API provider process and worker stop using the previous configuration.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="provider-removal-error" role="alert">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={pending} type="button" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={pending || disabled}
            type="button"
            variant="destructive"
            onClick={onConfirm}
          >
            {pending ? `Removing ${provider} setup…` : `Remove ${provider} setup`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function submitForm(
  event: FormEvent<HTMLFormElement>,
  handleSubmit: () => Promise<void>,
) {
  event.preventDefault();
  event.stopPropagation();
  void handleSubmit();
}

function claudeModeFromStatus(mode: string | null | undefined): ClaudeMode | null {
  if (!mode) return null;
  if (["anthropic_api_key", "api_key", "anthropic"].includes(mode)) return "anthropic_api_key";
  if (["vertex", "google_vertex", "agent_platform"].includes(mode)) return "vertex";
  if (mode === "bedrock") return "bedrock";
  if (["anthropic_aws", "claude_platform_on_aws"].includes(mode)) return "anthropic_aws";
  if (["foundry", "azure", "microsoft_foundry"].includes(mode)) return "foundry";
  return null;
}

function googleModeFromStatus(mode: string | null | undefined): GoogleMode | null {
  if (!mode) return null;
  if (["gemini_api_key", "api_key", "gemini"].includes(mode)) return "gemini_api_key";
  if (["vertex", "vertex_ai"].includes(mode)) return "vertex";
  return null;
}

function providerMutationMessage(error: unknown): string {
  return error instanceof Error
    ? `Could not save provider settings. ${error.message}`
    : "Could not save provider settings. Check config.json access and Keychain Access, then retry.";
}

function providerRemovalMessage(provider: "Claude" | "Google", error: unknown): string {
  const prefix = `Could not remove ${provider} provider settings. No successful removal was confirmed.`;
  return `${prefix} ${credentialRecoveryMessage(error) ?? "Check credential status before trying again."}`;
}

function withoutEnvironmentManaged(
  request: CredentialBatchUpdateRequest,
  environmentManagedKeys: readonly CredentialKey[],
): CredentialBatchUpdateRequest {
  const managed = new Set(environmentManagedKeys);
  return { operations: request.operations.filter((operation) => !managed.has(operation.key)) };
}

function withoutUnavailableSecrets(
  request: CredentialBatchUpdateRequest,
  secretStorageAvailable: boolean,
): CredentialBatchUpdateRequest {
  if (secretStorageAvailable) return request;
  const secretKeys = new Set<CredentialKey>(SecretCredentialKeys);
  return {
    operations: request.operations.filter((operation) => !secretKeys.has(operation.key)),
  };
}

function activeModeManagedByEnvironment<TMode extends string>(
  mode: TMode | null,
  environmentManagedKeys: readonly CredentialKey[],
  keysByMode: Readonly<Record<TMode, readonly CredentialKey[]>>,
): boolean {
  if (!mode) return false;
  const managed = new Set(environmentManagedKeys);
  return keysByMode[mode].some((key) => managed.has(key));
}

const CLAUDE_MODE_CREDENTIAL_KEYS: Readonly<Record<ClaudeMode, readonly CredentialKey[]>> = {
  anthropic_api_key: ["ANTHROPIC_API_KEY"],
  vertex: ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"],
  bedrock: ["CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "AWS_REGION"],
  anthropic_aws: [
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "ANTHROPIC_AWS_WORKSPACE_ID",
    "AWS_PROFILE",
    "AWS_REGION",
  ],
  foundry: ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE"],
};

const GOOGLE_MODE_CREDENTIAL_KEYS: Readonly<Record<GoogleMode, readonly CredentialKey[]>> = {
  gemini_api_key: ["GEMINI_API_KEY"],
  vertex: ["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
};

const CLAUDE_OPTIONS: readonly ChoiceOption<ClaudeMode>[] = [
  {
    value: "anthropic_api_key",
    label: "Anthropic API key",
    description: "Direct Claude API authentication.",
  },
  {
    value: "vertex",
    label: "Google Vertex AI",
    description: "Claude through Vertex AI with Google Application Default Credentials.",
  },
  {
    value: "bedrock",
    label: "Amazon Bedrock",
    description: "Claude through the AWS default credential chain.",
  },
  {
    value: "anthropic_aws",
    label: "Claude Platform on AWS",
    description: "Anthropic workspace routing with AWS credentials.",
  },
  {
    value: "foundry",
    label: "Microsoft Foundry",
    description: "Claude through Azure default credentials.",
  },
];

const GOOGLE_OPTIONS: readonly ChoiceOption<GoogleMode>[] = [
  {
    value: "gemini_api_key",
    label: "Gemini API key",
    description: "Direct Gemini API authentication.",
  },
  {
    value: "vertex",
    label: "Vertex AI",
    description: "Gemini through Google Application Default Credentials.",
  },
];

export function providerModeLabel(
  provider: "claude" | "google",
  mode: string | null | undefined,
): string | null {
  const normalized =
    provider === "claude"
      ? claudeModeFromStatus(mode)
      : googleModeFromStatus(mode);
  if (!normalized) return null;
  const options = provider === "claude" ? CLAUDE_OPTIONS : GOOGLE_OPTIONS;
  return options.find((option) => option.value === normalized)?.label ?? null;
}
