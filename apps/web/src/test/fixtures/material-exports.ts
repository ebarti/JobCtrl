import type {
  AcceptedMaterialExports,
  AcceptedMaterialExportReceipt,
} from "@jobctrl/contracts";

export const exportJobId = "90000000-0000-4000-8000-000000001030";
export const sampleDocxReceipt: AcceptedMaterialExportReceipt = {
  contract: "accepted-material-docx-v1",
  tenantId: "local",
  jobId: exportJobId,
  artifactId: "1030",
  sourceArtifactId: "accepted-resume",
  generation: 1,
  kind: "tailored_resume",
  sourceSha256: "a".repeat(64),
  sourceMetadataSha256: "b".repeat(64),
  settings: {
    format: "docx",
    layout: "semantic-v1",
    paper: "A4",
    locale: "fr-FR",
  },
  settingsSha256: "c".repeat(64),
  sha256: "d".repeat(64),
  createdAt: "2026-10-17T12:00:00Z",
  warnings: ["PDF fonts and pagination are not reproduced."],
};
export function sampleMaterialExports(
  retained = false,
): AcceptedMaterialExports {
  return {
    tenantId: "local",
    jobId: exportJobId,
    exportedArtifactId: null,
    sources: [
      {
        artifactId: "accepted-resume",
        generation: 1,
        kind: "tailored_resume",
        locale: "fr-FR",
        sha256: "a".repeat(64),
        metadataSha256: "b".repeat(64),
        unavailableReason: null,
      },
      {
        artifactId: "accepted-cover",
        generation: 1,
        kind: "cover_letter",
        locale: null,
        sha256: "e".repeat(64),
        metadataSha256: "f".repeat(64),
        unavailableReason: null,
      },
    ],
    exports: retained ? [structuredClone(sampleDocxReceipt)] : [],
  };
}
