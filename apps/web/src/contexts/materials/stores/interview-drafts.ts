import { create } from "zustand";

export interface InterviewSelectionDraft {
  readonly selectedQuestionIds: readonly string[];
  readonly interviewStage: string;
  readonly interviewFormat: string;
  readonly responsibilityLens: string;
  readonly roleResponsibilities: string;
  readonly knownCriteria: string;
  readonly selectionReason: string;
  readonly evidenceSelections: Readonly<Record<string, readonly string[]>>;
  readonly evidenceProfileVersion: number | null;
}

export interface InterviewNoteDraft {
  readonly text: string;
  readonly expectedRevision: number;
  readonly editVersion: number;
  readonly savedVersion: number;
  readonly conflictRevision: number | null;
}

interface InterviewDraftState {
  readonly selections: ReadonlyMap<string, InterviewSelectionDraft>;
  readonly notes: ReadonlyMap<string, InterviewNoteDraft>;
  setSelection: (key: string, draft: InterviewSelectionDraft) => void;
  initializeNote: (key: string, text: string, revision: number) => void;
  editNote: (key: string, text: string) => void;
  acknowledgeNote: (key: string, submittedVersion: number, revision: number) => void;
  conflictNote: (key: string, revision: number) => void;
  rebaseNote: (key: string, revision: number) => void;
}

export const EMPTY_INTERVIEW_SELECTION: InterviewSelectionDraft = {
  selectedQuestionIds: [], interviewStage: "unknown", interviewFormat: "unknown",
  responsibilityLens: "", roleResponsibilities: "", knownCriteria: "", selectionReason: "",
  evidenceSelections: {}, evidenceProfileVersion: null,
};

export function interviewDraftKey(tenantId: string, jobId: string, questionId = ""): string {
  return JSON.stringify([tenantId, jobId, questionId]);
}

function emptyNote(): InterviewNoteDraft {
  return { text: "", expectedRevision: 0, editVersion: 0, savedVersion: 0, conflictRevision: null };
}

// Navigation-surviving multi-step drafts stay in memory. Personal notes never
// enter URL state or browser storage; the server owns saved revisions.
export const useInterviewDraftStore = create<InterviewDraftState>((set) => ({
  selections: new Map(), notes: new Map(),
  setSelection: (key, draft) => set((state) => ({ selections: new Map(state.selections).set(key, draft) })),
  initializeNote: (key, text, revision) => set((state) => {
    const current = state.notes.get(key);
    if (current && (current.editVersion !== current.savedVersion || revision <= current.expectedRevision)) return state;
    const next = { ...emptyNote(), ...current, text, expectedRevision: revision, conflictRevision: null };
    return { notes: new Map(state.notes).set(key, next) };
  }),
  editNote: (key, text) => set((state) => {
    const current = state.notes.get(key) ?? emptyNote();
    return { notes: new Map(state.notes).set(key, { ...current, text, editVersion: current.editVersion + 1 }) };
  }),
  acknowledgeNote: (key, submittedVersion, revision) => set((state) => {
    const current = state.notes.get(key);
    if (!current || revision < current.expectedRevision) return state;
    return { notes: new Map(state.notes).set(key, {
      ...current, expectedRevision: revision,
      savedVersion: Math.max(current.savedVersion, submittedVersion), conflictRevision: null,
    }) };
  }),
  conflictNote: (key, revision) => set((state) => {
    const current = state.notes.get(key) ?? emptyNote();
    return { notes: new Map(state.notes).set(key, { ...current, conflictRevision: Math.max(revision, current.conflictRevision ?? 0) }) };
  }),
  rebaseNote: (key, revision) => set((state) => {
    const current = state.notes.get(key);
    if (!current || revision < current.expectedRevision) return state;
    return { notes: new Map(state.notes).set(key, { ...current, expectedRevision: revision, conflictRevision: null }) };
  }),
}));
