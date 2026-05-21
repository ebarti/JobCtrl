const DESCRIPTIONS: Record<string, string> = {
  active: "Active means this registered artifact is the current file exposed by the local read model.",
  approved: "Approved means this generated material passed validation and is the accepted version for this job.",
  candidate: "Candidate means the material was generated but has not been accepted yet.",
  missing: "Missing means the metadata exists, but the local artifact file cannot be found.",
  rejected: "Rejected means validation or review did not accept this generated material.",
  stale: "Stale means the artifact may no longer match the latest job or profile state.",
  superseded: "Superseded means a newer artifact replaced this version.",
};

export function artifactStatusDescription(status: string): string {
  return DESCRIPTIONS[status] ?? `Artifact lifecycle status: ${status}.`;
}
