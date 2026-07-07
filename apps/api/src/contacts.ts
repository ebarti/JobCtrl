/**
 * Contact & Outreach (ninth bounded context) — local TS API write + read model.
 *
 * Phase 1 hosts simple contact state transitions directly in the TS API (per
 * docs/architecture/domain-model/integration.md §6.8): create, update, CSV
 * import (resolved decision 4), and soft-delete. Each writes the canonical
 * ``contacts`` / ``contact_attributes`` rows, appends durable + SSE-visible
 * events to ``job_events`` (entity_kind='contact'), and refreshes the read
 * model. The Python worker's ``SqliteContactRepository`` writes the same tables
 * and event types.
 *
 * Sensitivity (outreach planner plan §6; CLAUDE.md): attribute VALUES live only
 * in ``contact_attributes.value_json`` and reach the client solely through the
 * read DTOs below — never in event payloads, projections, logs, or telemetry.
 * Every rendered fact carries provenance (INV-2). There is no send transport
 * anywhere in this module (INV-1).
 */

import crypto from "node:crypto";

import type {
  ContactAttributeDto,
  ContactAttributeInput,
  ContactCreateRequest,
  ContactDeleteResponse,
  ContactDetail,
  ContactImportRequest,
  ContactImportResponse,
  ContactListQuery,
  ContactRole,
  ContactSourceKind,
  ContactSummary,
  ContactUpdateRequest,
} from "./contracts.js";
import { CONTACT_ROLES } from "@jobctl/domain-types";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { refreshProjections } from "./projections.js";

const TENANT_ID = "local";
const USER_ENTERED_REF = "user_entered";

export class ContactInputError extends Error {}
export class ContactNotFoundError extends Error {}

interface ProvenanceSeed {
  sourceKind: ContactSourceKind;
  sourceRef: string;
  captureMethod: string;
  confidence: number;
  userConfirmed: boolean;
}

interface AttributeSeed {
  attributeId: string;
  kind: string;
  value: string;
}

export function ensureContactTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      tenant_id   TEXT NOT NULL DEFAULT 'local',
      contact_id  TEXT NOT NULL,
      employer    TEXT,
      job_url     TEXT,
      role        TEXT NOT NULL DEFAULT 'other',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      PRIMARY KEY (tenant_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS contact_attributes (
      tenant_id      TEXT NOT NULL DEFAULT 'local',
      attribute_id   TEXT NOT NULL,
      contact_id     TEXT NOT NULL,
      attribute_kind TEXT NOT NULL,
      value_json     TEXT,
      source_kind    TEXT NOT NULL,
      source_ref     TEXT NOT NULL,
      capture_method TEXT NOT NULL,
      confidence     REAL NOT NULL DEFAULT 0,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      recorded_at    TEXT NOT NULL,
      PRIMARY KEY (tenant_id, attribute_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_lookup ON contacts(tenant_id, employer, job_url);
    CREATE INDEX IF NOT EXISTS idx_contact_attributes_contact
      ON contact_attributes(tenant_id, contact_id);
  `);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listContacts(
  db: SqliteDatabase,
  query: ContactListQuery = { jobId: "", employer: "" },
): ContactSummary[] {
  ensureContactTables(db);
  refreshProjections(db, TENANT_ID);
  const filters: string[] = ["tenant_id = ?"];
  const params: SqliteValue[] = [TENANT_ID];
  const jobId = (query.jobId ?? "").trim();
  const employer = (query.employer ?? "").trim();
  if (jobId) {
    filters.push("job_id = ?");
    params.push(jobId);
  }
  if (employer) {
    filters.push("employer = ?");
    params.push(employer);
  }
  const rows = allRows<ContactProjectionRow>(
    db,
    `SELECT * FROM contact_projections WHERE ${filters.join(" AND ")}
     ORDER BY updated_at DESC, contact_id ASC`,
    params,
  );
  return rows.map((row) => toSummary(db, row));
}

export function getContactDetail(db: SqliteDatabase, contactId: string): ContactDetail | null {
  ensureContactTables(db);
  refreshProjections(db, TENANT_ID);
  const row = getRow<ContactProjectionRow>(
    db,
    "SELECT * FROM contact_projections WHERE tenant_id = ? AND contact_id = ?",
    [TENANT_ID, contactId],
  );
  if (!row) {
    return null;
  }
  const attributes = readAttributes(db, contactId);
  return {
    contactId,
    displayName: displayNameFrom(attributes),
    role: normalizeRole(row.role),
    employer: row.employer ?? null,
    jobId: row.job_id ?? null,
    attributes,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function requireContactDetail(db: SqliteDatabase, contactId: string): ContactDetail {
  const detail = getContactDetail(db, contactId);
  if (!detail) {
    throw new ContactNotFoundError(`Contact ${contactId} not found`);
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function createContact(db: SqliteDatabase, request: ContactCreateRequest): ContactDetail {
  ensureContactTables(db);
  const employer = normalizeLink(request.employer);
  const jobId = normalizeLink(request.jobId);
  if (!employer && !jobId) {
    throw new ContactInputError("A contact must link to at least one of employer or jobId.");
  }
  const contactId = crypto.randomUUID();
  const now = new Date().toISOString();
  const provenance: ProvenanceSeed = {
    sourceKind: "user_entered",
    sourceRef: USER_ENTERED_REF,
    captureMethod: "manual",
    confidence: 1,
    userConfirmed: true,
  };
  const attributes = seedAttributes(request.attributes ?? []);
  const transaction = db.transaction(() => {
    insertContactRow(db, { contactId, employer, jobId, role: request.role, createdAt: now, updatedAt: now });
    insertAttributes(db, contactId, attributes, provenance, now);
    recordContactEvent(db, {
      jobUrl: jobId,
      eventType: "ContactCreated",
      contactId,
      payload: {
        tenantId: TENANT_ID,
        contactId,
        employer,
        jobId,
        role: request.role,
        createdAt: now,
      },
    });
    for (const attribute of attributes) {
      recordAttributeEvent(db, contactId, jobId, attribute, provenance, now);
    }
  });
  transaction();
  return requireContactDetail(db, contactId);
}

export function updateContact(
  db: SqliteDatabase,
  contactId: string,
  request: ContactUpdateRequest,
): ContactDetail {
  ensureContactTables(db);
  const existing = getRow<ContactRow>(
    db,
    "SELECT * FROM contacts WHERE tenant_id = ? AND contact_id = ? AND deleted_at IS NULL",
    [TENANT_ID, contactId],
  );
  if (!existing) {
    throw new ContactNotFoundError(`Contact ${contactId} not found`);
  }
  const employer =
    request.employer !== undefined ? normalizeLink(request.employer) : existing.employer ?? null;
  const jobId = request.jobId !== undefined ? normalizeLink(request.jobId) : existing.job_url ?? null;
  if (!employer && !jobId) {
    throw new ContactInputError("A contact must link to at least one of employer or jobId.");
  }
  const role = request.role ?? normalizeRole(existing.role);
  const now = new Date().toISOString();
  const existingAttributes = readAttributes(db, contactId);
  const previousFacts = new Set(
    existingAttributes.map((attribute) => `${attribute.kind} ${attribute.value}`),
  );
  const provenance: ProvenanceSeed = {
    sourceKind: "user_entered",
    sourceRef: USER_ENTERED_REF,
    captureMethod: "manual",
    confidence: 1,
    userConfirmed: true,
  };
  const changed = changedFields(existing, { employer, jobId, role }, request.attributes !== undefined);
  const nextAttributes =
    request.attributes !== undefined ? seedAttributes(request.attributes) : null;
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE contacts SET employer = ?, job_url = ?, role = ?, updated_at = ?
       WHERE tenant_id = ? AND contact_id = ?`,
    ).run(employer, jobId, role, now, TENANT_ID, contactId);
    if (nextAttributes !== null) {
      db.prepare("DELETE FROM contact_attributes WHERE tenant_id = ? AND contact_id = ?").run(
        TENANT_ID,
        contactId,
      );
      // A fact whose (kind, value) is unchanged keeps its original attribute
      // id and provenance (INV-2: editing the contact must not re-stamp
      // imported/derived facts as user_entered); only new or value-edited
      // facts are user-entered.
      const remaining = new Map<string, ContactAttributeDto[]>();
      for (const attribute of existingAttributes) {
        const key = `${attribute.kind} ${attribute.value}`;
        const bucket = remaining.get(key);
        if (bucket) {
          bucket.push(attribute);
        } else {
          remaining.set(key, [attribute]);
        }
      }
      const rows = nextAttributes.map((seed) => {
        const kept = remaining.get(`${seed.kind} ${seed.value}`)?.shift();
        if (kept) {
          return {
            attributeId: kept.attributeId,
            kind: seed.kind,
            value: seed.value,
            provenance: {
              sourceKind: kept.provenance.sourceKind,
              sourceRef: kept.provenance.sourceRef,
              captureMethod: kept.provenance.captureMethod,
              confidence: kept.provenance.confidence,
              userConfirmed: kept.provenance.userConfirmed,
            },
            recordedAt: kept.provenance.capturedAt,
          };
        }
        return { attributeId: seed.attributeId, kind: seed.kind, value: seed.value, provenance, recordedAt: now };
      });
      insertAttributeRows(db, contactId, rows);
    }
    recordContactEvent(db, {
      jobUrl: jobId,
      eventType: "ContactUpdated",
      contactId,
      payload: { tenantId: TENANT_ID, contactId, changedFields: changed, updatedAt: now },
    });
    if (nextAttributes !== null) {
      for (const attribute of nextAttributes) {
        if (!previousFacts.has(`${attribute.kind} ${attribute.value}`)) {
          recordAttributeEvent(db, contactId, jobId, attribute, provenance, now);
        }
      }
    }
  });
  transaction();
  return requireContactDetail(db, contactId);
}

export function deleteContact(
  db: SqliteDatabase,
  contactId: string,
  reason = "",
): ContactDeleteResponse {
  ensureContactTables(db);
  const deletedAt = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE contacts SET deleted_at = ?, updated_at = ?
       WHERE tenant_id = ? AND contact_id = ? AND deleted_at IS NULL`,
    )
    .run(deletedAt, deletedAt, TENANT_ID, contactId);
  if (result.changes <= 0) {
    throw new ContactNotFoundError(`Contact ${contactId} not found`);
  }
  recordContactEvent(db, {
    jobUrl: null,
    eventType: "ContactDeleted",
    contactId,
    payload: { tenantId: TENANT_ID, contactId, reason, deletedAt },
  });
  refreshProjections(db, TENANT_ID);
  return { ok: true, contactId, deletedAt };
}

export function importContacts(
  db: SqliteDatabase,
  request: ContactImportRequest,
): ContactImportResponse {
  ensureContactTables(db);
  const filename = request.filename.trim() || "import.csv";
  const now = new Date().toISOString();
  const provenance: ProvenanceSeed = {
    sourceKind: "user_imported_list",
    sourceRef: filename,
    captureMethod: "manual",
    confidence: 1,
    userConfirmed: true,
  };
  const rows = parseCsv(request.csvText);
  let imported = 0;
  let skipped = 0;
  const contactIds: string[] = [];
  const transaction = db.transaction(() => {
    for (const row of rows) {
      const employer = normalizeLink(firstColumn(row, EMPLOYER_COLUMNS));
      const jobId = normalizeLink(firstColumn(row, JOB_COLUMNS));
      if (!employer && !jobId) {
        skipped += 1;
        continue;
      }
      const role = normalizeRole(firstColumn(row, ["role"]));
      const attributes = seedAttributes(csvAttributes(row));
      const contactId = crypto.randomUUID();
      insertContactRow(db, { contactId, employer, jobId, role, createdAt: now, updatedAt: now });
      insertAttributes(db, contactId, attributes, provenance, now);
      recordContactEvent(db, {
        jobUrl: jobId,
        eventType: "ContactCreated",
        contactId,
        payload: { tenantId: TENANT_ID, contactId, employer, jobId, role, createdAt: now },
      });
      for (const attribute of attributes) {
        recordAttributeEvent(db, contactId, jobId, attribute, provenance, now);
      }
      imported += 1;
      contactIds.push(contactId);
    }
  });
  transaction();
  refreshProjections(db, TENANT_ID);
  return { ok: true, imported, skipped, contactIds };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ContactRow = {
  contact_id: string;
  employer: string | null;
  job_url: string | null;
  role: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ContactProjectionRow = {
  contact_id: string;
  employer: string | null;
  job_id: string | null;
  role: string | null;
  attribute_count: number | null;
  confirmed_count: number | null;
  source_kinds_json: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ContactAttributeRow = {
  attribute_id: string;
  attribute_kind: string;
  value_json: string | null;
  source_kind: string;
  source_ref: string;
  capture_method: string | null;
  confidence: number | null;
  user_confirmed: number | null;
  recorded_at: string | null;
};

const ATTRIBUTE_COLUMNS: Record<string, string> = {
  name: "name",
  full_name: "name",
  title: "title",
  role_title: "title",
  email: "email",
  phone: "phone",
  profile_url: "profile_url",
  profileurl: "profile_url",
  linkedin: "profile_url",
  note: "note",
  notes: "note",
};
const EMPLOYER_COLUMNS = ["employer", "company"] as const;
const JOB_COLUMNS = ["job_id", "jobid", "job_url", "joburl"] as const;

function toSummary(db: SqliteDatabase, row: ContactProjectionRow): ContactSummary {
  const attributeCount = Number(row.attribute_count ?? 0);
  const confirmedCount = Number(row.confirmed_count ?? 0);
  return {
    contactId: String(row.contact_id),
    displayName: readDisplayName(db, String(row.contact_id)),
    role: normalizeRole(row.role),
    employer: row.employer ?? null,
    jobId: row.job_id ?? null,
    attributeCount,
    confirmedCount,
    sourceKinds: parseStringArray(row.source_kinds_json) as ContactSourceKind[],
    allConfirmed: attributeCount > 0 && confirmedCount === attributeCount,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function readAttributes(db: SqliteDatabase, contactId: string): ContactAttributeDto[] {
  const rows = allRows<ContactAttributeRow>(
    db,
    `SELECT attribute_id, attribute_kind, value_json, source_kind, source_ref,
            capture_method, confidence, user_confirmed, recorded_at
     FROM contact_attributes
     WHERE tenant_id = ? AND contact_id = ?
     ORDER BY recorded_at ASC, attribute_id ASC`,
    [TENANT_ID, contactId],
  );
  return rows.map((row) => ({
    attributeId: String(row.attribute_id),
    kind: String(row.attribute_kind),
    value: decodeValue(row.value_json),
    provenance: {
      sourceKind: String(row.source_kind) as ContactSourceKind,
      sourceRef: String(row.source_ref),
      captureMethod: String(row.capture_method ?? "manual"),
      capturedAt: String(row.recorded_at ?? ""),
      confidence: Number(row.confidence ?? 0),
      userConfirmed: Boolean(Number(row.user_confirmed ?? 0)),
    },
  }));
}

function readDisplayName(db: SqliteDatabase, contactId: string): string {
  const row = getRow<{ value_json: string | null }>(
    db,
    `SELECT value_json FROM contact_attributes
     WHERE tenant_id = ? AND contact_id = ? AND attribute_kind = 'name'
     ORDER BY recorded_at ASC, attribute_id ASC LIMIT 1`,
    [TENANT_ID, contactId],
  );
  return row ? decodeValue(row.value_json) : "";
}

function displayNameFrom(attributes: ContactAttributeDto[]): string {
  return attributes.find((attribute) => attribute.kind === "name")?.value ?? "";
}

function insertContactRow(
  db: SqliteDatabase,
  input: {
    contactId: string;
    employer: string | null;
    jobId: string | null;
    role: ContactRole;
    createdAt: string;
    updatedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO contacts (tenant_id, contact_id, employer, job_url, role, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(TENANT_ID, input.contactId, input.employer, input.jobId, input.role, input.createdAt, input.updatedAt);
}

interface AttributeRowSeed {
  attributeId: string;
  kind: string;
  value: string;
  provenance: ProvenanceSeed;
  recordedAt: string;
}

function insertAttributeRows(db: SqliteDatabase, contactId: string, rows: AttributeRowSeed[]): void {
  const statement = db.prepare(
    `INSERT INTO contact_attributes (
       tenant_id, attribute_id, contact_id, attribute_kind, value_json,
       source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    statement.run(
      TENANT_ID,
      row.attributeId,
      contactId,
      row.kind,
      JSON.stringify(row.value),
      row.provenance.sourceKind,
      row.provenance.sourceRef,
      row.provenance.captureMethod,
      row.provenance.confidence,
      row.provenance.userConfirmed ? 1 : 0,
      row.recordedAt,
    );
  }
}

function insertAttributes(
  db: SqliteDatabase,
  contactId: string,
  attributes: AttributeSeed[],
  provenance: ProvenanceSeed,
  recordedAt: string,
): void {
  insertAttributeRows(
    db,
    contactId,
    attributes.map((attribute) => ({
      attributeId: attribute.attributeId,
      kind: attribute.kind,
      value: attribute.value,
      provenance,
      recordedAt,
    })),
  );
}

function recordAttributeEvent(
  db: SqliteDatabase,
  contactId: string,
  jobUrl: string | null,
  attribute: AttributeSeed,
  provenance: ProvenanceSeed,
  recordedAt: string,
): void {
  recordContactEvent(db, {
    jobUrl,
    eventType: "ContactAttributeRecorded",
    contactId,
    payload: {
      tenantId: TENANT_ID,
      contactId,
      attributeId: attribute.attributeId,
      attributeKind: attribute.kind,
      sourceKind: provenance.sourceKind,
      sourceRef: provenance.sourceRef,
      captureMethod: provenance.captureMethod,
      confidence: provenance.confidence,
      userConfirmed: provenance.userConfirmed,
      recordedAt,
    },
  });
}

function recordContactEvent(
  db: SqliteDatabase,
  event: {
    jobUrl: string | null;
    eventType: string;
    contactId: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!tableExists(db, "job_events")) {
    return;
  }
  const columns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(job_events)").map((row) => row.name),
  );
  const values: Record<string, SqliteValue> = {
    job_url: event.jobUrl,
    stage: null,
    event_type: event.eventType,
    level: "info",
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify(event.payload),
    entity_kind: "contact",
    entity_ref: event.contactId,
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries
      .map(() => "?")
      .join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function seedAttributes(inputs: ContactAttributeInput[]): AttributeSeed[] {
  const seeds: AttributeSeed[] = [];
  for (const input of inputs) {
    const value = input.value.trim();
    if (!value) {
      continue;
    }
    seeds.push({ attributeId: crypto.randomUUID(), kind: input.kind, value });
  }
  return seeds;
}

function csvAttributes(row: Record<string, string>): ContactAttributeInput[] {
  const inputs: ContactAttributeInput[] = [];
  for (const [column, kind] of Object.entries(ATTRIBUTE_COLUMNS)) {
    const value = (row[column] ?? "").trim();
    if (value) {
      inputs.push({ kind: kind as ContactAttributeInput["kind"], value });
    }
  }
  return inputs;
}

function changedFields(
  existing: ContactRow,
  next: { employer: string | null; jobId: string | null; role: ContactRole },
  attributesReplaced: boolean,
): string[] {
  const changed: string[] = [];
  if (normalizeRole(existing.role) !== next.role) {
    changed.push("role");
  }
  if ((existing.employer ?? null) !== next.employer) {
    changed.push("employer");
  }
  if ((existing.job_url ?? null) !== next.jobId) {
    changed.push("jobId");
  }
  if (attributesReplaced) {
    changed.push("attributes");
  }
  return changed;
}

function firstColumn(row: Record<string, string>, columns: readonly string[]): string {
  for (const column of columns) {
    const value = (row[column] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizeLink(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRole(value: string | null | undefined): ContactRole {
  const text = (value ?? "").trim().toLowerCase();
  return (CONTACT_ROLES as readonly string[]).includes(text) ? (text as ContactRole) : "other";
}

function decodeValue(raw: string | null): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const [headerRow, ...dataRows] = parseCsvRows(text);
  if (!headerRow) {
    return [];
  }
  const headers = headerRow.map((header) => header.trim().toLowerCase());
  return dataRows
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        if (header) {
          record[header] = cells[index] ?? "";
        }
      });
      return record;
    });
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
