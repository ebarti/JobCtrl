import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { COVER_LETTER_RENDERER_VERSION, DEFAULT_COVER_LETTER_SETTINGS, type ApplyReviewQueueItem, type CoverLetterAccepted, type CoverLetterPreview, type CoverLetterRenderRequest } from "@jobctrl/contracts";
import { sampleApplyReviewQueue } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts, FakeSessionPort } from "../../../test/testPorts.js";
import type { TenantId } from "@jobctrl/domain-types";
import { useCoverLetterReview } from "./useCoverLetterReview.js";

const base: CoverLetterAccepted = {
  source: { tenantId: "local", jobId: sampleApplyReviewQueue.items[0]!.jobKey, artifactId: "cover-source", generation: 1, textSha256: "a".repeat(64) },
  acceptedVersion: "b".repeat(64), pdfArtifactId: "accepted-cover", pdfSha256: "c".repeat(64),
  pdfSourceCurrent: true,
  settings: DEFAULT_COVER_LETTER_SETTINGS, rendererVersion: COVER_LETTER_RENDERER_VERSION,
};
const item = (accepted = base): ApplyReviewQueueItem => ({ ...sampleApplyReviewQueue.items[0]!, jobKey: accepted.source.jobId,
  materialsPreview: { ...sampleApplyReviewQueue.items[0]!.materialsPreview, coverLetter: accepted } });
const preview = (body: CoverLetterRenderRequest, id = "00000000-0000-4000-8000-000000001042"): CoverLetterPreview => ({
  ...body, previewId: id, rendererVersion: COVER_LETTER_RENDERER_VERSION, pdfSha256: "d".repeat(64),
});
function deferred<T>() { let resolve!: (data: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function mount(overrides: Parameters<typeof buildTestPorts>[0] = {}) {
  const render = vi.fn(async (_jobId: string, body: CoverLetterRenderRequest) => ({ ok: true as const, preview: preview(body) }));
  const save = vi.fn(async () => ({ ok: true as const, accepted: { ...base, pdfSha256: "d".repeat(64), acceptedVersion: "e".repeat(64), settings: { ...base.settings, fontSizePt: 12 } } }));
  const ports = buildTestPorts({ ...overrides, api: { renderCoverLetterPreview: render, acceptCoverLetterPreview: save, ...overrides.api } });
  const hook = renderHookWithProviders((row: ApplyReviewQueueItem) => useCoverLetterReview(row), { ports, initialProps: item() });
  return { ...hook, render, save };
}
describe("cover-letter review session", () => {
  it("requires accepting different preview bytes even with unchanged settings; restore returns to accepted PDF", async () => {
    const hook = mount();
    await act(() => hook.result.current.renderPreview());
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.readyForApproval()).toBe(false);
    expect(hook.result.current.accepted).toEqual(base);
    act(() => hook.result.current.restoreAccepted());
    expect(hook.result.current.url).toContain("accepted-cover");
    expect(hook.result.current.preview).toBeNull();
    expect(hook.result.current.readyForApproval()).toBe(true);
  });
  it.each(["before", "after", "lost", "after-lost"])("retains an undo when canonical refresh arrives %s acknowledgement", async order => {
    const pending = deferred<{ ok: true; accepted: CoverLetterAccepted }>();
    const hook = mount({ api: { acceptCoverLetterPreview: vi.fn(() => pending.promise) } });
    const saved = { ...base, pdfSha256: "d".repeat(64), acceptedVersion: "e".repeat(64), settings: { ...base.settings, fontSizePt: 12 } };
    act(() => hook.result.current.editSettings(saved.settings));
    await act(() => hook.result.current.renderPreview());
    let task!: Promise<void>;
    act(() => { task = hook.result.current.savePreview(); });
    act(() => hook.result.current.editSettings(base.settings));
    if (order === "before" || order === "lost") hook.rerender(item(saved));
    await act(async () => {
      if (order === "lost" || order === "after-lost") pending.reject(new Error("lost acknowledgement"));
      else pending.resolve({ ok: true, accepted: saved });
      await task;
    });
    hook.rerender(item(saved));
    expect(hook.result.current.accepted).toEqual(saved);
    expect(hook.result.current.settings).toEqual(base.settings);
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.readyForApproval()).toBe(false);
    expect(hook.result.current.error).toBeNull();
    hook.rerender(item()); // An obsolete query snapshot cannot roll back acceptance.
    expect(hook.result.current.accepted).toEqual(saved);
    expect(hook.result.current.settings).toEqual(base.settings);
  });
  it("retains accepted PDF and local edits when source availability changes without a version change", () => {
    const hook = mount();
    act(() => hook.result.current.editSettings({...base.settings,fontSizePt:13}));
    hook.rerender(item({...base,pdfSourceCurrent:false}));
    expect(hook.result.current.url).toContain("accepted-cover");
    expect(hook.result.current.settings.fontSizePt).toBe(13);
    expect(hook.result.current.readyForApproval()).toBe(false);
    expect(hook.result.current.accepted?.pdfSourceCurrent).toBe(false);
  });
  it("keeps opening and editing local; only explicit save accepts the rendered snapshot", async () => {
    const hook = mount();
    expect(hook.result.current.url).toContain("accepted-cover");
    expect(hook.render).not.toHaveBeenCalled(); expect(hook.save).not.toHaveBeenCalled();
    act(() => hook.result.current.editSettings({ ...base.settings, fontSizePt: 12 }));
    expect(hook.result.current.accepted).toEqual(base);
    await act(() => hook.result.current.renderPreview());
    expect(hook.result.current.canSave).toBe(true);
    expect(hook.save).not.toHaveBeenCalled();
    expect(hook.result.current.url).toContain("cover-letter/previews/");
    await act(() => hook.result.current.savePreview());
    expect(hook.result.current.accepted?.acceptedVersion).toBe("e".repeat(64));
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.canSave).toBe(false);
  });

  it.each(["success", "failure"])("fences reversed render responses and late %s after edits", async outcome => {
    const a = deferred<{ ok: true; preview: CoverLetterPreview }>();
    const b = deferred<{ ok: true; preview: CoverLetterPreview }>();
    const render = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const hook = mount({ api: { renderCoverLetterPreview: render } });
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = hook.result.current.renderPreview(); });
    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.editSettings({ ...base.settings, paper: "A4" }));
    act(() => { second = hook.result.current.renderPreview(); });
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    const newest = preview(render.mock.calls[1]![1], "00000000-0000-4000-8000-000000001043");
    await act(async () => { b.resolve({ ok: true, preview: newest }); await second; });
    await act(async () => {
      if (outcome === "failure") a.reject(new Error("old failure"));
      else a.resolve({ok:true,preview:preview(render.mock.calls[0]![1])});
      await first;
    });
    expect(hook.result.current.preview).toEqual(newest);
    expect(hook.result.current.error).toBeNull();
  });

  it.each(["success", "failure"])("retains edits during save %s and suppresses duplicate saves", async outcome => {
    const pending = deferred<{ ok: true; accepted: CoverLetterAccepted }>();
    const save = vi.fn(() => pending.promise);
    const hook = mount({ api: { acceptCoverLetterPreview: save } });
    act(() => hook.result.current.editSettings({ ...base.settings, fontSizePt: 12 }));
    await act(() => hook.result.current.renderPreview());
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.savePreview(); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(() => hook.result.current.savePreview());
    act(() => hook.result.current.editSettings({ ...base.settings, fontSizePt: 13 }));
    await act(async () => {
      if (outcome === "success") pending.resolve({ ok: true, accepted: { ...base, pdfSha256: "d".repeat(64), acceptedVersion: "e".repeat(64), settings: { ...base.settings, fontSizePt: 12 } } });
      else pending.reject(new Error("save failed"));
      await saving;
    });
    expect(hook.result.current.settings.fontSizePt).toBe(13);
    expect(hook.result.current.dirty).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(hook.result.current.accepted?.settings.fontSizePt).toBe(outcome === "success" ? 12 : 11);
  });

  it.each(["source", "job", "tenant"])("discards late renders after a %s switch, including same-generation source changes", async change => {
    const pending = deferred<{ ok: true; preview: CoverLetterPreview }>();
    const render = vi.fn(() => pending.promise);
    const hook = mount({ api: { renderCoverLetterPreview: render } });
    let task!: Promise<void>;
    act(() => { task = hook.result.current.renderPreview(); });
    await waitFor(() => expect(render).toHaveBeenCalled());
    if (change === "tenant") Object.assign(hook.ports, { session: new FakeSessionPort({ tenantId: "other" as TenantId, userId: null }) });
    const next = { ...base, source: { ...base.source, ...(change === "job" ? { jobId: "other-job" } : change === "tenant" ? { tenantId: "other" } : { textSha256: "f".repeat(64) }) } };
    hook.rerender(item(next));
    await act(async () => { pending.resolve({ ok: true, preview: preview({ source: base.source, expectedAcceptedVersion: base.acceptedVersion, settings: base.settings }) }); await task; });
    expect(hook.result.current.preview).toBeNull();
    expect(hook.result.current.accepted?.source).toEqual(next.source);
  });

  it.each(["source", "job", "tenant", "unmount"])("discards save acknowledgements/errors after %s changes", async change => {
    for (const outcome of ["success", "failure"]) {
      const pending = deferred<{ok:true;accepted:CoverLetterAccepted}>();
      const hook = mount({api:{acceptCoverLetterPreview:vi.fn(() => pending.promise)}});
      act(() => hook.result.current.editSettings({...base.settings,fontSizePt:12}));
      await act(() => hook.result.current.renderPreview());
      let task!: Promise<void>;
      act(() => { task = hook.result.current.savePreview(); });
      if (change === "tenant") Object.assign(hook.ports,{session:new FakeSessionPort({tenantId:"other" as TenantId,userId:null})});
      const next = {...base,source:{...base.source,...(change === "job" ? {jobId:"other-job"} : change === "tenant" ? {tenantId:"other"} : {textSha256:"f".repeat(64)})}};
      if (change === "unmount") hook.unmount();
      else hook.rerender(item(next));
      await act(async () => {
        if (outcome === "success") pending.resolve({ok:true,accepted:{...base,pdfSha256:"d".repeat(64),acceptedVersion:"e".repeat(64),settings:{...base.settings,fontSizePt:12}}});
        else pending.reject(new Error("old save failed"));
        await task;
      });
      expect(hook.result.current.accepted).toEqual(change === "unmount" ? base : next);
      expect(hook.result.current.error).toBeNull();
      if (change !== "unmount") expect(hook.result.current.saving).toBe(false);
      hook.unmount();
    }
  });

  it("keeps the accepted PDF after render failure and refuses invalid settings", async () => {
    const render = vi.fn(async () => { throw new Error("RPC failed"); });
    const hook = mount({ api: { renderCoverLetterPreview: render } });
    await act(() => hook.result.current.renderPreview());
    expect(hook.result.current.url).toContain("accepted-cover");
    expect(hook.result.current.accepted).toEqual(base);
    act(() => hook.result.current.editSettings({ ...base.settings, marginMm: Number.NaN }));
    await act(() => hook.result.current.renderPreview());
    expect(render).toHaveBeenCalledTimes(1);
    expect(hook.result.current.valid).toBe(false);
  });

  it("ignores an acknowledgement after unmount", async () => {
    const pending = deferred<{ ok: true; preview: CoverLetterPreview }>();
    const render = vi.fn(() => pending.promise);
    const hook = mount({ api: { renderCoverLetterPreview: render } });
    let task!: Promise<void>;
    act(() => { task = hook.result.current.renderPreview(); });
    await waitFor(() => expect(render).toHaveBeenCalled());
    hook.unmount();
    await act(async () => { pending.resolve({ ok: true, preview: preview({ source: base.source, expectedAcceptedVersion: base.acceptedVersion, settings: base.settings }) }); await task; });
    expect(hook.result.current.preview).toBeNull();
  });
});
