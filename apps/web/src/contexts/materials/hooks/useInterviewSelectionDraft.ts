import type { InterviewGenerationContext } from "../../operations/types.js";
import { useEffect } from "react";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { EMPTY_INTERVIEW_SELECTION, interviewDraftKey, useInterviewDraftStore, type InterviewSelectionDraft } from "../stores/interview-drafts.js";

export function useInterviewSelectionDraft(jobId: string, initialContext?: InterviewGenerationContext | null) {
  const tenant = useTenantId();
  const key = interviewDraftKey(tenant, jobId);
  const stored = useInterviewDraftStore((state) => state.selections.get(key));
  const setSelection = useInterviewDraftStore((state) => state.setSelection);
  useEffect(() => {
    if (useInterviewDraftStore.getState().selections.has(key) || !initialContext) return;
    setSelection(key, {
      selectedQuestionIds: initialContext.selectedQuestionIds, interviewStage: initialContext.interviewStage,
      interviewFormat: initialContext.interviewFormat, responsibilityLens: initialContext.roleLens,
      roleResponsibilities: initialContext.roleResponsibilities.join("\n"), knownCriteria: initialContext.knownCriteria.join("\n"),
      selectionReason: initialContext.selectedQuestions.map((question) => question.selectionRationale).filter(Boolean).join("\n"),
      evidenceSelections: Object.fromEntries(initialContext.selectedQuestions.filter((question) => question.evidenceSelectionMode === "user_selected").map((question) => [question.questionId, question.selectedEvidenceIds])),
      evidenceProfileVersion: initialContext.profile.version,
    });
  }, [key, initialContext, setSelection]);
  const draft = stored ?? EMPTY_INTERVIEW_SELECTION;
  const update = (next: Partial<InterviewSelectionDraft>) => setSelection(key, { ...(useInterviewDraftStore.getState().selections.get(key) ?? draft), ...next });
  const toggle = (questionId: string) => update({ selectedQuestionIds: draft.selectedQuestionIds.includes(questionId) ? draft.selectedQuestionIds.filter((id) => id !== questionId) : [...draft.selectedQuestionIds, questionId] });
  const move = (questionId: string, offset: number) => {
    const ids = [...draft.selectedQuestionIds];
    const index = ids.indexOf(questionId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    update({ selectedQuestionIds: ids });
  };
  return { draft, update, toggle, move };
}
