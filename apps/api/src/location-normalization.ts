/** Preserve the source location verbatim; interpretations own work model and places. */
export function normalizeJobLocation(location: string | null | undefined): string {
  return String(location ?? "").trim();
}
