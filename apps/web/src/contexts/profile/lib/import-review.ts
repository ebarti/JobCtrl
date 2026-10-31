import { ProfileSchema, type ProfileConfigResponse, type ProfileUpdateRequest } from "@jobctrl/contracts";

import { isJsonRecord, sameJson, type JsonRecord } from "./json-record.js";
import type { ProfileImportReviewDraft } from "../stores/profile-import-review-store.js";

export type ImportSection =
  "personal" | "summary" | "experience" | "education" | "skills" | "style";
export const LEGACY_REVIEW_PREFIX = "__jobctrl_preserved_legacy_review_v1";
export interface ImportSectionReview {
  id: ImportSection;
  label: string;
  lines: string[];
}

const personalLabels: Readonly<Record<string, string>> = {
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  linkedin: "LinkedIn",
  github: "GitHub",
  website: "Website",
  city: "City",
  country: "Country",
};
const personalTargets: Readonly<Record<string, string>> = {
  linkedin: "linkedin_url",
  github: "github_url",
  website: "website_url",
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): JsonRecord =>
  isJsonRecord(value) ? value : {};
const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isJsonRecord) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const attemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function importAttemptId(result: ReviewInput["result"]): string | null {
  const id = record(result.source).attemptId;
  return typeof id === "string" && attemptIdPattern.test(id) ? id : null;
}

type ReviewInput = Omit<ProfileImportReviewDraft, "id" | "revision" | "attempt">;

/** A new API response carries the exact personal values from its persisted extraction receipt. */
function extractedPersonal(result: ReviewInput["result"]): JsonRecord | null {
  const source = record(result.source);
  if (!importAttemptId(result) || typeof source.determinationId !== "string" || !/^[a-f0-9]{64}$/.test(source.determinationId)
      || !isJsonRecord(source.extractedPersonal)) return null;
  const values = source.extractedPersonal;
  if (Object.entries(values).some(([key, value]) =>
    !Object.hasOwn(personalLabels, key) || typeof value !== "string" || !value)) return null;
  return values;
}

export function hasVerifiedPersonalSource(result: ReviewInput["result"]): boolean {
  const source = extractedPersonal(result);
  return source !== null && sameJson(record(record(result.profile).personal), source);
}

const inferredStyleKeys = ["paper_size", "document_font_size", "font_family"] as const;

function inferredStyle(result: ReviewInput["result"]): JsonRecord | null {
  const source = record(result.source);
  if (!importAttemptId(result) || typeof source.determinationId !== "string" || !/^[a-f0-9]{64}$/.test(source.determinationId)
      || source.styleReceiptId !== importAttemptId(result)
      || !isJsonRecord(source.inferredStyle)) return null;
  if (Object.entries(source.inferredStyle).some(([key, value]) =>
    !inferredStyleKeys.includes(key as typeof inferredStyleKeys[number]) || typeof value !== "string" || !value)) return null;
  return source.inferredStyle;
}

export function hasVerifiedStyleSource(result: ReviewInput["result"]): boolean {
  const source = inferredStyle(result);
  return source !== null && sameJson(record(result.style), source);
}

export function hasUnverifiedStyle(draft: Pick<ProfileImportReviewDraft, "id" | "importStyle" | "result">): boolean {
  return draft.importStyle && Object.keys(record(draft.result.style)).length > 0
    && (!hasVerifiedStyleSource(draft.result) || draft.id !== importAttemptId(draft.result));
}

/** Older saved drafts may contain inherited values and cannot prove their source. */
export function hasUnverifiedPersonal(draft: Pick<ProfileImportReviewDraft, "importProfile" | "result">): boolean {
  if (!draft.importProfile) return false;
  const personal = record(record(draft.result.profile).personal);
  const present = Object.entries(personal).filter(([key, value]) =>
    Object.hasOwn(personalLabels, key) && typeof value === "string" && value.length > 0);
  if (!present.length) return false;
  const source = extractedPersonal(draft.result);
  return source === null || present.some(([key, value]) => source[key] !== value);
}

/** Earlier drafts have no worker-bound attempt and stay recoverable as data. */
export function hasUnverifiedProfile(draft: Pick<ProfileImportReviewDraft, "id" | "importProfile" | "result">): boolean {
  return draft.importProfile && Object.keys(record(draft.result.profile)).length > 0 && draft.id !== importAttemptId(draft.result);
}

function pickedStrings(value: unknown, keys: readonly string[]): JsonRecord {
  const input = record(value);
  return Object.fromEntries(keys.flatMap((key) =>
    typeof input[key] === "string" ? [[key, input[key]]] : [],
  ));
}

/** Retain only saved values needed to compare the shown personal fields. */
export function projectImportReviewBase(
  base: ProfileImportReviewDraft["base"],
  result: ReviewInput["result"],
): ProfileImportReviewDraft["base"] {
  const saved = record(record(base.profile).personal);
  const incoming = record(record(result.profile).personal);
  const personal: JsonRecord = {};
  for (const key of Object.keys(personalLabels)) {
    if (text(incoming[key])) {
      const target = personalTargets[key] ?? key;
      personal[target] = text(saved[target]);
    }
  }
  return { profileVersion: base.profileVersion, profile: { personal } };
}

/** Persist the reviewable values and receipt IDs, never the whole API response. */
export function projectImportReview(input: ReviewInput): ReviewInput {
  const profile = record(input.result.profile);
  const incoming = record(profile.personal);
  const saved = record(record(input.base.profile).personal);
  const personal: JsonRecord = {};
  const sourcePersonal = extractedPersonal(input.result);
  const sourceStyle = inferredStyle(input.result);
  if (input.importProfile) {
    for (const key of Object.keys(personalLabels)) {
      const value = text(incoming[key]);
      if (value && (sourcePersonal === null || sourcePersonal[key] === value)
          && value !== text(saved[personalTargets[key] ?? key])) personal[key] = value;
    }
  }
  const resume = record(profile.resume);
  const result: ReviewInput["result"] = {};
  if (input.importProfile) {
    result.profile = {
      personal,
      resume: {
        executive_profile: pickedStrings(resume.executive_profile, ["baseline_text"]),
        experience_entries: records(resume.experience_entries).map((item) => ({
          ...pickedStrings(item, ["title", "company", "date_range", "location", "summary"]),
          bullets: strings(item.bullets),
        })),
        education_entries: records(resume.education_entries).map((item) =>
          pickedStrings(item, ["degree", "institution", "date", "location"])),
        skill_categories: records(resume.skill_categories).map((item) => ({
          ...pickedStrings(item, ["label"]), items: strings(item.items),
        })),
      },
    };
  }
  if (input.importStyle) {
    const style = record(input.result.style);
    const keys = sourceStyle === null
      ? ["document_font_size", "paper_size", "font_family", "moderncv_style", "moderncv_color", "page_scale", "hints_column_width_cm", "body_alignment"]
      : [...inferredStyleKeys];
    result.style = Object.fromEntries(keys.flatMap((key) =>
      (typeof style[key] === "string" || typeof style[key] === "number") && (sourceStyle === null || sourceStyle[key] === style[key])
        ? [[key, style[key]]] : [],
    ));
  }
  const source = record(input.result.source);
  const provenance: JsonRecord = {};
  if (importAttemptId(input.result)) provenance.attemptId = source.attemptId;
  for (const key of ["determinationId", "candidateDeterminationId"]) {
    if (typeof source[key] === "string" && /^[a-f0-9]{64}$/.test(source[key])) provenance[key] = source[key];
  }
  if (sourcePersonal !== null) provenance.extractedPersonal = personal;
  if (sourceStyle !== null && input.importStyle) {
    provenance.styleReceiptId = source.styleReceiptId;
    provenance.inferredStyle = result.style;
  }
  if (Array.isArray(source.warnings)) provenance.warnings = strings(source.warnings);
  if (Object.keys(provenance).length) result.source = provenance;
  return {
    tenantId: input.tenantId,
    filename: input.filename,
    importProfile: input.importProfile,
    importStyle: input.importStyle,
    result,
    base: projectImportReviewBase(input.base, result),
  };
}

export function requiresLegacyRereview(draft: ProfileImportReviewDraft): boolean {
  return draft.projectionVersion === 1 && Object.keys(draft).some((name) => name.startsWith(LEGACY_REVIEW_PREFIX));
}

export function hasProjectedResult(draft: ProfileImportReviewDraft): boolean {
  // An empty base retains a proposal even when an intermediate profile matches it.
  const neutral = { ...draft, base: { profileVersion: draft.base.profileVersion, profile: {} } };
  return sameJson(draft.result, projectImportReview(neutral).result);
}

/** v1 and v2 results must match their persisted projection contract. */
export function hasProjectedReviewAuthority(draft: ProfileImportReviewDraft): boolean {
  if (draft.projectionVersion !== 1 && draft.projectionVersion !== 2) return false;
  if (!hasProjectedResult(draft)) return false;
  return draft.projectionVersion !== 1 || sameJson(draft.base, projectImportReviewBase(draft.base, draft.result));
}

export function assertImportAcceptanceAuthority(draft: ProfileImportReviewDraft, selected: ReadonlySet<ImportSection>): void {
  if (selected.size > 0 && draft.id !== importAttemptId(draft.result))
    throw new Error("The review data could not be verified against its source attempt. Preserve the draft and import the PDF again.");
  if (selected.has("style") && hasUnverifiedStyle(draft))
    throw new Error("The review data could not be verified. Preserve this older style draft and import the PDF again.");
  if (selected.has("personal") && hasUnverifiedPersonal(draft))
    throw new Error("These older personal fields cannot be verified against their extraction. Preserve the draft and import the PDF again.");
  if (requiresLegacyRereview(draft))
    throw new Error("The review data could not be verified. Load the latest profile and review it again.");
  if (draft.projectionVersion !== undefined && !hasProjectedReviewAuthority(draft))
    throw new Error("The review data could not be verified. Your draft remains available for recovery.");
  // Older unprojected records may contain additional source data, but only
  // the supported style fields may be sent in a selected style update.
  if (selected.has("style") && draft.importStyle && !sameJson(draft.result.style, projectImportReview(draft).result.style))
    throw new Error("The review data could not be verified. Your draft remains available for recovery.");
}

function personalChanges(
  draft: ProfileImportReviewDraft,
): Array<[string, string, string]> {
  if (!draft.importProfile) return [];
  const incoming = record(record(draft.result.profile).personal);
  const saved = record(record(draft.base.profile).personal);
  return Object.entries(personalLabels).flatMap(([key, label]) => {
    const value = text(incoming[key]);
    const target = personalTargets[key] ?? key;
    return value && value !== text(saved[target])
      ? [[target, label, value]]
      : [];
  });
}

function extracted(draft: ProfileImportReviewDraft) {
  const resume = draft.importProfile
    ? record(record(draft.result.profile).resume)
    : {};
  return {
    summary: text(record(resume.executive_profile).baseline_text),
    experience: records(resume.experience_entries),
    education: records(resume.education_entries),
    skills: records(resume.skill_categories),
  };
}

/** Only these displayed sections can be accepted; extracted evidence is never promoted. */
export function importReviewSections(
  draft: ProfileImportReviewDraft,
): ImportSectionReview[] {
  const { summary, experience, education, skills } = extracted(draft);
  const sections: ImportSectionReview[] = [];
  const personal = personalChanges(draft);
  if (personal.length)
    sections.push({
      id: "personal",
      label: "Personal details",
      lines: personal.map(([, label, value]) => `${label}: ${value}`),
    });
  if (summary)
    sections.push({ id: "summary", label: "Resume summary", lines: [summary] });
  if (experience.length)
    sections.push({
      id: "experience",
      label: "Experience",
      lines: experience.flatMap((item) =>
        [
          [
            text(item.title),
            text(item.company),
            text(item.date_range),
            text(item.location),
          ]
            .filter(Boolean)
            .join(" — "),
          text(item.summary),
          ...strings(item.bullets),
        ].filter(Boolean),
      ),
    });
  if (education.length)
    sections.push({
      id: "education",
      label: "Education",
      lines: education.map((item) =>
        [
          text(item.degree),
          text(item.institution),
          text(item.date),
          text(item.location),
        ]
          .filter(Boolean)
          .join(" — "),
      ),
    });
  if (skills.length)
    sections.push({
      id: "skills",
      label: "Skills",
      lines: skills.map((item) =>
        [text(item.label), strings(item.items).join(", ")]
          .filter(Boolean)
          .join(": "),
      ),
    });
  if (draft.importStyle && isJsonRecord(draft.result.style) && Object.keys(draft.result.style).length > 0)
    sections.push({
      id: "style",
      label: "Resume style",
      lines: Object.entries(draft.result.style).map(
        ([key, value]) =>
          `${key.replaceAll("_", " ")}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      ),
    });
  return sections;
}

/** Refuse partial reads; ProfileSchema defaults must not hide missing saved data. */
export function verifyCanonicalProfile(canonical: ProfileConfigResponse): void {
  if (canonical.profileVersion === null) {
    if (!isJsonRecord(canonical.profile) || Object.keys(canonical.profile).length !== 0)
      throw new Error("The saved profile could not be verified. Your draft is unchanged.");
  } else {
    if (!Number.isSafeInteger(canonical.profileVersion) || canonical.profileVersion <= 0)
      throw new Error("The saved profile version could not be verified. Your draft is unchanged.");
    const complete = ProfileSchema.safeParse(canonical.profile);
    if (!complete.success || !sameJson(canonical.profile, complete.data))
      throw new Error("The saved profile is incomplete or could not be verified. Your draft is unchanged.");
  }
}

/** Build a version-fenced patch from the reviewed base, retaining accepted rows. */
export function buildImportAcceptance(
  draft: ProfileImportReviewDraft,
  selected: ReadonlySet<ImportSection>,
  canonical: ProfileConfigResponse,
): ProfileUpdateRequest {
  assertImportAcceptanceAuthority(draft, selected);
  if (canonical.profileVersion !== draft.base.profileVersion)
    throw new Error("The saved profile changed. Load the latest profile and review the draft again.");
  verifyCanonicalProfile(canonical);
  const reviewed = { ...draft, base: canonical };
  const displayed = importReviewSections(draft);
  const current = importReviewSections(reviewed);
  if (!selected.size || [...selected].some((id) => !displayed.some((section) => section.id === id)))
    throw new Error("Choose at least one available section to save.");
  if ([...selected].some((id) => !sameJson(
    displayed.find((section) => section.id === id),
    current.find((section) => section.id === id),
  ))) {
    throw new Error("The review fields changed against the saved profile. Load the latest profile and review your selections again.");
  }
  const profileSelected = [...selected].some((section) => section !== "style");
  const request: ProfileUpdateRequest = {
    expectedProfileVersion: canonical.profileVersion,
  };
  if (!profileSelected && canonical.profileVersion === null) {
    throw new Error(
      "Create a profile before saving resume style. Your import draft will remain available for review.",
    );
  }
  const source = record(draft.result.source);
  if (typeof source.determinationId !== "string" || !/^[a-f0-9]{64}$/.test(source.determinationId))
    throw new Error("The extraction receipt is unavailable. Preserve the draft and import the PDF again.");
  request.importReview = {
    attemptId: importAttemptId(draft.result)!,
    determinationId: source.determinationId,
    draftId: draft.id,
    sections: [...selected],
    personalFields: selected.has("personal")
      ? personalChanges(reviewed).map(([key]) => key as "full_name" | "email" | "phone" | "linkedin_url" | "github_url" | "website_url" | "city" | "country")
      : [],
  };
  if (profileSelected) {
    const profile = structuredClone(record(canonical.profile));
    const personal = record(profile.personal);
    if (selected.has("personal")) {
      for (const [key, , value] of personalChanges(reviewed))
        personal[key] = value;
      profile.personal = personal;
    }
    const resume = record(profile.resume);
    const incoming = extracted(draft);
    if (selected.has("summary"))
      resume.executive_profile = {
        ...record(resume.executive_profile),
        baseline_text: incoming.summary,
      };
    const append = (
      property: string,
      prefix: string,
      items: JsonRecord[],
      project: (item: JsonRecord) => JsonRecord,
    ) => {
      const existing = records(resume[property]);
      const ids = new Set(existing.map((item) => text(item.id)));
      const imported = items.map((item, index) => {
        const id = `import:${prefix}:${draft.id}:${index}`;
        if (ids.has(id)) throw new Error("An entry from this draft already exists. Review the saved profile before continuing.");
        return { id, ...project(item) };
      });
      resume[property] = [
        ...existing,
        ...imported,
      ];
    };
    if (selected.has("experience"))
      append(
        "experience_entries",
        "experience",
        incoming.experience,
        (item) => ({
          title: text(item.title),
          company: text(item.company),
          date_range: text(item.date_range),
          location: text(item.location),
          summary: text(item.summary),
          bullets: strings(item.bullets),
          achievement_evidence: [],
        }),
      );
    if (selected.has("education"))
      append("education_entries", "education", incoming.education, (item) => ({
        degree: text(item.degree),
        institution: text(item.institution),
        date: text(item.date),
        location: text(item.location),
      }));
    if (selected.has("skills"))
      append("skill_categories", "skills", incoming.skills, (item) => ({
        label: text(item.label),
        items: strings(item.items),
      }));
    profile.resume = resume;
    const result = ProfileSchema.safeParse(profile);
    if (!result.success)
      throw new Error(
        `The selected profile sections need review: ${result.error.issues[0]?.message ?? "invalid profile"}`,
      );
    request.profile = profile;
  }
  if (selected.has("style")) {
    const source = record(draft.result.source);
    if (typeof source.styleReceiptId !== "string" || !hasVerifiedStyleSource(draft.result))
      throw new Error("The PDF style receipt is unavailable. Preserve the draft and import the PDF again.");
    request.style = draft.result.style;
    request.importStyleReceiptId = source.styleReceiptId;
  }
  return request;
}
