import { beforeEach, describe, expect, it } from "vitest";

import { interviewDraftKey, useInterviewDraftStore } from "./interview-drafts.js";

const key = interviewDraftKey("tenant-a", "job-a", "B11");
beforeEach(() => useInterviewDraftStore.setState({ selections: new Map(), notes: new Map() }));

describe("navigation-surviving interview notes", () => {
  it("keeps edits made after a delayed save and advances only the saved baseline", () => {
    const store = useInterviewDraftStore.getState();
    store.initializeNote(key, "saved", 2);
    store.editNote(key, "submitted");
    store.editNote(key, "newer local edit");
    store.acknowledgeNote(key, 1, 3);
    expect(useInterviewDraftStore.getState().notes.get(key)).toMatchObject({
      text: "newer local edit", expectedRevision: 3, editVersion: 2, savedVersion: 1,
    });
    store.initializeNote(key, "older query response", 2);
    expect(useInterviewDraftStore.getState().notes.get(key)?.text).toBe("newer local edit");
  });

  it("preserves text on conflict until explicit baseline review", () => {
    const store = useInterviewDraftStore.getState();
    store.initializeNote(key, "saved", 2);
    store.editNote(key, "my recollection");
    store.conflictNote(key, 3);
    store.initializeNote(key, "another writer", 3);
    expect(useInterviewDraftStore.getState().notes.get(key)).toMatchObject({ text: "my recollection", expectedRevision: 2, conflictRevision: 3 });
    store.rebaseNote(key, 3);
    expect(useInterviewDraftStore.getState().notes.get(key)).toMatchObject({ text: "my recollection", expectedRevision: 3, conflictRevision: null });
  });

  it("isolates tenants/jobs/questions and ignores older overlapping acknowledgements", () => {
    const store = useInterviewDraftStore.getState();
    store.editNote(key, "first");
    store.editNote(key, "second");
    store.acknowledgeNote(key, 2, 4);
    store.acknowledgeNote(key, 1, 3);
    expect(useInterviewDraftStore.getState().notes.get(key)).toMatchObject({ text: "second", expectedRevision: 4, savedVersion: 2 });
    expect(useInterviewDraftStore.getState().notes.has(interviewDraftKey("tenant-b", "job-a", "B11"))).toBe(false);
    expect(useInterviewDraftStore.getState().notes.has(interviewDraftKey("tenant-a", "job-b", "B11"))).toBe(false);
    expect(useInterviewDraftStore.getState().notes.has(interviewDraftKey("tenant-a", "job-a", "C07"))).toBe(false);
  });
});
