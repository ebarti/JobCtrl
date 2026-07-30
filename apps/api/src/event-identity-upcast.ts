import type { SqliteDatabase } from "./db.js";

export const EVENT_IDENTITY_UPCAST_VERSION = 1;

const SINGLE_FIELDS: Record<string, string> = {
  jobId: "jobId",
  jobUrl: "jobId",
  jobKey: "jobId",
  job_id: "job_id",
  job_url: "job_id",
  job_key: "job_id",
  candidateJobId: "candidateJobId",
  candidate_job_id: "candidate_job_id",
  survivingJobId: "survivingJobId",
  surviving_job_id: "surviving_job_id",
};

const PLURAL_FIELDS: Record<string, string> = {
  jobIds: "jobIds",
  jobUrls: "jobIds",
  jobKeys: "jobIds",
  job_ids: "job_ids",
  job_urls: "job_ids",
  job_keys: "job_ids",
};
const ROOT_PRIMARY_FIELDS = [
  "jobId",
  "job_id",
  "survivingJobId",
  "surviving_job_id",
] as const;
const NON_JOB_SCOPE_REFERENCES = new Set(["pipeline"]);

export class EventIdentityUpcastError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "EventIdentityUpcastError";
    this.code = code;
  }
}

export interface UpcastedEventIdentity {
  version: number;
  jobId: string | null;
  referencedJobIds: string[];
  payload: Record<string, unknown>;
}

export function upcastEventIdentity(
  db: SqliteDatabase,
  input: {
    tenantId: string;
    eventJobReference: string | null;
    payload: unknown;
  },
): UpcastedEventIdentity {
  const tenantId = String(input.tenantId ?? "").trim();
  if (!tenantId) {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }

  const referenced = new Set<string>();
  const columnJobId =
    input.eventJobReference === null
      ? null
      : resolveReference(db, tenantId, input.eventJobReference);
  if (columnJobId !== null) referenced.add(columnJobId);

  if (!isRecord(input.payload)) {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }
  const payload = upcastValue(db, tenantId, input.payload, referenced);
  if (!isRecord(payload)) {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }

  const rootJobIds = new Set(
    ROOT_PRIMARY_FIELDS
      .map((key) => payload[key])
      .filter(
        (value): value is string =>
          typeof value === "string" && !NON_JOB_SCOPE_REFERENCES.has(value),
      ),
  );
  const primaryJobIds = new Set(rootJobIds);
  if (columnJobId !== null) primaryJobIds.add(columnJobId);
  if (primaryJobIds.size > 1) {
    throw new EventIdentityUpcastError("event_job_identity_conflict");
  }

  let jobId: string | null;
  if (columnJobId !== null) {
    jobId = columnJobId;
  } else if (rootJobIds.size === 1) {
    jobId = rootJobIds.values().next().value ?? null;
  } else {
    const inferableJobIds = inferablePayloadJobIds(payload);
    jobId =
      inferableJobIds.size === 1
        ? inferableJobIds.values().next().value ?? null
        : null;
  }
  return {
    version: EVENT_IDENTITY_UPCAST_VERSION,
    jobId,
    referencedJobIds: [...referenced].sort(),
    payload,
  };
}

function upcastValue(
  db: SqliteDatabase,
  tenantId: string,
  value: unknown,
  referenced: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => upcastValue(db, tenantId, item, referenced));
  }
  if (!isRecord(value)) return value;

  const transformed: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    let outputKey = key;
    let outputValue: unknown;
    if (hasOwn(SINGLE_FIELDS, key)) {
      outputKey = SINGLE_FIELDS[key]!;
      outputValue = upcastSingleReference(db, tenantId, rawValue, referenced);
    } else if (hasOwn(PLURAL_FIELDS, key)) {
      outputKey = PLURAL_FIELDS[key]!;
      outputValue = upcastReferenceCollection(db, tenantId, rawValue, referenced);
    } else {
      outputValue = upcastValue(db, tenantId, rawValue, referenced);
    }
    if (
      Object.prototype.hasOwnProperty.call(transformed, outputKey)
      && !valuesEqual(transformed[outputKey], outputValue)
    ) {
      throw new EventIdentityUpcastError("event_job_identity_conflict");
    }
    Object.defineProperty(transformed, outputKey, {
      value: outputValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return transformed;
}

function upcastSingleReference(
  db: SqliteDatabase,
  tenantId: string,
  value: unknown,
  referenced: Set<string>,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }
  const normalized = value.trim();
  if (NON_JOB_SCOPE_REFERENCES.has(normalized)) {
    return normalized;
  }
  const jobId = resolveReference(db, tenantId, value);
  referenced.add(jobId);
  return jobId;
}

function upcastReferenceCollection(
  db: SqliteDatabase,
  tenantId: string,
  value: unknown,
  referenced: Set<string>,
): Array<string | null> {
  if (!Array.isArray(value)) {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }
  return value.map((item) => upcastSingleReference(db, tenantId, item, referenced));
}

function resolveReference(
  db: SqliteDatabase,
  tenantId: string,
  reference: string,
): string {
  const normalized = String(reference ?? "").trim();
  if (!normalized) {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }

  const directUrl = jobIdFromQuery(
    db,
    `
      SELECT job_id
      FROM jobs
      WHERE tenant_id = ? AND url = ?
    `,
    tenantId,
    normalized,
  );
  const aliasUrl = aliasTableExists(db)
    ? jobIdFromQuery(
        db,
        `
          SELECT jobs.job_id
          FROM job_identity_aliases AS aliases
          JOIN jobs
            ON jobs.tenant_id = aliases.tenant_id
           AND jobs.job_id = aliases.job_id
          WHERE aliases.tenant_id = ?
            AND aliases.alias_kind = 'posting_url'
            AND aliases.alias_value = ?
        `,
        tenantId,
        normalized,
      )
    : null;
  if (directUrl !== null && aliasUrl !== null && directUrl !== aliasUrl) {
    throw new EventIdentityUpcastError("event_job_identity_conflict");
  }
  const urlJobId = directUrl ?? aliasUrl;
  if (urlJobId !== null) return urlJobId;

  const stableJobId = jobIdFromQuery(
    db,
    `
      SELECT job_id
      FROM jobs
      WHERE tenant_id = ? AND job_id = ?
    `,
    tenantId,
    normalized,
  );
  if (stableJobId === null) {
    throw new EventIdentityUpcastError("event_job_identity_unresolved");
  }
  return stableJobId;
}

function jobIdFromQuery(
  db: SqliteDatabase,
  sql: string,
  tenantId: string,
  reference: string,
): string | null {
  const row = db.prepare(sql).get(tenantId, reference) as
    | { job_id?: string | null }
    | undefined;
  if (row === undefined) return null;
  const jobId = String(row.job_id ?? "").trim();
  if (!jobId) {
    throw new EventIdentityUpcastError("event_job_identity_invalid");
  }
  return jobId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function aliasTableExists(db: SqliteDatabase): boolean {
  const row = db
    .prepare(
      `
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'job_identity_aliases'
        LIMIT 1
      `,
    )
    .get();
  return row !== undefined;
}

function inferablePayloadJobIds(value: unknown): Set<string> {
  const inferred = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const jobId of inferablePayloadJobIds(item)) inferred.add(jobId);
    }
    return inferred;
  }
  if (!isRecord(value)) return inferred;

  for (const [key, item] of Object.entries(value)) {
    if (
      (key === "jobId" || key === "job_id")
      && typeof item === "string"
      && !NON_JOB_SCOPE_REFERENCES.has(item)
    ) {
      inferred.add(item);
    } else if ((key === "jobIds" || key === "job_ids") && Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === "string" && !NON_JOB_SCOPE_REFERENCES.has(entry)) {
          inferred.add(entry);
        }
      }
    } else if (
      ![
        "candidateJobId",
        "candidate_job_id",
        "survivingJobId",
        "surviving_job_id",
      ].includes(key)
    ) {
      for (const jobId of inferablePayloadJobIds(item)) inferred.add(jobId);
    }
  }
  return inferred;
}
