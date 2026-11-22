import { create } from "zustand";
import type { Value } from "platejs";

import type { SessionPort } from "../../shared/ports/SessionPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import type { ResumePlateSemanticTextChange } from "../materials/lib/resume-editor-types.js";
import type { Resume } from "./client.js";

export interface ResumeEditorDraft {
  readonly owner: SessionPort;
  readonly tenant: string;
  readonly resume: Resume;
  readonly plate: Value | null;
  readonly changes: readonly ResumePlateSemanticTextChange[];
}
// Private document drafts stay in memory. Navigation never serializes them to browser storage.
export const useResumeEditorDraftStore = create<{
  drafts: ReadonlyMap<string, ResumeEditorDraft>;
  resetVersions: ReadonlyMap<SessionPort, ReadonlyMap<string, number>>;
  save: (key: string, draft: ResumeEditorDraft | null) => void;
  clear: (owner: SessionPort, tenant: string) => void;
}>((set) => ({ drafts: new Map(), resetVersions: new Map(), save: (key, draft) => set((state) => {
  const drafts = new Map(state.drafts);
  if (draft) drafts.set(key, draft); else drafts.delete(key);
  return { drafts };
}), clear: (owner, tenant) => set((state) => {
  const drafts = new Map([...state.drafts].filter(([, draft]) => draft.owner !== owner || draft.tenant !== tenant));
  const versions = new Map(state.resetVersions.get(owner));
  versions.set(tenant, (versions.get(tenant) ?? 0) + 1);
  const resetVersions = new Map(state.resetVersions);
  resetVersions.set(owner, versions);
  return { drafts, resetVersions };
}) }));
export function resumeEditorDraftKey(tenant: string, resumeId: string) { return `${tenant}:${resumeId}`; }

/** Explicit reset of one owned browser session; unrelated documents and sessions are retained. */
export function clearResumeEditorDraftsForSession(owner: SessionPort, tenant: string) {
  useResumeEditorDraftStore.getState().clear(owner, tenant);
}

export function useResumeDraftStatus(jobId: string) {
  const { session } = usePorts();
  const tenant = useTenantId();
  return useResumeEditorDraftStore((state) => [...state.drafts.values()].some((draft) => draft.owner === session && draft.tenant === tenant && draft.resume.job_id === jobId));
}
