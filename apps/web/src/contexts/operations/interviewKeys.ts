import type { TenantId } from "@jobctrl/domain-types";

export const interviewKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "interviews"] as const,
  catalog: (tenantId: TenantId) => [...interviewKeys.all(tenantId), "catalog"] as const,
  questions: (tenantId: TenantId) => [...interviewKeys.all(tenantId), "question"] as const,
  question: (tenantId: TenantId, questionId: string) => [...interviewKeys.questions(tenantId), questionId] as const,
  jobs: (tenantId: TenantId) => [...interviewKeys.all(tenantId), "job"] as const,
  job: (tenantId: TenantId, jobId: string) => [...interviewKeys.all(tenantId), "job", jobId] as const,
  history: (tenantId: TenantId, jobId: string) => [...interviewKeys.job(tenantId, jobId), "history"] as const,
  notes: (tenantId: TenantId, jobId: string) => [...interviewKeys.job(tenantId, jobId), "notes"] as const,
  note: (tenantId: TenantId, jobId: string, questionId: string) => [...interviewKeys.notes(tenantId, jobId), questionId] as const,
};
