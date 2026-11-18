import {
  RESUME_TEMPLATE_ASSIGNMENT_SOURCES,
  RESUME_TEMPLATE_STATUSES,
  ResumeTemplateLayoutSchema,
  ResumeTemplateThemeSchema,
  type ProfileConfigResponse,
  type ProfileImportRequest,
  type ProfileImportResponse,
  type ProfileUpdateRequest,
  type ResumeTemplateDefaultSelectionRequest,
  type ResumeTemplateDefaultSelectionResponse,
  type ResumeTemplateListResponse,
  type ResumeTemplateVersionSaveRequest,
  type ResumeTemplateVersionSaveResponse,
} from "@jobctrl/contracts";
import { z } from "zod";
import type { HttpPort } from "../../shared/ports/HttpPort.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";

const profileResponse = z.object({
  ok: z.literal(true),
  profileVersion: z.number().int().nonnegative().nullable(),
  profile: z.record(z.string(), z.unknown()),
  style: z.record(z.string(), z.unknown()),
  templateText: z.string(),
}).passthrough();

const importResponse = z.object({
  ok: z.literal(true),
  profile: z.unknown().optional(),
  style: z.unknown().optional(),
  source: z.unknown().optional(),
  templateText: z.string().optional(),
}).passthrough();

const templateVersion = z.object({
  templateId: z.string(), versionId: z.string(), versionNumber: z.number().int().positive(),
  displayName: z.string(), status: z.enum(RESUME_TEMPLATE_STATUSES), theme: ResumeTemplateThemeSchema,
  layout: ResumeTemplateLayoutSchema, contentHash: z.string(), createdAt: z.string(),
}).passthrough();
const template = z.object({
  templateId: z.string(), displayName: z.string(), status: z.enum(RESUME_TEMPLATE_STATUSES),
  builtIn: z.boolean(), activeVersion: templateVersion, createdAt: z.string(), updatedAt: z.string(),
}).passthrough();
const templateMetadata = z.object({
  templateId: z.string(), templateVersionId: z.string(), templateVersionNumber: z.number().int().positive(),
  templateName: z.string(), templateHash: z.string(), assignmentSource: z.enum(RESUME_TEMPLATE_ASSIGNMENT_SOURCES),
}).passthrough();
const templateList = z.object({
  ok: z.literal(true), templates: z.array(template), defaultTemplate: templateMetadata.nullable(),
  builtInDefault: templateMetadata, effectiveDefaultVersion: templateVersion,
  preferenceRevision: z.number().int().nonnegative(),
}).passthrough();
const templateSaved = z.object({ ok: z.literal(true), template }).passthrough();
const templateDefault = z.object({ ok: z.literal(true), defaultTemplate: templateMetadata }).passthrough();

export type TemplateList = ResumeTemplateListResponse & { preferenceRevision: number };
export type TemplateDefaultRequest = ResumeTemplateDefaultSelectionRequest & { expectedRevision: number };

function parseWrite<T>(method: string, path: string, parse: () => T): T {
  try { return parse(); }
  catch (error) { throw createUnconfirmedWriteError(method, path, error); }
}

export async function readProfile(http: HttpPort, expectedDatabaseInstanceId?: string): Promise<ProfileConfigResponse> {
  return profileResponse.parse(await http.json<unknown>("GET", "/v1/profile", expectedDatabaseInstanceId ? { expectedDatabaseInstanceId } : {})) as ProfileConfigResponse;
}

export async function updateProfile(http: HttpPort, body: ProfileUpdateRequest, expectedDatabaseInstanceId?: string): Promise<ProfileConfigResponse> {
  const path = "/v1/profile";
  const value = await http.json<unknown>("PATCH", path, { body, ...(expectedDatabaseInstanceId ? { expectedDatabaseInstanceId } : {}) });
  return parseWrite("PATCH", path, () => profileResponse.parse(value) as ProfileConfigResponse);
}

export async function importResume(http: HttpPort, body: ProfileImportRequest): Promise<ProfileImportResponse> {
  const path = "/v1/profile/import-resume";
  const value = await http.json<unknown>("POST", path, { body });
  return parseWrite("POST", path, () => importResponse.parse(value) as ProfileImportResponse);
}

export async function readResumeTemplates(http: HttpPort): Promise<TemplateList> {
  return templateList.parse(await http.json<unknown>("GET", "/v1/resume-templates"));
}

export async function saveResumeTemplate(http: HttpPort, body: ResumeTemplateVersionSaveRequest): Promise<ResumeTemplateVersionSaveResponse> {
  const path = "/v1/resume-templates";
  const value = await http.json<unknown>("POST", path, { body });
  return parseWrite("POST", path, () => templateSaved.parse(value));
}

export async function setDefaultResumeTemplate(http: HttpPort, body: TemplateDefaultRequest): Promise<ResumeTemplateDefaultSelectionResponse> {
  const path = "/v1/resume-templates/default";
  const value = await http.json<unknown>("PATCH", path, { body });
  return parseWrite("PATCH", path, () => templateDefault.parse(value));
}

export function profileHtmlPreviewPath(cacheKey: number): string {
  return `/v1/profile/preview.html?v=${encodeURIComponent(String(cacheKey))}`;
}
