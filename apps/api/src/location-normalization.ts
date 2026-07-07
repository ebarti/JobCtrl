/**
 * normalizeJobLocation — canonical location normalization for the read-model
 * projections. Mirrored in Python at
 * workers/automation/src/jobctl/infrastructure/projections/location_normalization.py.
 *
 * The TS and Python projection builders both write ``job_list_projections.location``
 * and MUST produce byte-identical output. Keep this module in lockstep with the
 * Python ``normalize_job_location``; the shared cross-runtime location table
 * (``packages/domain-types/test/fixtures/audit_projection_parity.json`` →
 * ``locationCases``, exercised by both ``apps/api/test/location-normalization.test.ts``
 * and ``workers/automation/tests/test_location_normalization.py``) fails if the two
 * implementations drift. Any change to the Spain region labels, the country tokens,
 * or the remote-token/marker patterns below must be mirrored in Python and covered
 * by a shared ``locationCases`` entry.
 */
const SPAIN_REGION_LABELS: Record<string, string> = {
  AN: "Andalusia",
  CT: "Catalonia",
  MD: "Community of Madrid",
};

const REMOTE_PATTERN = /\b(?:remote|en remoto|remoto|teletrabajo|work from home|wfh)\b/i;
const REMOTE_TOKEN_PATTERN = /\b(?:remote|en remoto|remoto|teletrabajo|work from home|wfh)\b/gi;
const REMOTE_MARKER_PATTERN = /\s*\((?:remote|en remoto|remoto)\)\s*/gi;
const REMOTE_SEPARATOR_PATTERN = /^\s*[-:|]+\s*|\s*[-:|]+\s*$/g;

export function normalizeJobLocation(location: string | null | undefined): string {
  const raw = String(location ?? "").trim();
  if (!raw) {
    return "";
  }

  const isRemote = REMOTE_PATTERN.test(raw) || /\((?:remote|en remoto|remoto)\)/i.test(raw);
  const cleaned = raw
    .replace(REMOTE_MARKER_PATTERN, " ")
    .split(",")
    .map(stripRemoteMarkers)
    .filter(Boolean);

  const hasSpainCountry = cleaned.some(isSpainCountryToken);
  const parts = cleaned
    .map((part) => normalizeLocationPart(part, hasSpainCountry))
    .filter(Boolean);
  const deduped = dedupeAdjacent(parts);
  const base = deduped.length ? deduped.join(", ") : isRemote ? "Remote" : raw;

  return isRemote && !/\bremote\b/i.test(base) ? `${base} (Remote)` : base;
}

function stripRemoteMarkers(part: string): string {
  return part
    .replace(REMOTE_MARKER_PATTERN, " ")
    .replace(REMOTE_TOKEN_PATTERN, " ")
    .replace(REMOTE_SEPARATOR_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeLocationPart(part: string, hasSpainCountry: boolean): string {
  const token = part.trim();
  if (!token) {
    return "";
  }
  if (isSpainCountryToken(token)) {
    return "Spain";
  }
  if (hasSpainCountry) {
    const region = SPAIN_REGION_LABELS[token.toUpperCase()];
    if (region) {
      return region;
    }
  }
  return token;
}

function isSpainCountryToken(part: string): boolean {
  return /^(?:ES|ESP|Spain|España)$/i.test(part.trim());
}

function dedupeAdjacent(parts: string[]): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (result[result.length - 1]?.toLocaleLowerCase() !== part.toLocaleLowerCase()) {
      result.push(part);
    }
  }
  return result;
}
