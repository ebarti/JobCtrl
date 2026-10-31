import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ProfileImportInput } from "../src/local-actions.js";
import { recordModelDecision } from "./semantic-fixtures.js";

/** Explicit synthetic resume extraction for import-receipt boundary tests. */
export function recordResumeExtraction(
  db: Database.Database,
  fields: Partial<Record<"full_name" | "email" | "phone" | "linkedin" | "github" | "website" | "city" | "country", string>>,
  options: {
    tenantId?: string;
    entityId?: string;
    experience?: Array<{ title: string; company: string; bullets: string[] }>;
  } = {},
): string {
  const field = (value: string) => ({ value, citations: [{ source_id: "resume", quote: value, exact_values: [] }] });
  const personal = Object.fromEntries(
    ["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"].map((key) => {
      const value = fields[key as keyof typeof fields];
      return [key, value ? field(value) : null];
    }),
  );
  return recordModelDecision(db, "resume_extraction", options.entityId ?? "resume-import", {
    personal, executive_profile: null,
    experience: (options.experience ?? []).map((row) => ({
      title: field(row.title), company: field(row.company), bullets: row.bullets.map(field),
      date_range: null, location: null, summary: null,
    })),
    education: [], skills: [],
  }, options.tenantId ?? "local");
}

/** Synthetic worker-owned source binding for API boundary tests. */
export function recordImportAttempt(
  db: Database.Database, input: Pick<ProfileImportInput, "attemptId" | "pdfBytes">,
  determinationId: string, inferredStyle: Record<string, string> = {}, tenantId = "local",
) {
  const source = { attemptId: input.attemptId, determinationId,
    pdfSha256: createHash("sha256").update(input.pdfBytes).digest("hex"),
    inferredStyle, pages: 1, warnings: [] as string[] };
  const version = JSON.stringify({ version: 1, pdfSha256: source.pdfSha256, inferredStyle,
    pages: 1, warningsSha256: createHash("sha256").digest("hex") });
  db.prepare("INSERT INTO semantic_entity_bindings VALUES (?, ?, ?, ?, ?, ?)").run(
    tenantId, "resume_import_attempt", input.attemptId, version, "resume_extraction", determinationId,
  );
  return source;
}
