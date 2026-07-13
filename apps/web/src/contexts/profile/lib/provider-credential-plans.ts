import {
  CredentialBatchUpdateRequestSchema,
  type CredentialBatchUpdateRequest,
  type CredentialKey,
} from "@jobctrl/contracts";

export const CLAUDE_MODES = [
  "anthropic_api_key",
  "vertex",
  "bedrock",
  "anthropic_aws",
  "foundry",
] as const;
export type ClaudeMode = (typeof CLAUDE_MODES)[number];

export const GOOGLE_MODES = ["gemini_api_key", "vertex"] as const;
export type GoogleMode = (typeof GOOGLE_MODES)[number];

export const CODEX_LOGIN_COMMANDS = {
  subscription:
    'CODEX_HOME="${JOBCTRL_DIR:-$HOME/.jobctrl}/codex_home" codex login',
  apiKey:
    'printenv OPENAI_API_KEY | CODEX_HOME="${JOBCTRL_DIR:-$HOME/.jobctrl}/codex_home" codex login --with-api-key',
} as const;

export const CLAUDE_PROVIDER_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_REGION",
  "AWS_PROFILE",
] as const satisfies readonly CredentialKey[];

export const GOOGLE_PROVIDER_CREDENTIAL_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const satisfies readonly CredentialKey[];

export interface ClaudeProviderValues {
  mode: ClaudeMode;
  apiKey: string;
  vertexProjectId: string;
  vertexRegion: string;
  awsRegion: string;
  awsProfile: string;
  awsWorkspaceId: string;
  foundryResource: string;
  googleApplicationCredentials: string;
}

export interface GoogleProviderValues {
  mode: GoogleMode;
  apiKey: string;
  projectId: string;
  location: string;
  googleApplicationCredentials: string;
}

export function buildClaudeCredentialBatch(
  values: ClaudeProviderValues,
): CredentialBatchUpdateRequest {
  const selected: Partial<Record<CredentialKey, string>> = {};
  if (values.mode === "anthropic_api_key") {
    selected.ANTHROPIC_API_KEY = values.apiKey;
  } else if (values.mode === "vertex") {
    selected.CLAUDE_CODE_USE_VERTEX = "1";
    selected.ANTHROPIC_VERTEX_PROJECT_ID = values.vertexProjectId;
    selected.CLOUD_ML_REGION = values.vertexRegion;
    selected.GOOGLE_APPLICATION_CREDENTIALS = values.googleApplicationCredentials;
  } else if (values.mode === "bedrock") {
    selected.CLAUDE_CODE_USE_BEDROCK = "1";
    selected.AWS_REGION = values.awsRegion;
    selected.AWS_PROFILE = values.awsProfile;
  } else if (values.mode === "anthropic_aws") {
    selected.CLAUDE_CODE_USE_ANTHROPIC_AWS = "1";
    selected.ANTHROPIC_AWS_WORKSPACE_ID = values.awsWorkspaceId;
    selected.AWS_REGION = values.awsRegion;
    selected.AWS_PROFILE = values.awsProfile;
  } else {
    selected.CLAUDE_CODE_USE_FOUNDRY = "1";
    selected.ANTHROPIC_FOUNDRY_RESOURCE = values.foundryResource;
  }
  return withSharedAdcWrite(
    makeBatch(CLAUDE_PROVIDER_CREDENTIAL_KEYS, selected),
    values.mode === "vertex" ? values.googleApplicationCredentials : "",
  );
}

export function buildGoogleCredentialBatch(
  values: GoogleProviderValues,
): CredentialBatchUpdateRequest {
  const providerBatch = values.mode === "gemini_api_key"
    ? makeBatch(GOOGLE_PROVIDER_CREDENTIAL_KEYS, { GEMINI_API_KEY: values.apiKey })
    : makeBatch(GOOGLE_PROVIDER_CREDENTIAL_KEYS, {
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: values.projectId,
        GOOGLE_CLOUD_LOCATION: values.location,
      });
  return withSharedAdcWrite(
    providerBatch,
    values.mode === "vertex" ? values.googleApplicationCredentials : "",
  );
}

export function removeClaudeProviderBatch(): CredentialBatchUpdateRequest {
  return makeBatch(CLAUDE_PROVIDER_CREDENTIAL_KEYS, {});
}

export function removeGoogleProviderBatch(): CredentialBatchUpdateRequest {
  return makeBatch(GOOGLE_PROVIDER_CREDENTIAL_KEYS, {});
}

export function removeLegacyOpenAiKeyBatch(): CredentialBatchUpdateRequest {
  return { operations: [{ operation: "delete", key: "OPENAI_API_KEY" }] };
}

function makeBatch(
  keys: readonly CredentialKey[],
  selected: Partial<Record<CredentialKey, string>>,
): CredentialBatchUpdateRequest {
  const values = keys.map((key) => [key, selected[key]?.trim() ?? ""] as const);
  return CredentialBatchUpdateRequestSchema.parse({
    operations: [
      ...values.flatMap(([key, value]) =>
        value ? [{ operation: "set" as const, key, value }] : [],
      ),
      ...values.flatMap(([key, value]) =>
        value ? [] : [{ operation: "delete" as const, key }],
      ),
    ],
  });
}

function withSharedAdcWrite(
  request: CredentialBatchUpdateRequest,
  value: string,
): CredentialBatchUpdateRequest {
  const normalized = value.trim();
  if (!normalized) return request;
  return CredentialBatchUpdateRequestSchema.parse({
    operations: [
      { operation: "set", key: "GOOGLE_APPLICATION_CREDENTIALS", value: normalized },
      ...request.operations,
    ],
  });
}
