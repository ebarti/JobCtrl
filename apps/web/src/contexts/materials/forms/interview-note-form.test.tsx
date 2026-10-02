import { JobCtrlApiError } from "@jobctrl/api-client";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InterviewQuestionNote, SaveInterviewQuestionNoteRequest } from "../../operations/types.js";
import { interviewKeys } from "../../operations/interviewKeys.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { interviewDraftKey, useInterviewDraftStore } from "../stores/interview-drafts.js";
import { InterviewNoteForm } from "./interview-note-form.js";

const initial: InterviewQuestionNote = { jobId: "job-1", questionId: "B11", revision: 1, noteText: "Saved personal note", factualSupport: "unverified_user_statement", editStatus: "user_edited", sourceGeneration: null, bindings: null, updatedAt: "2026-10-01T12:00:00Z" };
const key = interviewDraftKey(LOCAL_TENANT, "job-1", "B11");
beforeEach(() => useInterviewDraftStore.setState({ selections: new Map(), notes: new Map() }));
function notesResponse(note: InterviewQuestionNote) { return { ok: true as const, jobId: "job-1", notes: [note], page: 1, pageSize: 20, total: 1 }; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("independently revisioned interview notes", () => {
  it("preserves newer edits while a delayed save accepts only the submitted text", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; note: InterviewQuestionNote }>();
    let stored = initial;
    const save = vi.fn((_jobId: string, _body: SaveInterviewQuestionNoteRequest) => pending.promise);
    const view = renderWithProviders(<InterviewNoteForm jobId="job-1" questionId="B11" />, { ports: buildTestPorts({ api: { interviewNotes: async () => notesResponse(stored), saveInterviewNote: save } }) });
    const text = await screen.findByRole("textbox", { name: "Notes for B11" });
    await waitFor(() => expect(text).toHaveValue(initial.noteText));
    await user.clear(text); await user.type(text, "Submitted recollection");
    await user.click(screen.getByRole("button", { name: "Save unverified note" }));
    await screen.findByText("Saving submitted version; you can keep editing.");
    await user.type(text, " with a newer detail");
    stored = { ...initial, revision: 2, noteText: "Submitted recollection" };
    await act(async () => pending.resolve({ ok: true, note: stored }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save unverified note" })).toBeEnabled());
    expect(text).toHaveValue("Submitted recollection with a newer detail");
    expect(save.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 1, noteText: "Submitted recollection", factualSupport: "unverified_user_statement" });
    const draft = useInterviewDraftStore.getState().notes.get(key)!;
    expect(draft.expectedRevision).toBe(2);
    expect(draft.editVersion).toBeGreaterThan(draft.savedVersion);
    expect(view.queryClient.getQueryData(interviewKeys.note(LOCAL_TENANT, "job-1", "B11"))).toEqual(notesResponse(stored));
  });

  it("reviews a CAS conflict explicitly and retains local text before retrying", async () => {
    const user = userEvent.setup();
    const concurrent = { ...initial, revision: 2, noteText: "Concurrent saved version" };
    let stored = initial;
    const save = vi.fn(async () => { stored = concurrent; throw new JobCtrlApiError(409, "Conflict", "interview_note_revision_conflict", { currentNote: concurrent }); });
    renderWithProviders(<InterviewNoteForm jobId="job-1" questionId="B11" />, { ports: buildTestPorts({ api: { interviewNotes: async () => notesResponse(stored), saveInterviewNote: save } }) });
    const text = screen.getByRole("textbox", { name: "Notes for B11" });
    await waitFor(() => expect(text).toHaveValue(initial.noteText));
    await user.clear(text); await user.type(text, "My retained text");
    await user.click(screen.getByRole("button", { name: "Save unverified note" }));
    await screen.findAllByText("Concurrent saved version");
    expect(text).toHaveValue("My retained text");
    expect(screen.getByRole("button", { name: "Save unverified note" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep my text and use revision 2 as the saved baseline" }));
    expect(text).toHaveValue("My retained text");
    expect(screen.getByRole("button", { name: "Save unverified note" })).toBeEnabled();
    expect(useInterviewDraftStore.getState().notes.get(key)).toMatchObject({ expectedRevision: 2, conflictRevision: null });
  });

  it.each(["failure", "conflict"])("does not roll an old %s back over a newer terminal cache update", async (kind) => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; note: InterviewQuestionNote }>();
    let stored = initial;
    const view = renderWithProviders(<InterviewNoteForm jobId="job-1" questionId="B11" />, { ports: buildTestPorts({ api: { interviewNotes: async () => notesResponse(stored), saveInterviewNote: () => pending.promise } }) });
    const text = screen.getByRole("textbox", { name: "Notes for B11" });
    await waitFor(() => expect(text).toHaveValue(initial.noteText));
    await user.type(text, " new local text");
    await user.click(screen.getByRole("button", { name: "Save unverified note" }));
    await screen.findByText("Saving submitted version; you can keep editing.");
    stored = { ...initial, revision: 3, noteText: "Newer canonical note" };
    act(() => view.queryClient.setQueryData(interviewKeys.note(LOCAL_TENANT, "job-1", "B11"), notesResponse(stored)));
    await act(async () => pending.reject(kind === "conflict" ? new JobCtrlApiError(409, "Conflict", "interview_note_revision_conflict", { currentNote: { ...initial, revision: 2, noteText: "Older conflict response" } }) : new Error("late failure")));
    if (kind === "conflict") await screen.findByText("Another saved revision exists. Review it before saving your retained text.");
    else await screen.findByText("Note save failed. Your text has been preserved.");
    expect(text).toHaveValue("Saved personal note new local text");
    expect(view.queryClient.getQueryData(interviewKeys.note(LOCAL_TENANT, "job-1", "B11"))).toEqual(notesResponse(stored));
  });
});
