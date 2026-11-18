import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

const bullet = z.object({ id: z.string(), text: z.string() }).passthrough();
const role = z.object({ id: z.string(), title: z.string(), company: z.string(), location: z.string(), date_range: z.string(), summary: z.string(), bullets: z.array(bullet) }).passthrough();
const education = z.object({ id: z.string(), degree: z.string(), institution: z.string(), location: z.string(), date: z.string(), details: z.string() }).passthrough();
const language = z.object({ id: z.string(), language: z.string(), proficiency: z.string() }).passthrough();
const documentSchema = z.object({ personal: z.object({ full_name: z.string(), address: z.string(), contact_items: z.array(z.unknown()) }).passthrough(),
  summary: z.string(), experience: z.array(role), education: z.array(education), skills: z.array(z.unknown()), languages: z.array(language).optional() }).passthrough();
const review = z.object({ status: z.enum(["pending", "running", "pass", "findings", "timeout", "failed", "not_applicable"]),
  findings: z.array(z.object({ detail: z.string() }).passthrough()), failure_code: z.string().nullable().optional() }).passthrough();
const revision = z.object({
  revision_id: z.string(), number: z.number(), profile_revision: z.number(), mode: z.enum(["tailored", "baseline_copy"]),
  document: documentSchema, selected_variants: z.array(z.object({ achievement_id: z.string(), variant_id: z.string(), revision: z.number(), text: z.string() }).passthrough()),
  coverage_manifest: z.object({ status: z.string().optional(), requirements: z.array(z.unknown()).optional() }).passthrough(),
  mechanical: z.object({ status: z.enum(["valid", "invalid"]), failures: z.array(z.string()) }).passthrough(), review,
  renders: z.array(z.object({ layout_conflicts: z.array(z.unknown()).optional() }).passthrough()),
  render_attempts: z.array(z.object({ status: z.string(), failure_code: z.string().optional() }).passthrough()),
  edit_draft: z.object({ plate_document: z.array(z.unknown()).nullable().optional() }).passthrough().nullable(),
}).passthrough();
const locale = z.object({ locale_id: z.string(), source_locale: z.string(), target_locale: z.string(), status: z.string(),
  review: z.object({ status: z.string(), findings: z.array(z.object({ detail: z.string() }).passthrough()), failure_code: z.string().optional() }).passthrough(),
  findings: z.array(z.object({ detail: z.string() }).passthrough()), failure_code: z.string().optional(),
  document: documentSchema.nullable(),
}).passthrough();
const resume = z.object({ resume_id: z.string(), job_id: z.string(), version: z.number(), current_revision: z.string(),
  composition_freshness: z.object({ current: z.boolean(), stale_reasons: z.array(z.string()), revision_id: z.string() }).optional(),
  accepted_revision_id: z.string().nullable(), revisions: z.array(revision),
  acceptances: z.array(z.object({ revision_id: z.string(), review_status: z.string(), review_override: z.boolean() }).passthrough()),
  locales: z.array(locale),
}).passthrough();
const wrapper = z.object({ ok: z.literal(true), resume });
const list = z.object({ ok: z.literal(true), resumes: z.array(resume) });
export type ResumeDocument = z.infer<typeof documentSchema>;
export type Resume = z.infer<typeof resume>;
export type ResumeRevision = z.infer<typeof revision>;
export const resumeKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "resumes"] as const,
  list: (tenantId: string, jobId: string) => [...resumeKeys.all(tenantId), "job", jobId] as const,
  html: (tenantId: string, resumeId: string, revisionId: string) => [...resumeKeys.all(tenantId), "html", resumeId, revisionId] as const,
};
function parseResume(value: unknown): Resume {
  const result = wrapper.safeParse(value);
  if (!result.success) throw new Error("The resume response is invalid. Refresh to verify the saved state.");
  return result.data.resume;
}
function parseList(value: unknown): Resume[] {
  const result = list.safeParse(value);
  if (!result.success) throw new Error("The saved resumes response is invalid.");
  return result.data.resumes;
}
async function writeResume(http: ReturnType<typeof usePorts>["http"], path: string, body: unknown): Promise<Resume> {
  const value = await http.json<unknown>("POST", path, { body });
  try { return parseResume(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}
export function useResumes(jobId: string) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: resumeKeys.list(tenantId, jobId),
    queryFn: async () => parseList(await http.json<unknown>("GET", "/v1/resumes", { query: { jobId } })),
    structuralSharing: (previous: unknown, incoming: unknown) => {
      const current = previous as Resume[] | undefined;
      const next = incoming as Resume[];
      if (!current) return next;
      const known = new Map(current.map((item) => [item.resume_id, item]));
      // A read started before a write may arrive after its newer response.
      // Keep incoming membership, but never regress a still-present resume.
      return next.map((item) => {
        const saved = known.get(item.resume_id);
        return saved && saved.version > item.version ? saved : item;
      });
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
export function useResumeHtml(saved: Resume | null) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: resumeKeys.html(tenantId, saved?.resume_id ?? "", saved?.current_revision ?? ""), enabled: Boolean(saved),
    queryFn: async () => {
      if (!saved) throw new Error("No resume selected.");
      const html = await http.text("GET", `/v1/resumes/${encodeURIComponent(saved.resume_id)}/export`, { query: { format: "html", revision_id: saved.current_revision } });
      const after = parseResume(await http.json<unknown>("GET", `/v1/resumes/${encodeURIComponent(saved.resume_id)}`));
      if (after.current_revision !== saved.current_revision) throw new Error("The resume changed while loading. Reload the current revision before editing.");
      return html;
    }, meta: { suppressGlobalErrorToast: true },
  });
}
export function useResumeActions(jobId: string) {
  const tenantId = useTenantId(); const { http, blobDownload } = usePorts(); const client = useQueryClient();
  const save = (result: Resume) => {
    client.setQueryData<Resume[]>(resumeKeys.list(tenantId, jobId), (previous = []) => {
      const current = previous.find((item) => item.resume_id === result.resume_id);
      return current && current.version > result.version ? previous : [...previous.filter((item) => item.resume_id !== result.resume_id), result];
    });
  };
  const compose = useMutation({ mutationFn: async (body: { job_id: string; profile_id: string; expected_profile_revision: number; mode: "tailored" | "baseline_copy" }) =>
    writeResume(http, "/v1/resumes", body), onSuccess: save });
  const action = useMutation({ mutationFn: async (input: { resumeId: string; action: string; body: Record<string, unknown> }) =>
    writeResume(http, `/v1/resumes/${encodeURIComponent(input.resumeId)}/${input.action}`, input.body), onSuccess: save });
  const exportFile = useMutation({ mutationFn: async ({ resumeId, format, localeId, revisionId }: { resumeId: string; format: "pdf" | "docx"; localeId?: string; revisionId?: string }) => {
    if (!localeId && !revisionId) throw new Error("Choose an accepted resume revision before exporting.");
    const path = localeId ? `/v1/resumes/${encodeURIComponent(resumeId)}/locales/${encodeURIComponent(localeId)}/export`
      : `/v1/resumes/${encodeURIComponent(resumeId)}/export`;
    const blob = await http.blob("GET", path, { query: localeId ? { format } : { format, accepted: true, revision_id: revisionId } });
    blobDownload.save(blob, `${localeId ? "resume-locale" : "resume"}.${format}`);
  } });
  return { compose, action, exportFile };
}
