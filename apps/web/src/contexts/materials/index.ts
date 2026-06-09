export { materialsKeys } from "./queryKeys.js";

export { useGenerateMaterialsMutation } from "./hooks/useGenerateMaterialsMutation.js";
export { useOpenArtifactMutation } from "./hooks/useOpenArtifactMutation.js";
export {
  useRetailorCurrentPolicyMutation,
  useRetailorJobMutation,
  useTailorJobMutation,
  type RetailorCurrentPolicyVariables,
  type RetailorJobVariables,
  type TailorJobVariables,
} from "./hooks/useRetailorCurrentPolicyMutation.js";

export {
  ArtifactStatusBadge,
  type ArtifactStatusBadgeProps,
} from "./components/ArtifactStatusBadge.js";
export {
  ArtifactTailoringInspector,
  type ArtifactTailoringInspectorProps,
} from "./components/ArtifactTailoringInspector.js";
export {
  BulletProvenanceList,
  type BulletProvenanceListProps,
} from "./components/BulletProvenanceList.js";
export {
  EmployerAnalysisPanel,
  type EmployerAnalysisPanelProps,
} from "./components/EmployerAnalysisPanel.js";
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
  TailoringExplanationSection,
  type TailoringExplanationSectionProps,
} from "./components/TailoringExplanationSection.js";
export {
  RetailorCurrentPolicyButton,
  RetailorJobButton,
  TailorJobButton,
  type RetailorCurrentPolicyButtonProps,
  type RetailorJobButtonProps,
  type TailorJobButtonProps,
} from "./components/RetailorCurrentPolicyButton.js";
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
