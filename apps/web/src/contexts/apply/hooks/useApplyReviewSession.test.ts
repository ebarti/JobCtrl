import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_TENANT, type TenantId } from "@jobctrl/domain-types";
import type { Value } from "platejs";
import type { ApplyReviewQueueItem, ResumeReviewDraft, ResumeReviewDraftRenderResponse, ResumeCommentThread } from "@jobctrl/contracts";
import { sampleApplyReviewQueue } from "../../../test/fixtures/projections.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts, FakeSessionPort } from "../../../test/testPorts.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { useApplyReviewSession } from "./useApplyReviewSession.js";
import { normalizeResumePlateValue } from "../../materials/lib/resume-document.js";

const time = "2026-10-18T00:00:00Z";
const item = sampleApplyReviewQueue.items[0]!;
const document = (text: string, bold = false): Value => [{ type: "resume_block", tagName: "p", children: [{ text, bold }] }];
function draftFor(owner = item, value = document("A"), revisionNumber = 1, draftId = "draft-1"): ResumeReviewDraft {
  const revisionId = `${draftId}-revision-${revisionNumber}`;
  return {
    draftId, jobKey: owner.jobKey, baseGeneration: 1, rendererFormat: "html_css", state: "active",
    baseResumeTextArtifactId: owner.materialsPreview.resumeTextArtifactId, baseResumePdfArtifactId: owner.materialsPreview.resumePdfArtifactId,
    currentRevisionId: revisionId, latestRevisionNumber: revisionNumber, createdAt: time, updatedAt: time,
    latestRevision: { draftId, jobKey: owner.jobKey, revisionId, revisionNumber, editedText: "synthetic", plateDocument: value, editDeltas: [], createdAt: time },
    commentThreads: [], feedbackSignals: [],
  };
}
function rendered(draft: ResumeReviewDraft): Extract<ResumeReviewDraftRenderResponse, { ok: true }> {
  return { ok: true, draft: { ...draft, state: "promoted" }, validation: { passed: true, errors: [], warnings: [] },
    artifacts: { resumeText: { artifactId: "rendered-text", artifactType: "tailored_resume", generation: 2, renderFormat: "text" },
      resumePdf: { artifactId: "rendered-pdf", artifactType: "resume_pdf", generation: 2, renderFormat: "html_pdf" } }, layoutBoxCount: 0 };
}
function promotedItem(owner = item): ApplyReviewQueueItem {
  return { ...owner, approvalGate: { ...owner.approvalGate, materialsGeneration: 2 },
    materialsPreview: { ...owner.materialsPreview, resumeTextArtifactId: "rendered-text", resumePdfArtifactId: "rendered-pdf" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function threadFor(id: string): ResumeCommentThread {
  return { threadId: id, draftId: "draft-1", jobKey: item.jobKey, baseArtifactId: item.materialsPreview.resumeTextArtifactId,
    semanticId: null, lineAnchor: null, sourcePinId: null, riskLabel: "source question", commentBody: "Synthetic source question",
    state: "open", anchorResolved: false, createdAt: time, updatedAt: time, replies: [] };
}
function replyFor(thread: ResumeCommentThread) {
  const reply = { replyId: `reply-${thread.threadId}`, threadId: thread.threadId, draftRevisionId: "draft-1-revision-1",
    author: "user", decision: "clarified" as const, body: "Synthetic clarification", createdAt: time };
  return { ok: true as const, thread: { ...thread, state: "user_replied" as const, replies: [reply] }, reply,
    feedbackSignal: { signalId: `signal-${thread.threadId}`, jobKey: item.jobKey, draftId: "draft-1", draftRevisionId: reply.draftRevisionId,
      sourceKind: "comment_reply" as const, sourceId: reply.replyId, kind: "factual_correction" as const,
      status: "candidate" as const, summary: reply.body, section: null, semanticId: null, createdAt: time, reviewedAt: null } };
}
type Api = ReturnType<typeof buildTestPorts>["api"];
function mount(overrides: Partial<Api> = {}, initial = item, autosave = 0) {
  const draft = draftFor(initial);
  const api = {
    createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })),
    applyReviewQueue: vi.fn(async () => ({ ok: true as const, items: [promotedItem(initial)] })),
    renderResumeReviewDraft: vi.fn(async () => rendered(draft)),
    decideApplyReview: vi.fn(async () => ({ ok: true as const, decision: { decisionId: "decision", jobKey: initial.jobKey,
      decision: "approve_submit" as const, reason: null, decidedBy: "user", decidedAt: time } })),
    ...overrides,
  };
  const ports = buildTestPorts({ api: { ...api, applyJob: vi.fn(async () => { throw new Error("Unexpected automation dispatch"); }) } });
  const hook = renderHookWithProviders((owner: ApplyReviewQueueItem) => useApplyReviewSession(owner, autosave), { ports, initialProps: initial });
  return { ...hook, api, draft };
}
// Hook state has no DOM mutation to wake waitFor's observer; poll readiness
// promptly while retaining its normal timeout and the same acceptance condition.
const ready = async (hook: ReturnType<typeof mount>) => { await waitFor(() => expect(hook.result.current.draft).not.toBeNull(), { interval: 1 }); };

describe("Apply review session", () => {
  it.each(["unchanged", "later text", "later formatting", "undo"])("acknowledges normalized multiline paste while preserving %s", async (change) => {
    const pending = deferred<Awaited<ReturnType<Api["saveResumeReviewDraftRevision"]>>>();
    const hook = mount({ saveResumeReviewDraftRevision: vi.fn(() => pending.promise) }); await ready(hook);
    const pasted: Value = [...document("first pasted paragraph"), { type: "p", children: [{ text: "second pasted paragraph" }] }];
    act(() => hook.result.current.edit(pasted));
    const version = hook.result.current.documentVersion;
    let saving!: ReturnType<typeof hook.result.current.save>;
    act(() => { saving = hook.result.current.save(); });
    await waitFor(() => expect(hook.api.saveResumeReviewDraftRevision).toHaveBeenCalledTimes(1));
    const later = change === "unchanged" ? pasted : change === "undo" ? document("A")
      : change === "later formatting" ? [...pasted.slice(0, 1), { type: "p", children: [{ text: "second pasted paragraph", bold: true }] }]
      : [...pasted.slice(0, 1), { type: "p", children: [{ text: "later paragraph" }] }];
    if (change !== "unchanged") act(() => hook.result.current.edit(later));
    const saved = draftFor(item, normalizeResumePlateValue(pasted), 2);
    await act(async () => { pending.resolve({ ok: true, draft: saved, revision: saved.latestRevision! }); await saving; });
    expect(hook.result.current.document).toBe(later);
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.dirty).toBe(change !== "unchanged");
    expect(hook.result.current.canRender).toBe(change === "unchanged");
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("ignores superseded B load %s through cache after loaded A switches to C", async (outcome) => {
    const itemB = { ...item, materialsPreview: { ...item.materialsPreview, resumeTextArtifactId: "text-B", resumePdfArtifactId: "pdf-B" } };
    const itemC = { ...item, materialsPreview: { ...item.materialsPreview, resumeTextArtifactId: "text-C", resumePdfArtifactId: "pdf-C" } };
    const draftB = { ...draftFor(itemB, document("B"), 1, "draft-B"), baseGeneration: 2 };
    const draftC = { ...draftFor(itemC, document("C"), 1, "draft-C"), baseGeneration: 3 };
    const pendingB = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const pendingC = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const create = vi.fn<Api["createResumeReviewDraft"]>().mockResolvedValueOnce({ ok: true, draft: draftFor() })
      .mockImplementationOnce(() => pendingB.promise).mockImplementationOnce(() => pendingC.promise);
    const hook = mount({ createResumeReviewDraft: create }); await ready(hook);
    hook.rerender(itemB);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    hook.rerender(itemC);
    const later = document("typed while waiting for C");
    act(() => hook.result.current.edit(later));
    const version = hook.result.current.documentVersion;
    await act(async () => {
      if (outcome === "success") pendingB.resolve({ ok: true, draft: draftB });
      else pendingB.reject(new Error("B offline"));
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(hook.result.current.draft?.draftId).toBe(hook.draft.draftId);
    expect(hook.result.current.document).toBe(later);
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.errors.load).toBeUndefined();
    await act(async () => { await hook.result.current.decide("approve_dry_run", "synthetic"); });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    await act(async () => pendingC.resolve({ ok: true, draft: draftC }));
    await waitFor(() => expect(hook.result.current.draft?.draftId).toBe(draftC.draftId));
    expect(hook.result.current.document).toEqual(document("C"));
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it("reuses compatible early seeds for a replacement of the same material", async () => {
    const replacement = { ...draftFor(item, document("replacement"), 1, "replacement"), baseGeneration: 2 };
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>(async (id) => ({
      ok: true, draft: id === replacement.draftId ? replacement : draftFor(), commentThreads: [], seededCount: 1, updatedCount: 0,
    }));
    const hook = mount({ seedResumeReviewCommentThreads: seed }); await ready(hook);
    const threads = [{ baseArtifactId: item.materialsPreview.resumeTextArtifactId!, sourcePinId: "compatible-pin", commentBody: "Source question" }];
    act(() => hook.result.current.seed(threads));
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: replacement }));
    await waitFor(() => expect(seed).toHaveBeenCalledWith(replacement.draftId, { threads }));
    expect(hook.result.current.document).toEqual(document("replacement"));
  });

  it("discards seeds when only the PDF source changes, and rejects explicitly foreign inputs", async () => {
    const nextItem = { ...item, materialsPreview: { ...item.materialsPreview, resumePdfArtifactId: "pdf-B" } };
    const nextDraft = { ...draftFor(nextItem, document("B"), 1, "draft-B"), baseGeneration: 2 };
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>(async () => ({
      ok: true, draft: draftFor(), commentThreads: [], seededCount: 1, updatedCount: 0,
    }));
    const hook = mount({ seedResumeReviewCommentThreads: seed, createResumeReviewDraft: vi.fn<Api["createResumeReviewDraft"]>()
      .mockResolvedValueOnce({ ok: true, draft: draftFor() }).mockResolvedValueOnce({ ok: true, draft: nextDraft }) }); await ready(hook);
    act(() => hook.result.current.seed([{ commentBody: "A" }]));
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    const retryA = hook.result.current.retrySeed;
    hook.rerender(nextItem);
    await waitFor(() => expect(hook.result.current.draft?.draftId).toBe(nextDraft.draftId));
    act(() => {
      retryA();
      hook.result.current.retrySeed();
      hook.result.current.seed([{ baseArtifactId: "foreign-text", commentBody: "Foreign" }]);
    });
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it("lets a newer pin payload recover when an older seed fails", async () => {
    const pending = deferred<Awaited<ReturnType<Api["seedResumeReviewCommentThreads"]>>>();
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>().mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, draft: draftFor(), commentThreads: [], seededCount: 1, updatedCount: 0 });
    const hook = mount({ seedResumeReviewCommentThreads: seed }); await ready(hook);
    act(() => hook.result.current.seed([{ sourcePinId: "old", commentBody: "Old" }]));
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    const threads = [{ sourcePinId: "new", commentBody: "New" }];
    act(() => hook.result.current.seed(threads));
    await act(async () => pending.reject(new Error("Old failed")));
    await waitFor(() => expect(seed).toHaveBeenCalledWith(hook.draft.draftId, { threads }));
    expect(hook.result.current.errors.seed).toBeUndefined();
  });

  it.each(["empty pins", "new pins"])("fences retained seeds while replacement HTML is delayed, then accepts %s", async (pins) => {
    const nextItem = { ...item, materialsPreview: { ...item.materialsPreview,
      resumeTextArtifactId: "text-B", resumePdfArtifactId: "pdf-B" } };
    const nextDraft = { ...draftFor(nextItem, document("B"), 1, "draft-B"), baseGeneration: 2 };
    const create = vi.fn<Api["createResumeReviewDraft"]>()
      .mockResolvedValueOnce({ ok: true, draft: draftFor() }).mockResolvedValueOnce({ ok: true, draft: nextDraft });
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>(async (draftId) => ({
      ok: true, draft: draftId === nextDraft.draftId ? nextDraft : draftFor(), commentThreads: [], seededCount: 1, updatedCount: 0,
    }));
    const hook = mount({ createResumeReviewDraft: create, seedResumeReviewCommentThreads: seed }); await ready(hook);
    const oldSeed = hook.result.current.seed;
    const oldThreads = [{ baseArtifactId: item.materialsPreview.resumeTextArtifactId!, sourcePinId: "pin-A", commentBody: "A source question" }];
    act(() => oldSeed(oldThreads));
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    hook.rerender(nextItem);
    await waitFor(() => expect(hook.result.current.draft?.draftId).toBe(nextDraft.draftId));
    // No B callback yet: its HTML/provenance is still loading.
    expect(seed.mock.calls.filter(([id]) => id === nextDraft.draftId)).toEqual([]);
    act(() => oldSeed(oldThreads)); // A's delayed publisher must also stay fenced.
    const threads = pins === "empty pins" ? [] : [{ baseArtifactId: "text-B", sourcePinId: "pin-B", commentBody: "B source question" }];
    act(() => hook.result.current.seed(threads));
    if (threads.length) await waitFor(() => expect(seed).toHaveBeenCalledWith(nextDraft.draftId, { threads }));
    expect(seed.mock.calls.filter(([id]) => id === nextDraft.draftId)).toEqual(threads.length ? [[nextDraft.draftId, { threads }]] : []);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("settles a pending A seed %s after replacement without replaying it or blocking B", async (outcome) => {
    const pending = deferred<Awaited<ReturnType<Api["seedResumeReviewCommentThreads"]>>>();
    const nextItem = { ...item, materialsPreview: { ...item.materialsPreview, resumeTextArtifactId: "text-B", resumePdfArtifactId: "pdf-B" } };
    const nextDraft = { ...draftFor(nextItem, document("B"), 1, "draft-B"), baseGeneration: 2 };
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>().mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, draft: nextDraft, commentThreads: [], seededCount: 1, updatedCount: 0 });
    const hook = mount({ seedResumeReviewCommentThreads: seed, createResumeReviewDraft: vi.fn<Api["createResumeReviewDraft"]>()
      .mockResolvedValueOnce({ ok: true, draft: draftFor() }).mockResolvedValueOnce({ ok: true, draft: nextDraft }) }); await ready(hook);
    act(() => hook.result.current.seed([{ baseArtifactId: item.materialsPreview.resumeTextArtifactId!, sourcePinId: "pin-A", commentBody: "A" }]));
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    hook.rerender(nextItem);
    await waitFor(() => expect(hook.result.current.draft?.draftId).toBe(nextDraft.draftId));
    await act(async () => {
      if (outcome === "failure") pending.reject(new Error("A offline"));
      else pending.resolve({ ok: true, draft: draftFor(), commentThreads: [], seededCount: 1, updatedCount: 0 });
    });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(hook.result.current.errors.seed).toBeUndefined();
    const threads = [{ baseArtifactId: "text-B", sourcePinId: "pin-B", commentBody: "B" }];
    act(() => hook.result.current.seed(threads));
    await waitFor(() => expect(seed).toHaveBeenCalledWith(nextDraft.draftId, { threads }));
    expect(hook.result.current.draft?.draftId).toBe(nextDraft.draftId);
    expect(hook.result.current.document).toEqual(document("B"));
  });

  it("preserves edits made before an existing saved draft finishes loading", async () => {
    const pending = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const hook = mount({ createResumeReviewDraft: vi.fn(() => pending.promise) });
    act(() => {
      hook.result.current.initializeDocument(document("HTML source"));
      hook.result.current.edit(document("typed while loading"));
    });
    const version = hook.result.current.documentVersion;
    await act(async () => { pending.resolve({ ok: true, draft: hook.draft }); });
    await ready(hook);
    expect(hook.result.current.document).toEqual(document("typed while loading"));
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.dirty).toBe(true);
  });

  it("seeds comments supplied before loading once the owning draft arrives", async () => {
    const pending = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>(async () => ({
      ok: true, draft: draftFor(), commentThreads: [], seededCount: 1, updatedCount: 0,
    }));
    const hook = mount({ createResumeReviewDraft: vi.fn(() => pending.promise), seedResumeReviewCommentThreads: seed });
    const threads = [{ commentBody: "Synthetic source question" }];
    act(() => hook.result.current.seed(threads));
    expect(seed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ ok: true, draft: hook.draft }); });
    await waitFor(() => expect(seed).toHaveBeenCalledWith(hook.draft.draftId, { threads }));
  });

  it("does not accept an initial load whose material source changed while it was pending", async () => {
    const first = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const second = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const create = vi.fn<Api["createResumeReviewDraft"]>()
      .mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const hook = mount({ createResumeReviewDraft: create });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const nextItem = { ...item, materialsPreview: { ...item.materialsPreview,
      resumeTextArtifactId: "next-text", resumePdfArtifactId: "next-pdf" } };
    hook.rerender(nextItem);
    await act(async () => { first.resolve({ ok: true, draft: hook.draft }); });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const staleDraft = hook.result.current.draft;
    const staleDocument = hook.result.current.document;
    const nextDraft = { ...draftFor(nextItem, document("next source"), 1, "next-draft"), baseGeneration: 2 };
    await act(async () => { second.resolve({ ok: true, draft: nextDraft }); });
    expect(staleDraft).toBeNull();
    expect(staleDocument).toBeNull();
    expect(hook.result.current.document).toEqual(document("next source"));
    expect(hook.result.current.draft?.draftId).toBe(nextDraft.draftId);
  });

  it("preserves undo during save when a newer canonical snapshot beats the acknowledgement", async () => {
    const pending = deferred<Awaited<ReturnType<Api["saveResumeReviewDraftRevision"]>>>();
    const hook = mount({ saveResumeReviewDraftRevision: vi.fn(() => pending.promise) }); await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    let saving!: ReturnType<typeof hook.result.current.save>;
    act(() => { saving = hook.result.current.save(); });
    await waitFor(() => expect(hook.result.current.saving).toBe(true));
    act(() => hook.result.current.edit(document("A")));
    const version = hook.result.current.documentVersion;
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), {
      ok: true, draft: draftFor(item, document("canonical C"), 3),
    }));
    const older = draftFor(item, document("B"), 2);
    await act(async () => { pending.resolve({ ok: true, draft: older, revision: older.latestRevision! }); await saving; });
    expect(hook.result.current.document).toEqual(document("A"));
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.dirty).toBe(true);
  });

  it("does not attach an old save failure to a newer canonical revision", async () => {
    const pending = deferred<Awaited<ReturnType<Api["saveResumeReviewDraftRevision"]>>>();
    const hook = mount({ saveResumeReviewDraftRevision: vi.fn(() => pending.promise) }); await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    let saving!: ReturnType<typeof hook.result.current.save>;
    act(() => { saving = hook.result.current.save(); });
    await waitFor(() => expect(hook.result.current.saving).toBe(true));
    act(() => {
      hook.result.current.edit(document("canonical C"));
      hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), {
        ok: true, draft: draftFor(item, document("canonical C"), 3),
      });
    });
    await waitFor(() => expect(hook.result.current.draft?.latestRevisionNumber).toBe(3));
    await act(async () => { pending.reject(new Error("old write failed")); await saving; });
    expect(hook.result.current.errors.save).toBeUndefined();
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.canRender).toBe(true);
  });

  it.each(["later text", "later formatting", "undo"])("acknowledges only submitted A while preserving %s", async (kind) => {
    const saved = deferred<Awaited<ReturnType<Api["saveResumeReviewDraftRevision"]>>>();
    const save = vi.fn(() => saved.promise);
    const hook = mount({ saveResumeReviewDraftRevision: save });
    await ready(hook);
    const version = hook.result.current.documentVersion;
    act(() => hook.result.current.edit(document("submitted")));
    let operation!: ReturnType<typeof hook.result.current.save>;
    act(() => { operation = hook.result.current.save(); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const later = kind === "undo" ? document("A") : kind === "later formatting" ? document("submitted", true) : document("B");
    act(() => hook.result.current.edit(later));
    const response = draftFor(item, document("submitted"), 2);
    await act(async () => { saved.resolve({ ok: true, draft: response, revision: response.latestRevision! }); await operation; });
    expect(hook.result.current.document).toEqual(later);
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.canRender).toBe(false);
  });

  it("serializes saves, refuses render during save and can prepare approval after acknowledgement", async () => {
    const pending = deferred<Awaited<ReturnType<Api["saveResumeReviewDraftRevision"]>>>();
    const savedDraft = draftFor(item, document("B"), 2);
    const save = vi.fn(() => pending.promise);
    const render = vi.fn(async () => rendered(savedDraft));
    const hook = mount({ saveResumeReviewDraftRevision: save, renderResumeReviewDraft: render });
    await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    act(() => { void hook.result.current.save(); void hook.result.current.save(); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => { await hook.result.current.render(); });
    expect(render).not.toHaveBeenCalled();
    let decision!: Promise<void>;
    act(() => { decision = hook.result.current.decide("approve_dry_run", "reviewed"); });
    await act(async () => { pending.resolve({ ok: true, draft: savedDraft, revision: savedDraft.latestRevision! }); await decision; });
    expect(render).toHaveBeenCalledWith(savedDraft.draftId, { draftRevisionId: savedDraft.currentRevisionId });
    expect(hook.api.decideApplyReview).toHaveBeenCalledTimes(1);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it("does not regress rendered state when a stale seed or query snapshot settles", async () => {
    const pending = deferred<Awaited<ReturnType<Api["seedResumeReviewCommentThreads"]>>>();
    const hook = mount({ seedResumeReviewCommentThreads: vi.fn(() => pending.promise) });
    await ready(hook);
    act(() => hook.result.current.seed([{ commentBody: "Synthetic source question" }]));
    await act(async () => { await hook.result.current.render(); });
    const comparison = hook.result.current.comparison;
    await act(async () => { pending.resolve({ ok: true, draft: hook.draft, commentThreads: [], seededCount: 0, updatedCount: 0 }); });
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: hook.draft }));
    expect(hook.result.current.draft?.state).toBe("promoted");
    expect(hook.result.current.comparison).toEqual(comparison);
  });

  it("resets document identity for a replacement draft with a restarted revision counter", async () => {
    const hook = mount(); await ready(hook);
    act(() => hook.result.current.edit(document("private unsaved edit")));
    const previousVersion = hook.result.current.documentVersion;
    const replacement = { ...draftFor(item, document("replacement"), 1, "replacement"), baseGeneration: 2 };
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: replacement }));
    await waitFor(() => expect(hook.result.current.draft?.draftId).toBe("replacement"));
    expect(hook.result.current.document).toEqual(document("replacement"));
    expect(hook.result.current.documentVersion).not.toBe(previousVersion);
    expect(hook.result.current.dirty).toBe(false);
  });

  it.each(["job", "tenant"])("scopes delayed successes and errors to the initiating %s", async (switchKind) => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const hook = mount({ renderResumeReviewDraft: vi.fn(() => pending.promise) });
    await ready(hook);
    let operation!: ReturnType<typeof hook.result.current.render>;
    act(() => { operation = hook.result.current.render(); });
    await waitFor(() => expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1));
    const other = switchKind === "job" ? { ...item, jobKey: "other-job" } : item;
    if (switchKind === "tenant") Object.assign(hook.ports, { session: new FakeSessionPort({ tenantId: "other-tenant" as TenantId, userId: null }) });
    hook.rerender(other);
    await act(async () => { pending.reject(new Error("old-session-failure")); await operation; });
    expect(hook.result.current.renderResult).toBeNull();
    expect(hook.result.current.comparison).toBeNull();
    expect(hook.result.current.errors.render).toBeUndefined();
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
  });

  it("discards a late render after a same-content job switch and publishes only the original tenant cache", async () => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const other = { ...item, jobKey: "other-job" };
    const hook = mount({ createResumeReviewDraft: vi.fn(async (jobKey) => ({ ok: true as const, draft: draftFor(jobKey === item.jobKey ? item : other) })),
      renderResumeReviewDraft: vi.fn(() => pending.promise) });
    await ready(hook);
    let operation!: ReturnType<typeof hook.result.current.render>;
    act(() => { operation = hook.result.current.render(); });
    await waitFor(() => expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1));
    hook.rerender(other);
    await waitFor(() => expect(hook.result.current.draft?.jobKey).toBe(other.jobKey));
    await act(async () => { pending.resolve(rendered(hook.draft)); await operation; });
    expect(hook.result.current.comparison).toBeNull();
    expect(hook.result.current.draft?.state).toBe("active");
    expect(hook.queryClient.getQueryData<{ draft: ResumeReviewDraft }>(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey))?.draft.state).toBe("promoted");
  });

  it("retains accepted artifacts, revision, comments and evidence through failed refreshes and explicit recovery", async () => {
    const thread = threadFor("accepted");
    const original = { ...draftFor(), commentThreads: [thread], feedbackSignals: [replyFor(thread).feedbackSignal] };
    const render = vi.fn<Api["renderResumeReviewDraft"]>().mockResolvedValueOnce(rendered(original))
      .mockRejectedValueOnce(new Error("transport failure"))
      .mockResolvedValueOnce({ ok: false, error: "resume_review_draft_invalid", draft: original, validation: { passed: false, errors: ["Synthetic validation rejection"], warnings: [] } })
      .mockResolvedValueOnce(rendered(original));
    const hook = mount({ renderResumeReviewDraft: render, createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft: original })) }); await ready(hook);
    await act(async () => { await hook.result.current.render(); });
    const accepted = hook.result.current.comparison;
    await act(async () => { await hook.result.current.render(); });
    expect(hook.result.current.comparison).toEqual(accepted);
    expect(hook.result.current.errors.render).toBe("transport failure");
    await act(async () => { await hook.result.current.render(); });
    expect(hook.result.current.comparison).toEqual(accepted);
    expect(hook.result.current.renderResult?.ok).toBe(false);
    expect(hook.result.current.draft?.currentRevisionId).toBe(original.currentRevisionId);
    expect(hook.result.current.draft?.commentThreads).toEqual(original.commentThreads);
    expect(hook.result.current.draft?.feedbackSignals).toEqual(original.feedbackSignals);
    expect(hook.result.current.reason).toContain("validation");
    await act(async () => { await hook.result.current.render(); });
    expect(hook.result.current.reason).toBeNull();
    expect(hook.result.current.errors.render).toBeUndefined();
  });

  it("leaves edits dirty after save failure and releases the write queue for manual retry", async () => {
    const next = draftFor(item, document("B"), 2);
    const save = vi.fn<Api["saveResumeReviewDraftRevision"]>().mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce({ ok: true, draft: next, revision: next.latestRevision! });
    const hook = mount({ saveResumeReviewDraftRevision: save }); await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    await act(async () => { await hook.result.current.save(); });
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.errors.save).toBe("save failed");
    expect(hook.result.current.draft?.currentRevisionId).toBe(hook.draft.currentRevisionId);
    await act(async () => { await hook.result.current.save(); });
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.errors.save).toBeUndefined();
  });

  it("autosaves the latest document and stops retrying a failed unchanged snapshot", async () => {
    const save = vi.fn<Api["saveResumeReviewDraftRevision"]>().mockRejectedValue(new Error("offline"));
    const hook = mount({ saveResumeReviewDraftRevision: save }, item, 15); await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    await waitFor(() => expect(hook.result.current.errors.save).toBe("offline"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { await hook.result.current.save(); });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each(["before", "during"])("resumes default-delay autosave for edits made %s a slow load retry returning the same revision", async (editTiming) => {
    const cached = draftFor();
    const next = draftFor(item, document("typed during retry", true), 2);
    const pending = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const create = vi.fn<Api["createResumeReviewDraft"]>().mockRejectedValueOnce(new Error("load failed"))
      .mockImplementationOnce(() => pending.promise);
    const save = vi.fn<Api["saveResumeReviewDraftRevision"]>().mockResolvedValue({ ok: true, draft: next, revision: next.latestRevision! });
    const applyJob = vi.fn<Api["applyJob"]>();
    const decideApplyReview = vi.fn<Api["decideApplyReview"]>();
    const renderResumeReviewDraft = vi.fn<Api["renderResumeReviewDraft"]>();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: cached });
    const ports = buildTestPorts({ api: { createResumeReviewDraft: create, saveResumeReviewDraftRevision: save,
      applyJob, decideApplyReview, renderResumeReviewDraft } });
    const hook = renderHookWithProviders(() => useApplyReviewSession(item), { ports, queryClient });
    try {
      await waitFor(() => expect(hook.result.current.errors.load).toBe("load failed"));
      expect(hook.result.current.document).toEqual(document("A"));
      const version = hook.result.current.documentVersion;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      if (editTiming === "before") act(() => hook.result.current.edit(document("typed during retry", true)));
      act(() => hook.result.current.retryLoad());
      if (editTiming === "during") act(() => hook.result.current.edit(document("typed during retry", true)));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(create).toHaveBeenCalledTimes(2);
      expect(hook.result.current.loading).toBe(true);
      expect(hook.result.current.canSave).toBe(false);
      // Exceed the production 1,500 ms interval without allowing a write during loading.
      await act(async () => { await vi.advanceTimersByTimeAsync(1650); });
      expect(save).not.toHaveBeenCalled();
      await act(async () => {
        pending.resolve({ ok: true, draft: cached });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.dirty).toBe(true);
      expect(hook.result.current.canSave).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
      expect(save).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(cached.draftId, expect.objectContaining({
        editedText: "typed during retry", plateDocument: next.latestRevision!.plateDocument,
      }));
      expect(hook.result.current.dirty).toBe(false);
      expect(hook.result.current.documentVersion).toBe(version);
      expect(hook.result.current.document).toEqual(document("typed during retry", true));
      expect(hook.result.current.errors.save).toBeUndefined();
      expect(hook.result.current.errors.load).toBeUndefined();
      expect(hook.result.current.canRender).toBe(true);
      expect(applyJob).not.toHaveBeenCalled();
      expect(decideApplyReview).not.toHaveBeenCalled();
      expect(renderResumeReviewDraft).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });

  it("allows load retry without replacing the accepted document with a failed attempt", async () => {
    const create = vi.fn<Api["createResumeReviewDraft"]>().mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce({ ok: true, draft: draftFor() });
    const hook = mount({ createResumeReviewDraft: create });
    await waitFor(() => expect(hook.result.current.errors.load).toBe("load failed"));
    act(() => hook.result.current.retryLoad());
    await ready(hook);
    expect(hook.result.current.errors.load).toBeUndefined();
  });

  it.each(["edit", "undo", "job", "tenant", "replacement"])("cannot authorize when %s supersedes approval preparation", async (change) => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const hook = mount({ renderResumeReviewDraft: vi.fn(() => pending.promise) }); await ready(hook);
    let approval!: Promise<void>;
    act(() => { approval = hook.result.current.decide("approve_submit", "reviewed"); });
    await waitFor(() => expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1));
    if (change === "edit" || change === "undo") act(() => {
      hook.result.current.edit(document("B"));
      if (change === "undo") hook.result.current.edit(document("A"));
    });
    if (change === "job") hook.rerender({ ...item, jobKey: "other" });
    if (change === "tenant") {
      Object.assign(hook.ports, { session: new FakeSessionPort({ tenantId: "other" as TenantId, userId: null }) });
      hook.rerender(item);
    }
    if (change === "replacement") act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), {
      ok: true, draft: { ...draftFor(item, document("A"), 1, "replacement"), baseGeneration: 2 },
    }));
    await act(async () => { pending.resolve(rendered(hook.draft)); await approval; });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it.each(["validation", "transport", "409"])("does not authorize a %s failure and permits explicit retry", async (failure) => {
    const render = vi.fn<Api["renderResumeReviewDraft"]>();
    if (failure === "validation") render.mockResolvedValueOnce({ ok: false, error: "resume_review_draft_invalid", draft: draftFor(), validation: { passed: false, errors: ["invalid synthetic input"], warnings: [] } });
    else render.mockRejectedValueOnce(new Error(failure === "409" ? "HTTP 409: generation changed; retry" : "transport unavailable"));
    render.mockResolvedValueOnce(rendered(draftFor()));
    const hook = mount({ renderResumeReviewDraft: render }); await ready(hook);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.decideApplyReview).toHaveBeenCalledTimes(1);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it("binds live approval to the rendered generation, current email and saved revision with no automation dispatch", async () => {
    const emailItem = { ...item, emailApplication: { ...sampleApplyReviewQueue.items[0]!.emailApplication!, recipient: "synthetic@example.test", attachmentArtifactId: "email-artifact" } };
    const canonical = { ...promotedItem(emailItem), emailApplication: { ...emailItem.emailApplication, attachmentArtifactId: "rendered-pdf" } };
    const hook = mount({ applyReviewQueue: vi.fn(async () => ({ ok: true as const, items: [canonical] })) }, emailItem); await ready(hook);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledWith(hook.draft.draftId, { draftRevisionId: hook.draft.currentRevisionId });
    expect(hook.api.decideApplyReview).toHaveBeenCalledWith(emailItem.jobKey, expect.objectContaining({
      materialsGeneration: 2, profileVersion: item.approvalGate.profileVersion, applicationUrl: item.approvalGate.applicationUrl,
      emailRecipient: "synthetic@example.test", emailAttachmentArtifactId: "rendered-pdf",
    }));
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it.each(["profile", "URL", "materials", "repeat", "evidence", "email"])("rejects changed canonical %s inputs", async (change) => {
    let canonical = promotedItem();
    if (change === "profile") canonical = { ...canonical, approvalGate: { ...canonical.approvalGate, profileVersion: 999 } };
    if (change === "URL") canonical = { ...canonical, approvalGate: { ...canonical.approvalGate, applicationUrl: "https://other.example.test/apply" } };
    if (change === "materials") canonical = { ...canonical, materialsPreview: { ...canonical.materialsPreview, resumePdfArtifactId: "foreign-pdf" } };
    if (change === "repeat") canonical = { ...canonical, repeatApplication: { ...canonical.repeatApplication, status: "blocked" } };
    if (change === "evidence") canonical = { ...canonical, approvalGate: { ...canonical.approvalGate, dryRunEvidence: null } };
    if (change === "email") canonical = { ...canonical, emailApplication: { ...canonical.emailApplication!, recipient: "changed@example.test" } };
    const hook = mount({ applyReviewQueue: vi.fn(async () => ({ ok: true as const, items: [canonical] })) }); await ready(hook);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    expect(hook.result.current.errors.decision).toBeTruthy();
  });

  it("keeps defer, decline and reset decision-only without rendering or dispatch", async () => {
    const hook = mount(); await ready(hook);
    act(() => hook.result.current.edit(document("unsaved")));
    for (const value of ["defer", "decline", "reset"] as const) await act(async () => { await hook.result.current.decide(value, "user choice"); });
    expect(hook.api.renderResumeReviewDraft).not.toHaveBeenCalled();
    expect(hook.api.decideApplyReview).toHaveBeenCalledTimes(3);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
    expect(hook.result.current.dirty).toBe(true);
  });

  it("merges independent replies in reversed order without remounting or losing feedback IDs", async () => {
    const first = threadFor("one"), second = threadFor("two");
    const one = deferred<ReturnType<typeof replyFor>>(), two = deferred<ReturnType<typeof replyFor>>();
    const reply = vi.fn<Api["replyToResumeReviewComment"]>((id) => id === "one" ? one.promise : two.promise);
    const draft = { ...draftFor(), commentThreads: [first, second] };
    const hook = mount({ createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })), replyToResumeReviewComment: reply });
    await ready(hook);
    const version = hook.result.current.documentVersion;
    act(() => { void hook.result.current.reply(first, { body: "one", decision: "clarified" }); void hook.result.current.reply(second, { body: "two", decision: "clarified" }); });
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    await act(async () => { two.resolve(replyFor(second)); });
    expect(hook.result.current.replying).toBe(true);
    await act(async () => { one.resolve(replyFor(first)); });
    await waitFor(() => expect(hook.result.current.replying).toBe(false));
    expect(hook.result.current.draft?.commentThreads.map((entry) => entry.replies[0]?.replyId).sort()).toEqual(["reply-one", "reply-two"]);
    expect(hook.result.current.draft?.feedbackSignals.map((entry) => entry.signalId).sort()).toEqual(["signal-one", "signal-two"]);
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.dirty).toBe(false);
  });

  it("retains a failed reply and failed seed's accepted evidence, then retries explicitly", async () => {
    const thread = threadFor("one");
    const draft = { ...draftFor(), commentThreads: [thread], feedbackSignals: [replyFor(thread).feedbackSignal] };
    const reply = vi.fn<Api["replyToResumeReviewComment"]>().mockRejectedValueOnce(new Error("reply offline")).mockResolvedValueOnce(replyFor(thread));
    const seed = vi.fn<Api["seedResumeReviewCommentThreads"]>().mockRejectedValueOnce(new Error("seed offline"))
      .mockResolvedValueOnce({ ok: true, draft, commentThreads: [thread], seededCount: 0, updatedCount: 1 });
    const hook = mount({ createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })), replyToResumeReviewComment: reply, seedResumeReviewCommentThreads: seed });
    await ready(hook);
    act(() => hook.result.current.seed([{ commentBody: "Question" }]));
    await waitFor(() => expect(hook.result.current.errors.seed).toBe("seed offline"));
    await act(async () => { expect(await hook.result.current.reply(thread, { body: "Clarification", decision: "clarified" })).toBe(false); });
    expect(hook.result.current.draft?.commentThreads).toEqual([thread]);
    expect(hook.result.current.draft?.feedbackSignals).toEqual(draft.feedbackSignals);
    act(() => hook.result.current.retrySeed());
    await waitFor(() => expect(hook.result.current.errors.seed).toBeUndefined());
    await act(async () => { expect(await hook.result.current.reply(thread, { body: "Clarification", decision: "clarified" })).toBe(true); });
    expect(hook.result.current.errors.reply).toBeUndefined();
    expect(hook.result.current.draft?.commentThreads[0]?.replies).toHaveLength(1);
  });

  it("does not acknowledge an older save over a higher canonical revision", async () => {
    const pending = deferred<Awaited<ReturnType<Api["saveResumeReviewDraftRevision"]>>>();
    const hook = mount({ saveResumeReviewDraftRevision: vi.fn(() => pending.promise) }); await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    let saving!: ReturnType<typeof hook.result.current.save>;
    act(() => { saving = hook.result.current.save(); });
    await waitFor(() => expect(hook.result.current.saving).toBe(true));
    const newer = draftFor(item, document("canonical C"), 3);
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: newer }));
    const older = draftFor(item, document("B"), 2);
    await act(async () => { pending.resolve({ ok: true, draft: older, revision: older.latestRevision! }); await saving; });
    expect(hook.result.current.document).toEqual(document("B"));
    expect(hook.result.current.draft?.currentRevisionId).toBe(newer.currentRevisionId);
    expect(hook.result.current.dirty).toBe(true);
  });

  it("waits for an already running render before approving exactly once", async () => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const hook = mount({ renderResumeReviewDraft: vi.fn(() => pending.promise) }); await ready(hook);
    act(() => { void hook.result.current.render(); });
    await waitFor(() => expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1));
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = hook.result.current.decide("approve_submit", "reviewed"); second = hook.result.current.decide("approve_submit", "duplicate"); });
    await act(async () => { pending.resolve(rendered(hook.draft)); await Promise.all([first, second]); });
    expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1);
    expect(hook.api.decideApplyReview).toHaveBeenCalledTimes(1);
  });

  it("does not substitute a previous accepted render for a failed in-flight refresh during approval", async () => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const render = vi.fn<Api["renderResumeReviewDraft"]>()
      .mockResolvedValueOnce(rendered(draftFor())).mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(rendered(draftFor()));
    const hook = mount({ renderResumeReviewDraft: render }); await ready(hook);
    await act(async () => { await hook.result.current.render(); });
    const accepted = hook.result.current.comparison;
    act(() => { void hook.result.current.render(); });
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    let decision!: Promise<void>;
    act(() => { decision = hook.result.current.decide("approve_submit", "reviewed"); });
    await act(async () => { pending.reject(new Error("refresh unavailable")); await decision; });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    expect(hook.result.current.comparison).toEqual(accepted);
    expect(hook.result.current.errors.render).toBe("refresh unavailable");
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(render).toHaveBeenCalledTimes(3);
    expect(hook.api.decideApplyReview).toHaveBeenCalledTimes(1);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it.each(["before settlement", "after settlement"])("keeps later edits and the same editor when its own render promotes the queue preview %s", async (promotion) => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const create = vi.fn<Api["createResumeReviewDraft"]>()
      .mockResolvedValueOnce({ ok: true, draft: draftFor() })
      .mockResolvedValue({ ok: true, draft: { ...draftFor(promotedItem(), document("A"), 1, "reopened"), baseGeneration: 2 } });
    const hook = mount({ createResumeReviewDraft: create, renderResumeReviewDraft: vi.fn(() => pending.promise) }); await ready(hook);
    const version = hook.result.current.documentVersion;
    let rendering!: ReturnType<typeof hook.result.current.render>;
    act(() => { rendering = hook.result.current.render(); });
    await waitFor(() => expect(hook.result.current.rendering).toBe(true));
    act(() => hook.result.current.edit(document("later edit", true)));
    if (promotion === "before settlement") {
      hook.rerender(promotedItem());
      act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: rendered(hook.draft).draft }));
    }
    await act(async () => { pending.resolve(rendered(hook.draft)); await rendering; });
    if (promotion === "after settlement") hook.rerender(promotedItem());
    expect(create).toHaveBeenCalledTimes(1);
    expect(hook.result.current.draft?.draftId).toBe(hook.draft.draftId);
    expect(hook.result.current.document).toEqual(document("later edit", true));
    expect(hook.result.current.documentVersion).toBe(version);
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.canSave).toBe(true);
    expect(hook.result.current.draft?.state).toBe("promoted");
    expect(hook.result.current.comparison).not.toBeNull();
  });

  it("blocks approval while a cached draft is being reloaded", async () => {
    const pending = deferred<Awaited<ReturnType<Api["createResumeReviewDraft"]>>>();
    const hook = mount({ createResumeReviewDraft: vi.fn(() => pending.promise) });
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), {
      ok: true, draft: hook.draft,
    }));
    await ready(hook);
    expect(hook.result.current.loading).toBe(true);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ ok: true, draft: hook.draft }); });
    expect(hook.result.current.loading).toBe(false);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.decideApplyReview).toHaveBeenCalledTimes(1);
  });

  it("rejects revision replacement and edits that arrive during canonical binding refresh", async () => {
    const queue = deferred<Awaited<ReturnType<Api["applyReviewQueue"]>>>();
    const hook = mount({ applyReviewQueue: vi.fn(() => queue.promise) }); await ready(hook);
    let approval!: Promise<void>;
    act(() => { approval = hook.result.current.decide("approve_submit", "reviewed"); });
    await waitFor(() => expect(hook.api.applyReviewQueue).toHaveBeenCalledTimes(1));
    await act(async () => { await hook.result.current.render(); });
    expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1);
    const newer = draftFor(item, document("canonical B"), 2);
    act(() => hook.queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, item.jobKey), { ok: true, draft: newer }));
    await act(async () => { queue.resolve({ ok: true, items: [promotedItem()] }); await approval; });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    expect(hook.result.current.errors.decision).toContain("changed");
  });

  it("retains successful rendering through canonical read failure and retryable decision conflict", async () => {
    const queue = vi.fn<Api["applyReviewQueue"]>().mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue({ ok: true, items: [promotedItem()] });
    const decision = vi.fn<Api["decideApplyReview"]>().mockRejectedValueOnce(new Error("HTTP 409: review conflict"))
      .mockResolvedValue({ ok: true, decision: { decisionId: "decision", jobKey: item.jobKey, decision: "approve_submit", reason: null, decidedBy: "user", decidedAt: time } });
    const hook = mount({ applyReviewQueue: queue, decideApplyReview: decision }); await ready(hook);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    const accepted = hook.result.current.comparison;
    expect(hook.result.current.errors.decision).toBe("queue unavailable");
    hook.rerender(promotedItem());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.result.current.errors.decision).toContain("409");
    expect(hook.result.current.comparison).toEqual(accepted);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.result.current.errors.decision).toBeUndefined();
    expect(decision).toHaveBeenCalledTimes(2);
    expect(hook.ports.api.applyJob).not.toHaveBeenCalled();
  });

  it("does not allow callbacks retained by a previous job or unmounted preparation to affect the new session", async () => {
    const pending = deferred<ResumeReviewDraftRenderResponse>();
    const hook = mount({ renderResumeReviewDraft: vi.fn(() => pending.promise) }); await ready(hook);
    const oldEdit = hook.result.current.edit;
    let preparation!: Promise<void>;
    act(() => { preparation = hook.result.current.decide("approve_submit", "reviewed"); });
    await waitFor(() => expect(hook.api.renderResumeReviewDraft).toHaveBeenCalledTimes(1));
    hook.rerender({ ...item, jobKey: "other-job" });
    act(() => oldEdit(document("stale edit")));
    expect(hook.result.current.document).toBeNull();
    hook.unmount();
    await act(async () => { pending.resolve(rendered(hook.draft)); await preparation; });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
  });

  it("permits explicit review retry for a clean saved edit whose interpretation failed", async () => {
    const next = draftFor(item, document("B"), 2);
    const save = vi.fn<Api["saveResumeReviewDraftRevision"]>()
      .mockResolvedValueOnce({ ok: true, draft: next, revision: next.latestRevision!, editIntent: { status: "unavailable", failureCode: "provider_unavailable" } })
      .mockResolvedValueOnce({ ok: true, draft: next, revision: next.latestRevision!, editIntent: { status: "accepted", determinationId: "synthetic-intent" } });
    const hook = mount({ saveResumeReviewDraftRevision: save }); await ready(hook);
    act(() => hook.result.current.edit(document("B")));
    await act(async () => { await hook.result.current.save(); });
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.canSave).toBe(true);
    expect(hook.result.current.canRender).toBe(false);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.save(); });
    expect(hook.result.current.errors.save).toBeUndefined();
    expect(hook.result.current.canRender).toBe(true);
  });

  it("blocks operations on unrelated material inputs and starts the next comparison from its own accepted source", async () => {
    let loadDraft = draftFor();
    const nextItem = { ...item, materialsPreview: { ...item.materialsPreview, resumeTextArtifactId: "unrelated-text", resumePdfArtifactId: "unrelated-pdf" } };
    const nextDraft = { ...draftFor(nextItem, document("C"), 1, "next-draft"), baseGeneration: 3 };
    const create = vi.fn<Api["createResumeReviewDraft"]>(async () => ({ ok: true, draft: loadDraft }));
    const render = vi.fn<Api["renderResumeReviewDraft"]>().mockResolvedValueOnce(rendered(loadDraft)).mockResolvedValueOnce(rendered(nextDraft));
    const hook = mount({ createResumeReviewDraft: create, renderResumeReviewDraft: render }); await ready(hook);
    await act(async () => { await hook.result.current.render(); });
    expect(hook.result.current.comparison?.acceptedArtifactId).toBe(item.materialsPreview.resumeTextArtifactId);
    loadDraft = nextDraft;
    hook.rerender(nextItem);
    await waitFor(() => expect(hook.result.current.draft?.draftId).toBe(nextDraft.draftId));
    expect(hook.result.current.comparison).toBeNull();
    await act(async () => { await hook.result.current.render(); });
    expect(hook.result.current.comparison?.acceptedArtifactId).toBe("unrelated-text");
  });

  it("keeps tenant/job identity structured when opaque IDs contain separators", async () => {
    const initial = { ...item, jobKey: "job:a" };
    const hook = mount({ createResumeReviewDraft: vi.fn(async (jobKey) => ({ ok: true as const, draft: draftFor({ ...item, jobKey }) })) }, initial);
    await ready(hook);
    const identity = hook.result.current.identity;
    act(() => hook.result.current.edit(document("tenant A edit")));
    Object.assign(hook.ports, { session: new FakeSessionPort({ tenantId: `${LOCAL_TENANT}:job` as TenantId, userId: null }) });
    hook.rerender({ ...item, jobKey: "a" });
    await waitFor(() => expect(hook.result.current.draft?.jobKey).toBe("a"));
    expect(hook.result.current.identity).not.toBe(identity);
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.document).toEqual(document("A"));
  });

  it("rejects changed artifact identities even when their generation counter is unchanged", async () => {
    const draft = { ...draftFor(), state: "promoted" as const };
    const canonical = { ...item, materialsPreview: { ...item.materialsPreview, resumePdfArtifactId: "different-pdf-same-generation" } };
    const hook = mount({ createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })),
      applyReviewQueue: vi.fn(async () => ({ ok: true as const, items: [canonical] })) });
    await ready(hook);
    await act(async () => { await hook.result.current.decide("approve_submit", "reviewed"); });
    expect(hook.api.renderResumeReviewDraft).not.toHaveBeenCalled();
    expect(hook.api.decideApplyReview).not.toHaveBeenCalled();
    expect(hook.result.current.errors.decision).toContain("inputs changed");
  });
});
