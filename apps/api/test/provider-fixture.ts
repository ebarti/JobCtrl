/** Synthetic provider results: no SDK, authentication or external provider is used. */
export const providerStatusResult = { providers: [
  { provider: "codex", configured: true, ready: true, mode: "subscription" },
  { provider: "claude", configured: false, ready: false, mode: null },
  { provider: "google", configured: false, ready: false, mode: null },
] };
export const providerModelsResult = { providers: [
  { provider: "codex", configured: true, ready: true, source: "live", models: [{ id: "synthetic-model", displayName: "Synthetic model", isDefault: true }] },
  { provider: "claude", configured: false, ready: false, source: "live", models: [] },
  { provider: "google", configured: false, ready: false, source: "live", models: [] },
] };
export const providerVerifyResult = { provider: "codex", ok: true, status: "connected", message: "Synthetic verification." };
