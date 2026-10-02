import { useQuery } from "@tanstack/react-query";
import { ProfileSchema } from "../types.js";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { interviewKeys } from "../interviewKeys.js";
import { profileKeys } from "../queryKeys.js";
import { useEvidenceMapQuery } from "./useEvidenceMapQuery.js";

// Reuse the canonical Profile and Evidence Map caches. Only confirmed saved
// achievement facts are selectable; declared skills and user notes are not.
export function useInterviewEvidenceChoices(jobId: string) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const profile = useQuery({ queryKey: profileKeys.profile(tenantId), queryFn: () => api.profile() });
  const evidence = useEvidenceMapQuery();
  const entries = evidence.data?.entries ?? [];
  const occurrences = new Map<string, number>();
  for (const entry of entries) if (entry.evidenceId) occurrences.set(entry.evidenceId, (occurrences.get(entry.evidenceId) ?? 0) + 1);
  const parsedProfile = ProfileSchema.safeParse(profile.data?.profile);
  const profileIds = new Map<string, number>();
  if (parsedProfile.success) for (const role of parsedProfile.data.resume.experience_entries) for (const fact of role.achievement_evidence) if (fact.id) profileIds.set(fact.id, (profileIds.get(fact.id) ?? 0) + 1);
  const choices = entries.filter((entry) => entry.kind === "achievement_evidence" && entry.evidenceId && entry.entryId === entry.evidenceId && occurrences.get(entry.evidenceId) === 1 && (profileIds.get(entry.evidenceId) ?? 0) <= 1 && entry.freshness.userConfirmed && ["supported", "verified"].includes(entry.freshness.evidenceStrength ?? "") && entry.story && [entry.story.scope, entry.story.action, entry.story.outcome].some((text) => text.trim())).map((entry) => ({
    evidenceId: entry.evidenceId!, title: entry.title,
    excerpt: [entry.story!.scope, entry.story!.action, entry.story!.outcome, ...entry.story!.metrics].filter(Boolean).join(" · "),
    scope: entry.requirementUsages.some((usage) => usage.jobKey === jobId && usage.requirementFitKind === "matched") ? "direct" : "transferable",
    strength: entry.freshness.evidenceStrength,
  }));
  return { choices, profileVersion: profile.data?.profileVersion ?? null, isPending: profile.isPending || evidence.isPending, error: profile.error ?? evidence.error, refetch: async () => { await Promise.all([profile.refetch(), evidence.refetch()]); } };
}

export function useInterviewCatalogQuery() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: interviewKeys.catalog(tenantId),
    queryFn: () => api.interviewCatalog({ page: 1, pageSize: 121 }),
    staleTime: Infinity,
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useInterviewQuestionQuery(questionId: string) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: interviewKeys.question(tenantId, questionId),
    queryFn: () => api.interviewQuestion(questionId),
    enabled: Boolean(questionId),
    staleTime: Infinity,
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useInterviewPrepHistoryQuery(jobId: string, page = 1) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: [...interviewKeys.history(tenantId, jobId), { page }],
    queryFn: () => api.interviewPrepHistory(jobId, { page, pageSize: 20 }),
    enabled: Boolean(jobId),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useInterviewNotesQuery(jobId: string, questionId: string, history = false, page = 1) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: history ? [...interviewKeys.note(tenantId, jobId, questionId), "history", { page }] : interviewKeys.note(tenantId, jobId, questionId),
    queryFn: () => api.interviewNotes(jobId, { questionId, history, page, pageSize: 20 }),
    enabled: Boolean(jobId && questionId),
    meta: { suppressGlobalErrorToast: true },
  });
}
