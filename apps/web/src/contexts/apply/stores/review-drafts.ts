import { create } from "zustand";

import type { ApplicationCommand, ScreeningCommand } from "../contracts.js";

export interface ApplicationReviewDraft {
  readonly mode: "browser" | "email";
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly reason: string;
  readonly preparationEdited: boolean;
  readonly repeatReason: string;
  readonly reviewedHash: string;
  readonly rehearsalId: string;
  readonly partialOverrideRunId: string;
}
export const EMPTY_APPLICATION_DRAFT: ApplicationReviewDraft = {
  mode: "browser",
  recipient: "",
  subject: "",
  body: "",
  reason: "",
  repeatReason: "",
  preparationEdited: false,
  reviewedHash: "",
  rehearsalId: "",
  partialOverrideRunId: "",
};
export function applicationDraftKey(tenant: string, jobId: string) {
  return JSON.stringify([tenant, jobId]);
}

// Private multi-step edits survive navigation in memory. Canonical payloads,
// approvals and accepted answers always come from the application service.
export const useApplicationDraftStore = create<{
  drafts: Record<string, ApplicationReviewDraft>;
  uncertain: Record<string, ApplicationCommand | undefined>;
  screeningUncertain: Record<string, ScreeningCommand | undefined>;
  activeRuns: Record<string, string | undefined>;
  edit: (key: string, changes: Partial<ApplicationReviewDraft>) => void;
  setUncertain: (key: string, command: ApplicationCommand | undefined) => void;
  setScreeningUncertain: (
    key: string,
    command: ScreeningCommand | undefined,
  ) => void;
  setActiveRun: (key: string, runId: string) => void;
}>((set) => ({
  drafts: {},
  uncertain: {},
  screeningUncertain: {},
  activeRuns: {},
  edit: (key, changes) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: {
          ...(state.drafts[key] ?? EMPTY_APPLICATION_DRAFT),
          ...changes,
        },
      },
    })),
  setUncertain: (key, command) =>
    set((state) => ({ uncertain: { ...state.uncertain, [key]: command } })),
  setScreeningUncertain: (key, command) =>
    set((state) => ({
      screeningUncertain: { ...state.screeningUncertain, [key]: command },
    })),
  setActiveRun: (key, runId) =>
    set((state) => ({ activeRuns: { ...state.activeRuns, [key]: runId } })),
}));

export const useScreeningDraftStore = create<{
  texts: Record<string, string>;
  revisions: Record<string, number | undefined>;
  edit: (key: string, text: string) => void;
  editRevision: (key: string, text: string, revision: number) => void;
  acknowledge: (
    keys: readonly string[],
    expected: number,
    revision: number,
  ) => void;
  rebase: (keys: readonly string[], revision: number) => void;
}>((set) => ({
  texts: {},
  revisions: {},
  edit: (key, text) =>
    set((state) => ({ texts: { ...state.texts, [key]: text } })),
  editRevision: (key, text, revision) =>
    set((state) => ({
      texts: { ...state.texts, [key]: text },
      revisions: {
        ...state.revisions,
        [key]: state.revisions[key] ?? revision,
      },
    })),
  acknowledge: (keys, expected, revision) =>
    set((state) => ({
      revisions: {
        ...state.revisions,
        ...Object.fromEntries(
          keys
            .filter((key) => state.revisions[key] === expected)
            .map((key) => [key, revision]),
        ),
      },
    })),
  rebase: (keys, revision) =>
    set((state) => ({
      revisions: {
        ...state.revisions,
        ...Object.fromEntries(keys.map((key) => [key, revision])),
      },
    })),
}));
