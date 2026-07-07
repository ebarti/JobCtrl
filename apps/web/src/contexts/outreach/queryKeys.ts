import type { TenantId } from "@jobctrl/domain-types";

/**
 * Query-key factory for the Contact & Outreach context.
 *
 * Tenant-first hierarchical shape (`["tenant", tenantId, "outreach", ...]`) so
 * the invalidation router can target the right scope. Re-exported through
 * `contexts/operations/queryKeys.ts` per the frontend conventions in CLAUDE.md.
 */
export const outreachKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "outreach"] as const,

  // Contacts
  contacts: (tenantId: TenantId) => [...outreachKeys.all(tenantId), "contacts"] as const,
  contactLists: (tenantId: TenantId) => [...outreachKeys.contacts(tenantId), "list"] as const,
  contactList: (tenantId: TenantId, input: Record<string, unknown>) =>
    [...outreachKeys.contactLists(tenantId), input] as const,
  contactDetails: (tenantId: TenantId) =>
    [...outreachKeys.contacts(tenantId), "detail"] as const,
  contactDetail: (tenantId: TenantId, contactId: string) =>
    [...outreachKeys.contactDetails(tenantId), contactId] as const,

  // Research tasks
  researchTasks: (tenantId: TenantId) =>
    [...outreachKeys.all(tenantId), "research"] as const,
  researchTaskLists: (tenantId: TenantId) =>
    [...outreachKeys.researchTasks(tenantId), "list"] as const,
  researchTaskList: (tenantId: TenantId, input: Record<string, unknown>) =>
    [...outreachKeys.researchTaskLists(tenantId), input] as const,
  researchTask: (tenantId: TenantId, taskId: string) =>
    [...outreachKeys.researchTasks(tenantId), "detail", taskId] as const,

  // Outreach threads
  threads: (tenantId: TenantId) => [...outreachKeys.all(tenantId), "threads"] as const,
  thread: (tenantId: TenantId, threadId: string) =>
    [...outreachKeys.threads(tenantId), threadId] as const,
  threadForContact: (tenantId: TenantId, contactId: string, jobId: string | null = null) =>
    [...outreachKeys.threads(tenantId), "for-contact", contactId, jobId] as const,

  // Due follow-ups (derived read-model list)
  dueFollowUps: (tenantId: TenantId) =>
    [...outreachKeys.all(tenantId), "due-follow-ups"] as const,
};
