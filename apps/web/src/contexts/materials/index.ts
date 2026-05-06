export { materialsKeys } from "./queryKeys.js";

export { useGenerateMaterialsMutation } from "./hooks/useGenerateMaterialsMutation.js";
export { useOpenArtifactMutation } from "./hooks/useOpenArtifactMutation.js";

export {
  ArtifactStatusBadge,
  type ArtifactStatusBadgeProps,
} from "./components/ArtifactStatusBadge.js";
export {
  ArtifactTypeBadge,
  type ArtifactTypeBadgeProps,
} from "./components/ArtifactTypeBadge.js";
export {
  GenerateMaterialsButton,
  type GenerateMaterialsButtonProps,
} from "./components/GenerateMaterialsButton.js";
export {
  OpenArtifactButton,
  type OpenArtifactButtonProps,
} from "./components/OpenArtifactButton.js";
export {
  artifactKindLabel,
  artifactFormatLabel,
  formatBytes,
} from "./lib/artifact-type-format.js";
export { artifactStatusTone } from "./lib/artifact-status-tone.js";

export {
  coverLetterGeneratedHandler,
  materialsExhaustedHandler,
  pdfRenderedHandler,
  resumeApprovedHandler,
  resumeFailedHandler,
} from "./handlers.js";
