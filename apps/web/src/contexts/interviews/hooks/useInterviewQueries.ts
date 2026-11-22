import {
  InterviewCatalogResponseSchema,
  InterviewNotesResponseSchema,
  InterviewPrepHistoryResponseSchema,
  InterviewPrepSchema,
  InterviewQuestionResponseSchema,
} from "@jobctrl/contracts";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { interviewKeys } from "../queryKeys.js";

const ProfileSourcesSchema = z.object({
  ok: z.literal(true),
  profileVersion: z.number().int().positive().nullable(),
  sources: z.array(z.object({
    source_id: z.string().min(1),
    revision: z.number().int().positive(),
    text: z.string(),
    kind: z.string(),
    confirmation: z.string(),
    record: z.object({ evidence_strength: z.string().nullish(), source_text: z.string().nullish() }).passthrough().optional(),
  }).passthrough()),
}).passthrough();

// Selection uses the Profile owner's exact source IDs and revision. User
// activity and unconfirmed or changed evidence never become supported facts.
export function useInterviewEvidenceChoices(_jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const query = useQuery({
    queryKey: interviewKeys.evidence(tenantId),
    queryFn: async () => ProfileSourcesSchema.parse(await http.json<unknown>("GET", "/v1/profile/sources")),
    meta: { suppressGlobalErrorToast: true },
  });
  const sources = query.data?.sources ?? [];
  const counts = new Map<string, number>();
  for (const source of sources) counts.set(source.source_id, (counts.get(source.source_id) ?? 0) + 1);
  const choices = sources.filter((source) => source.kind === "evidence" && source.confirmation === "confirmed"
      && (source.record?.evidence_strength === "supported" || source.record?.evidence_strength === "verified")
      && source.source_id.length <= 200 && Boolean(source.text.trim()) && counts.get(source.source_id) === 1)
    .map((source) => ({ evidenceId: source.source_id, title: "Achievement evidence", excerpt: source.record?.source_text ?? source.text }));
  return { choices, profileVersion: query.data?.profileVersion ?? null,
    isPending: query.isPending || query.isFetching, error: query.error,
    refetch: async () => { await query.refetch(); } };
}

export function useInterviewCatalogQuery() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: interviewKeys.catalog(tenantId),
    queryFn: async () => InterviewCatalogResponseSchema.parse(await http.json<unknown>("GET", "/v1/interviews/catalog", { query: { page: 1, pageSize: 121 } })),
    staleTime: Infinity, meta: { suppressGlobalErrorToast: true } });
}

export function useInterviewQuestionQuery(questionId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: interviewKeys.question(tenantId, questionId),
    queryFn: async () => InterviewQuestionResponseSchema.parse(await http.json<unknown>("GET", `/v1/interviews/questions/${encodeURIComponent(questionId)}`)),
    enabled: Boolean(questionId), staleTime: Infinity, meta: { suppressGlobalErrorToast: true } });
}

export function useInterviewPrepHistoryQuery(jobId: string, page = 1) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: [...interviewKeys.history(tenantId, jobId), { page }],
    queryFn: async () => InterviewPrepHistoryResponseSchema.parse(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/interview-prep/history`, { query: { page, pageSize: 20 } })),
    enabled: Boolean(jobId), meta: { suppressGlobalErrorToast: true } });
}

const AcceptedPrepSchema = z.object({ ok: z.literal(true), jobId: z.string(), prep: InterviewPrepSchema.nullable() }).strict();
export function useAcceptedInterviewPrepQuery(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: interviewKeys.accepted(tenantId, jobId),
    queryFn: async () => AcceptedPrepSchema.parse(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/interview-prep`)),
    enabled: Boolean(jobId), meta: { suppressGlobalErrorToast: true } });
}

export function useInterviewNotesQuery(jobId: string, questionId: string, history = false, page = 1) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: history ? [...interviewKeys.note(tenantId, jobId, questionId), "history", { page }] : interviewKeys.note(tenantId, jobId, questionId),
    queryFn: async () => InterviewNotesResponseSchema.parse(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/interview-notes`, { query: { questionId, history, page, pageSize: 20 } })),
    enabled: Boolean(jobId && questionId), meta: { suppressGlobalErrorToast: true } });
}
