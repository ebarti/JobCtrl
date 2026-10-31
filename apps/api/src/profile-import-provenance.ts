import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ProfileSchema, type ProfileUpdateRequest } from "@jobctrl/contracts";
import { isRecord } from "./config-file.js";
import type { SqliteDatabase } from "./db.js";
import type { ProfileImportResult } from "./local-actions.js";
import { readDetermination } from "./semantic-determinations.js";

const PERSONAL_FIELDS = ["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const attemptVersionSchema = z.object({
  version: z.literal(1),
  pdfSha256: z.string().regex(hash),
  inferredStyle: z.object({
    paper_size: z.enum(["a4paper", "letterpaper"]).optional(),
    document_font_size: z.enum(["10pt", "11pt", "12pt"]).optional(),
    font_family: z.enum(["sans", "roman"]).optional(),
  }).strict(),
  pages: z.number().int().positive(),
  warningsSha256: z.string().regex(hash),
}).strict();

function readImportAttempt(db: SqliteDatabase, id: string) {
  if (!uuid.test(id)) throw new Error("resume_import_attempt_unavailable");
  const rows = db.prepare("SELECT entity_version, determination_kind, determination_id FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id=?")
    .all("local", "resume_import_attempt", id) as Array<{ entity_version: string; determination_kind: string; determination_id: string }>;
  if (rows.length !== 1 || rows[0]!.determination_kind !== "resume_extraction" || rows[0]!.entity_version.length > 2048)
    throw new Error("resume_import_attempt_unavailable");
  const metadata = attemptVersionSchema.parse(JSON.parse(rows[0]!.entity_version));
  const extraction = readResumeExtraction(db, rows[0]!.determination_id);
  return { ...metadata, determinationId: rows[0]!.determination_id, extraction };
}

function warningsHash(warnings: string[]): string {
  const digest = createHash("sha256");
  for (const warning of warnings) {
    const bytes = Buffer.from(warning, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length).update(bytes);
  }
  return digest.digest("hex");
}

/** Bind the reviewable personal fields to the persisted, source-validated extraction.
 * The worker's draft may also contain values inherited from its Profile base.
 */
export function bindImportedDraft(
  db: SqliteDatabase,
  attemptId: string,
  pdfBytes: Buffer,
  filename: string,
  importProfile: boolean,
  importStyle: boolean,
  draft: ProfileImportResult,
): ProfileImportResult {
  const attempt = readImportAttempt(db, attemptId);
  const source = draft.source;
  if (!isRecord(source) || source.attemptId !== attemptId || source.determinationId !== attempt.determinationId
      || source.pdfSha256 !== attempt.pdfSha256 || createHash("sha256").update(pdfBytes).digest("hex") !== attempt.pdfSha256
      || !isDeepStrictEqual(source.inferredStyle, attempt.inferredStyle) || source.pages !== attempt.pages
      || !Array.isArray(source.warnings) || source.warnings.some((item) => typeof item !== "string")
      || warningsHash(source.warnings as string[]) !== attempt.warningsSha256)
    throw new Error("resume_import_attempt_unavailable");
  const receipt = attempt.extraction;
  const extracted = receipt.result.personal;
  if (!isRecord(extracted)) throw new Error("resume_extraction_receipt_unavailable");
  const personal: Record<string, string> = {};
  for (const field of PERSONAL_FIELDS) {
    const entry = extracted[field];
    if (entry === null) continue;
    if (!isRecord(entry) || typeof entry.value !== "string" || !entry.value)
      throw new Error("resume_extraction_receipt_unavailable");
    personal[field] = entry.value;
  }
  const value = (entry: unknown) => isRecord(entry) && typeof entry.value === "string" ? entry.value : "";
  const rows = (input: unknown) => {
    if (!Array.isArray(input) || input.some((row) => !isRecord(row))) throw new Error("invalid extraction");
    return input as Record<string, unknown>[];
  };
  const result = receipt.result;
  const profile = { personal, resume: {
    executive_profile: { baseline_text: value(result.executive_profile) },
    experience_entries: rows(result.experience).map((row, index) => ({
      id: `import:experience:${index}`, title: value(row.title), company: value(row.company),
      date_range: value(row.date_range), location: value(row.location), summary: value(row.summary),
      bullets: rows(row.bullets).map(value), achievement_evidence: [],
    })),
    education_entries: rows(result.education).map((row, index) => ({
      id: `import:education:${index}`, degree: value(row.degree), institution: value(row.institution),
      date: value(row.date), location: value(row.location),
    })),
    skill_categories: rows(result.skills).map((row, index) => ({
      id: `import:skills:${index}`, label: value(row.label), items: rows(row.items).map(value),
    })),
  } };
  const action = draft.action ? (({ result: _result, ...safe }) => safe)(draft.action) : undefined;
  return {
    ...(importProfile ? { profile } : {}),
    ...(importStyle ? { style: attempt.inferredStyle } : {}),
    source: { filename, bytes: pdfBytes.length, status: "pending_confirmation", pages: attempt.pages,
      warnings: source.warnings, attemptId, determinationId: attempt.determinationId,
      ...(importProfile ? { extractedPersonal: personal } : {}),
      ...(importStyle ? { inferredStyle: attempt.inferredStyle, styleReceiptId: attemptId } : {}) },
    ...(action ? { action } : {}),
  };
}

function readResumeExtraction(db: SqliteDatabase, id: string) {
  const receipt = readDetermination(db, "local", id, { currentOnly: true });
  if (!receipt || receipt.kind !== "resume_extraction" || receipt.entity_id !== "resume-import" || receipt.lane !== "profile")
    throw new Error("resume_extraction_receipt_unavailable");
  return receipt;
}

/** Reconstruct only the explicitly reviewed changes from the recorded receipt.
 * The caller performs this inside the same transaction as the Profile version fence.
 */
export function assertReviewedImportUpdate(
  db: SqliteDatabase,
  proof: NonNullable<ProfileUpdateRequest["importReview"]>,
  current: unknown,
  proposed: unknown,
): void {
  if (proof.draftId !== proof.attemptId) throw new Error("import draft identity mismatch");
  const attempt = readImportAttempt(db, proof.attemptId);
  if (attempt.determinationId !== proof.determinationId) throw new Error("import attempt determination mismatch");
  const receipt = attempt.extraction;
  const result = receipt.result;
  const sections = new Set(proof.sections);
  const expected = structuredClone(isRecord(current) ? current : {});
  const personal = isRecord(expected.personal) ? expected.personal : {};
  const sourcePersonal = isRecord(result.personal) ? result.personal : {};
  const personalKeys: Record<string, string> = {
    full_name: "full_name", email: "email", phone: "phone", city: "city", country: "country",
    linkedin_url: "linkedin", github_url: "github", website_url: "website",
  };
  if (!sections.has("personal") && proof.personalFields.length) throw new Error("unreviewed personal fields");
  for (const key of proof.personalFields) {
    const entry = sourcePersonal[personalKeys[key]!];
    if (!isRecord(entry) || typeof entry.value !== "string") throw new Error("personal field is not in extraction");
    personal[key] = entry.value;
  }
  if (sections.has("personal")) {
    if (!proof.personalFields.length) throw new Error("no personal fields reviewed");
    expected.personal = personal;
  }
  const resume = isRecord(expected.resume) ? expected.resume : {};
  const extractedValue = (entry: unknown) => isRecord(entry) && typeof entry.value === "string" ? entry.value : "";
  const extractedRows = (field: string) => {
    const rows = result[field];
    if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) throw new Error("invalid extracted rows");
    return rows as Record<string, unknown>[];
  };
  if (sections.has("summary")) {
    const summary = extractedValue(result.executive_profile);
    if (!summary) throw new Error("no extracted summary");
    resume.executive_profile = { ...(isRecord(resume.executive_profile) ? resume.executive_profile : {}), baseline_text: summary };
  }
  const append = (property: string, prefix: string, rows: Record<string, unknown>[]) => {
    const currentRows = Array.isArray(resume[property]) ? resume[property] : [];
    if (!rows.length) throw new Error("no extracted rows");
    const ids = new Set(currentRows.filter(isRecord).map((row) => row.id));
    const next = rows.map((row, index) => {
      const id = `import:${prefix}:${proof.draftId}:${index}`;
      if (ids.has(id)) throw new Error("import row already exists");
      if (prefix === "experience") return { id, title: extractedValue(row.title), company: extractedValue(row.company),
        date_range: extractedValue(row.date_range), location: extractedValue(row.location), summary: extractedValue(row.summary),
        bullets: Array.isArray(row.bullets) ? row.bullets.map(extractedValue) : [], achievement_evidence: [] };
      if (prefix === "education") return { id, degree: extractedValue(row.degree), institution: extractedValue(row.institution),
        date: extractedValue(row.date), location: extractedValue(row.location) };
      return { id, label: extractedValue(row.label), items: Array.isArray(row.items) ? row.items.map(extractedValue) : [] };
    });
    resume[property] = [...currentRows, ...next];
  };
  if (sections.has("experience")) append("experience_entries", "experience", extractedRows("experience"));
  if (sections.has("education")) append("education_entries", "education", extractedRows("education"));
  if (sections.has("skills")) append("skill_categories", "skills", extractedRows("skills"));
  if (sections.has("summary") || sections.has("experience") || sections.has("education") || sections.has("skills"))
    expected.resume = resume;
  const parsed = ProfileSchema.safeParse(expected);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, proposed)) throw new Error("review differs from persisted extraction");
}

/** Rejoin the worker-owned attempt inside the version-fenced Profile write. */
export function assertReviewedImportStyle(
  db: SqliteDatabase, id: string, proposed: unknown, proof?: NonNullable<ProfileUpdateRequest["importReview"]>,
): void {
  if (!proof || proof.attemptId !== id || proof.draftId !== id) throw new Error("import draft identity mismatch");
  const attempt = readImportAttempt(db, id);
  if (proof.determinationId !== attempt.determinationId
      || !isDeepStrictEqual(attempt.inferredStyle, proposed))
    throw new Error("resume_style_receipt_unavailable");
}
