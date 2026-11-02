import { SEMANTIC_TAXONOMY } from "@jobctrl/contracts";

export class UnsupportedRemoteSearchInputError extends Error {
  constructor(message: string) {
    super(`${message} Your saved settings are unchanged.`);
  }
}

export class InvalidSavedTargetSearchError extends Error {
  constructor() {
    super("Saved Target search is invalid. Preserve the workspace and restore a verified backup, then retry.");
  }
}

// Match the worker's str.strip and split_target_rows behavior, including the
// positional empty rows and Python's whitespace characters.
const PYTHON_SPACE = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_TRIM = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, "g");
// Python's Unicode IGNORECASE also matches long-s and dotted/dotless i.
const TARGET_PREFIX = new RegExp(
  `^[${PYTHON_SPACE}]*[Tt][Aa][Rr][Gg][Ee][Tt] (?:[Rr][Oo][Ll][Ee][Ss\u017f]?|[Ll][Oo][Cc][Aa][Tt][Ii\u0130\u0131][Oo][Nn][Ss\u017f]?):[${PYTHON_SPACE}]*`,
);

function targetRows(value: string): string[] {
  if (!value.replace(PYTHON_TRIM, "")) return [];
  return value.replace(TARGET_PREFIX, "").split(/[;\n]/).map((item) => item.replace(PYTHON_TRIM, ""));
}

export interface RemoteTargetRow { location: string; choices: string[]; label: string | null }

export function hasProfileTargetRows(locations: string, workModels: string): boolean {
  const places = targetRows(locations);
  const models = targetRows(workModels);
  return Array.from({ length: Math.max(places.length, models.length) }, (_, index) =>
    Boolean(places[index] || models[index])).some(Boolean);
}

export function legacyRemoteTargetRows(value: unknown): RemoteTargetRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return row.remote === true && typeof row.location === "string"
      ? [{ location: row.location, choices: ["remote"], label: typeof row.label === "string" ? row.label : null }] : [];
  });
}

export function effectiveLegacyRemoteTargetRows(config: Record<string, unknown>): RemoteTargetRow[] {
  // Python uses first-use defaults for an empty settings object.
  return Object.keys(config).length === 0
    ? [{ location: "Remote", choices: ["remote"], label: "remote" }] : legacyRemoteTargetRows(config.locations);
}

export function guardedTargetRows(locations: string, workModels: string): RemoteTargetRow[] {
  const places = targetRows(locations);
  const models = targetRows(workModels);
  const rows: RemoteTargetRow[] = [];
  for (let index = 0; index < Math.max(places.length, models.length); index += 1) {
    const selected = (models[index] ?? "").split(",").map((item) => item.replace(PYTHON_TRIM, ""));
    const location = places[index] ?? "";
    const nonremote = ["hybrid", SEMANTIC_TAXONOMY.workModel.hybrid, "onsite", SEMANTIC_TAXONOMY.workModel.onsite];
    const remoteChoices = selected.filter((choice) => choice === "remote" || choice === SEMANTIC_TAXONOMY.workModel.remote);
    const nonremoteChoices = selected.filter((choice) => nonremote.includes(choice));
    if (remoteChoices.length) rows.push({ location, choices: remoteChoices, label: location || "Remote" });
    if (!location && nonremoteChoices.length) rows.push({ location, choices: nonremoteChoices, label: "" });
  }
  return rows;
}

export function activeTargetRows(rows: RemoteTargetRow[], config: Record<string, unknown>): RemoteTargetRow[] {
  const labels = config.location_labels;
  return Array.isArray(labels) && labels.length
    ? rows.filter((row) => row.label !== null && labels.includes(row.label)) : rows;
}

export function unsupportedRemoteScope(row: RemoteTargetRow, boards: readonly string[], hoursOld: number): string | null {
  const nonremote = ["hybrid", SEMANTIC_TAXONOMY.workModel.hybrid, "onsite", SEMANTIC_TAXONOMY.workModel.onsite];
  if (!row.location && row.choices.some((choice) => nonremote.includes(choice))) {
    return "A Hybrid or On-site search needs a location. Add a location or choose only Remote for that row.";
  }
  if (boards.includes("indeed")) {
    return "Indeed cannot combine Remote with the selected lookback. Deselect Indeed or choose a non-Remote target.";
  }
  if (boards.includes("glassdoor") && row.location) {
    return "Glassdoor cannot combine Remote with a selected location. Deselect Glassdoor or use a location-free Remote target.";
  }
  const dayLimited = boards.filter((board) => board === "glassdoor" || board === "zip_recruiter");
  if (dayLimited.length && hoursOld % 24 !== 0) {
    return `${dayLimited.join(", ")} can apply a Remote lookback only in whole days. Choose a lookback in multiples of 24 hours or deselect the board.`;
  }
  return null;
}
