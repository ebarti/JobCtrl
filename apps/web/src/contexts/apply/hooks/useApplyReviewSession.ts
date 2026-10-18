import { useCallback, useEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Value } from "platejs";
import type {
  ApplyReviewDecisionValue, ApplyReviewQueueItem, ResumeCommentThread,
  ResumeCommentReplyDecision, ResumeReviewCommentThreadSeedInput,
  ResumeReviewDraft, ResumeReviewDraftResponse, ResumeReviewDraftRenderResponse,
} from "../../operations/types.js";
import { useResumeReviewDraftQuery } from "../../operations/hooks/useResumeReviewDraftQuery.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  isPlateValue, normalizeResumePlateValue, resumePlateValueSignature,
  resumeTextFromPlateValue,
} from "../../materials/lib/resume-document.js";
import {
  useApplyReviewDecisionMutation, useCreateResumeReviewDraftMutation,
  useSaveResumeReviewDraftRevisionMutation, useRenderResumeReviewDraftMutation,
  useReplyToResumeReviewCommentMutation, useSeedResumeReviewCommentThreadsMutation,
} from "./useApplyReviewMutations.js";
import { reconcileResumeReviewDraft, reconcileResumeReviewReply } from "./reconcileResumeReviewDraft.js";

type Operation = "load" | "save" | "render" | "seed" | "reply" | "decision";
type AcceptedRender = Extract<ResumeReviewDraftRenderResponse, { ok: true }>;
interface SessionState {
  key: string;
  item: ApplyReviewQueueItem;
  draft: ResumeReviewDraft | null;
  document: Value | null;
  baseline: string;
  documentVersion: number;
  editVersion: number;
  hasLocalEdits: boolean;
  submitted: string | null;
  pending: Map<Operation, number>;
  errors: Partial<Record<Operation, string>>;
  tail: Promise<unknown>;
  loadKey: string | null;
  seedKey: string | null;
  seedThreads: readonly ResumeReviewCommentThreadSeedInput[];
  accepted: { result: AcceptedRender; baselineArtifactId: string | null } | null;
  renderResult: ResumeReviewDraftRenderResponse | null;
  renderTask: Promise<ResumeReviewDraftRenderResponse | undefined> | null;
}

const signature = (value: Value | null) => resumePlateValueSignature(value);
const baseArtifact = (draft: ResumeReviewDraft) => draft.baseResumeTextArtifactId ?? draft.baseResumePdfArtifactId;
const draftIdentity = (draft: ResumeReviewDraft | null) => draft ? JSON.stringify([draft.draftId, draft.baseGeneration]) : null;
function acceptedMatchesItem(accepted: SessionState["accepted"], item: ApplyReviewQueueItem): boolean {
  if (!accepted) return false;
  const { result } = accepted;
  const preview = item.materialsPreview;
  return (preview.resumeTextArtifactId === baseArtifact(result.draft) && preview.resumePdfArtifactId === result.draft.baseResumePdfArtifactId)
    || (preview.resumeTextArtifactId === result.artifacts.resumeText.artifactId && preview.resumePdfArtifactId === result.artifacts.resumePdf.artifactId);
}
function draftMatchesItem(owner: SessionState): boolean {
  if (!owner.draft) return !owner.item.materialsPreview.resumePdfArtifactId;
  const preview = owner.item.materialsPreview;
  return (preview.resumeTextArtifactId === owner.draft.baseResumeTextArtifactId && preview.resumePdfArtifactId === owner.draft.baseResumePdfArtifactId)
    || (owner.accepted?.result.draft.draftId === owner.draft.draftId && acceptedMatchesItem(owner.accepted, owner.item));
}
const begin = (owner: SessionState, operation: Operation) => owner.pending.set(operation, (owner.pending.get(operation) ?? 0) + 1);
const finish = (owner: SessionState, operation: Operation) => {
  const remaining = (owner.pending.get(operation) ?? 1) - 1;
  if (remaining) owner.pending.set(operation, remaining);
  else owner.pending.delete(operation);
};
const dirty = (session: SessionState) => session.document !== null && signature(session.document) !== session.baseline;
const message = (error: unknown) => error instanceof Error ? error.message : "Request failed. Try again.";

/** Apply owns the mounted review session. Materials only renders its document. */
export function useApplyReviewSession(item: ApplyReviewQueueItem, autosaveDelayMs = 1500) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const query = useResumeReviewDraftQuery(item.jobKey, false);
  const create = useCreateResumeReviewDraftMutation();
  const saveMutation = useSaveResumeReviewDraftRevisionMutation();
  const renderMutation = useRenderResumeReviewDraftMutation();
  const seedMutation = useSeedResumeReviewCommentThreadsMutation();
  const replyMutation = useReplyToResumeReviewCommentMutation();
  const decisionMutation = useApplyReviewDecisionMutation();
  const [, update] = useReducer((n: number) => n + 1, 0);
  const current = useRef<SessionState | null>(null);
  const mounted = useRef(true);
  const key = JSON.stringify([tenantId, item.jobKey]);
  if (current.current?.key !== key) {
    current.current = {
      key, item, draft: null, document: null, baseline: signature(null), documentVersion: 0,
      editVersion: 0, hasLocalEdits: false, submitted: null, pending: new Map(), errors: {}, tail: Promise.resolve(),
      loadKey: null, seedKey: null, seedThreads: [], accepted: null, renderResult: null, renderTask: null,
    };
  }
  const session = current.current;
  session.item = item;
  const active = useCallback((owner: SessionState) => mounted.current && current.current === owner, []);
  const publish = useCallback((owner: SessionState) => { if (active(owner)) update(); }, [active]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const receive = useCallback((owner: SessionState, incoming: ResumeReviewDraft) => {
    if (!active(owner) || incoming.jobKey !== owner.item.jobKey) return;
    const previous = owner.draft;
    // Mutation responses also arrive through the shared query cache. On first
    // load, that path must obey the same source binding as the request callback.
    if (!previous && (incoming.baseResumeTextArtifactId !== owner.item.materialsPreview.resumeTextArtifactId
      || incoming.baseResumePdfArtifactId !== owner.item.materialsPreview.resumePdfArtifactId)) return;
    const next = reconcileResumeReviewDraft(previous ?? undefined, incoming);
    const replacement = draftIdentity(previous) !== draftIdentity(next);
    const savedValue = next.latestRevision?.plateDocument;
    const nextDocument = isPlateValue(savedValue) ? normalizeResumePlateValue(savedValue) : null;
    // An acknowledgement advances the saved baseline, never the live editor.
    // This includes undo-to-baseline while the write was in flight.
    if (replacement || previous?.currentRevisionId !== next.currentRevisionId) {
      owner.renderResult = null;
      delete owner.errors.render;
      if (replacement && previous) {
        owner.document = nextDocument;
        owner.baseline = signature(nextDocument);
        owner.documentVersion++;
        owner.editVersion++;
        owner.hasLocalEdits = false;
        owner.submitted = null;
        owner.errors = {};
        owner.renderResult = null;
        owner.seedKey = null;
      } else if (nextDocument) {
        const nextSignature = signature(nextDocument);
        if (!owner.hasLocalEdits) {
          if (signature(owner.document) !== nextSignature) owner.documentVersion++;
          owner.document = nextDocument;
        }
        owner.baseline = nextSignature;
        if (signature(owner.document) === nextSignature) owner.hasLocalEdits = false;
      }
    }
    owner.draft = next;
    publish(owner);
  }, [active, publish]);
  useEffect(() => {
    if (query.data) receive(session, query.data.draft);
  }, [query.data, receive, session, item.materialsPreview.resumeTextArtifactId, item.materialsPreview.resumePdfArtifactId]);

  const sync = useCallback((owner: SessionState) => {
    const cached = queryClient.getQueryData<ResumeReviewDraftResponse>(applyReviewKeys.draft(tenantId, owner.item.jobKey));
    if (cached) receive(owner, cached.draft);
  }, [queryClient, receive, tenantId]);

  // Document writes for one mounted session are ordered. Failures release the queue;
  // a request waiting in it must still belong to its initiating draft.
  const enqueue = useCallback(<T,>(owner: SessionState, operation: Operation, run: () => Promise<T>): Promise<T | undefined> => {
    begin(owner, operation);
    delete owner.errors[operation];
    publish(owner);
    const initiatingIdentity = draftIdentity(owner.draft);
    const initiatingRevision = owner.draft?.currentRevisionId;
    const task = owner.tail.catch(() => {}).then(async () => {
      if (!active(owner)) return undefined;
      try {
        if (draftIdentity(owner.draft) !== initiatingIdentity) return undefined;
        return await run();
      }
      catch (error) {
        if (active(owner) && draftIdentity(owner.draft) === initiatingIdentity
          && ((operation !== "render" && operation !== "save") || owner.draft?.currentRevisionId === initiatingRevision)) owner.errors[operation] = message(error);
        return undefined;
      } finally {
        finish(owner, operation);
        publish(owner);
      }
    });
    owner.tail = task;
    return task;
  }, [active, publish]);

  const load = useCallback(() => {
    const owner = session;
    if (!active(owner)) return;
    if (owner.pending.has("load") || owner.pending.has("render") || owner.pending.has("decision")) return;
    const preview = owner.item.materialsPreview;
    if (!preview.resumePdfArtifactId) return;
    const loadKey = JSON.stringify([preview.resumeTextArtifactId, preview.resumePdfArtifactId]);
    owner.loadKey = loadKey;
    // Loading must not wait behind a slow comment write. Results still reconcile.
    begin(owner, "load");
    delete owner.errors.load;
    publish(owner);
    void create.mutateAsync({ jobId: owner.item.jobKey, body: {
      rendererFormat: "html_css", resumePdfArtifactId: preview.resumePdfArtifactId,
      resumeTextArtifactId: preview.resumeTextArtifactId ?? undefined,
    } }).then(({ draft }) => {
      const currentPreview = owner.item.materialsPreview;
      if (active(owner) && owner.loadKey === loadKey
        && JSON.stringify([currentPreview.resumeTextArtifactId, currentPreview.resumePdfArtifactId]) === loadKey) receive(owner, draft);
    }).catch((error: unknown) => {
      if (active(owner) && owner.loadKey === loadKey) owner.errors.load = message(error);
    }).finally(() => { finish(owner, "load"); publish(owner); });
  }, [active, create.mutateAsync, publish, receive, session]);
  const loadKey = JSON.stringify([item.materialsPreview.resumeTextArtifactId, item.materialsPreview.resumePdfArtifactId]);
  const ownsPromotedPreview = session.accepted?.result.draft.draftId === session.draft?.draftId
    && session.accepted?.result.artifacts.resumeText.artifactId === item.materialsPreview.resumeTextArtifactId
    && session.accepted?.result.artifacts.resumePdf.artifactId === item.materialsPreview.resumePdfArtifactId;
  useEffect(() => {
    // A render promotes this session's output. Reopening that output would
    // create another draft and discard edits made while rendering the saved one.
    if (!ownsPromotedPreview && session.loadKey !== loadKey && !session.pending.has("load")) load();
  }, [load, loadKey, ownsPromotedPreview, session, session.pending.has("load"), session.pending.has("render"), session.pending.has("decision")]);

  const initializeDocument = useCallback((value: Value) => {
    const owner = session;
    if (!active(owner)) return;
    if (owner.document !== null) return;
    owner.document = normalizeResumePlateValue(value);
    owner.baseline = signature(owner.document);
    publish(owner);
  }, [active, publish, session]);
  const edit = useCallback((value: Value) => {
    const owner = session;
    if (!active(owner)) return;
    if (signature(owner.document) === signature(value)) return;
    owner.document = value;
    owner.editVersion++;
    owner.hasLocalEdits = true;
    // A new edit permits another autosave; failed identical attempts require
    // the explicit Save action, avoiding an uncontrolled retry loop.
    delete owner.errors.save;
    publish(owner);
  }, [active, publish, session]);
  const save = useCallback(() => {
    const owner = session;
    if (!active(owner)) return;
    const draft = owner.draft;
    if (!draft || !draftMatchesItem(owner) || !owner.document || (!dirty(owner) && !owner.errors.save) || owner.pending.has("save") || owner.pending.has("load")) return Promise.resolve(undefined);
    const value = normalizeResumePlateValue(owner.document);
    owner.submitted = signature(value);
    const identity = draftIdentity(draft);
    return enqueue(owner, "save", async () => {
      if (draftIdentity(owner.draft) !== identity) return;
      const response = await saveMutation.mutateAsync({ jobId: owner.item.jobKey, draftId: draft.draftId,
        body: { editedText: resumeTextFromPlateValue(value), plateDocument: value, editDeltas: [] } });
      if (!active(owner)) return;
      sync(owner);
      if (draftIdentity(owner.draft) !== identity) return;
      receive(owner, response.draft);
      if (response.editIntent?.status === "unavailable" && owner.draft?.currentRevisionId === response.revision.revisionId) {
        owner.errors.save = `Your edit is saved. Edit interpretation is unavailable (${response.editIntent.failureCode}); retry review before rendering.`;
      }
      return response;
    }).finally(() => { owner.submitted = null; });
  }, [active, enqueue, receive, saveMutation.mutateAsync, session, sync]);
  const seed = useCallback((threads: readonly ResumeReviewCommentThreadSeedInput[]) => {
    const owner = session;
    if (!active(owner)) return;
    const draft = owner.draft;
    const changed = owner.seedThreads !== threads;
    owner.seedThreads = threads;
    if (!draft || !threads.length || owner.pending.has("seed") || !draftMatchesItem(owner)) {
      if (changed) publish(owner);
      return;
    }
    const seedKey = JSON.stringify([draft.draftId, threads]);
    if (owner.seedKey === seedKey) return;
    owner.seedKey = seedKey;
    // Comments advance independently of document writes and may settle in any order.
    begin(owner, "seed");
    delete owner.errors.seed;
    publish(owner);
    void seedMutation.mutateAsync({ jobId: owner.item.jobKey, draftId: draft.draftId, body: { threads: [...threads] } })
      .then(({ draft: incoming }) => receive(owner, incoming))
      .catch((error: unknown) => { if (active(owner) && draftIdentity(owner.draft) === draftIdentity(draft)) { owner.errors.seed = message(error); owner.seedKey = null; } })
      .finally(() => { finish(owner, "seed"); publish(owner); });
  }, [active, publish, receive, seedMutation.mutateAsync, session]);
  useEffect(() => {
    if (!session.errors.seed) seed(session.seedThreads);
  }, [seed, session, session.draft?.draftId, session.pending.has("seed"), session.seedThreads]);
  const retrySeed = useCallback(() => {
    const owner = session;
    if (!active(owner)) return;
    owner.seedKey = null;
    seed(owner.seedThreads);
  }, [active, seed, session]);
  const reply = useCallback((thread: ResumeCommentThread, input: { body: string; decision: ResumeCommentReplyDecision }) => {
    const owner = session;
    if (!active(owner)) return;
    const identity = draftIdentity(owner.draft);
    const revision = owner.draft?.currentRevisionId;
    if (thread.draftId !== owner.draft?.draftId) return;
    begin(owner, "reply");
    delete owner.errors.reply;
    publish(owner);
    return replyMutation.mutateAsync({ jobId: owner.item.jobKey, threadId: thread.threadId,
      body: { ...input, author: "user", draftRevisionId: revision ?? undefined } })
      .then((response) => {
        if (active(owner) && owner.draft) receive(owner, reconcileResumeReviewReply(owner.draft, response));
        return true;
      }).catch((error: unknown) => {
        if (active(owner) && draftIdentity(owner.draft) === identity) owner.errors.reply = message(error);
        return false;
      }).finally(() => { finish(owner, "reply"); publish(owner); });
  }, [active, publish, receive, replyMutation.mutateAsync, session]);

  const renderSavedRevision = useCallback(() => {
    const owner = session;
    if (!active(owner)) return;
    const draft = owner.draft;
    if (!draft?.currentRevisionId || !draftMatchesItem(owner) || owner.errors.save || dirty(owner) || owner.pending.has("save") || owner.pending.has("render") || owner.pending.has("load")) return Promise.resolve(undefined);
    const identity = draftIdentity(draft);
    const revision = draft.currentRevisionId;
    const editVersion = owner.editVersion;
    const baselineArtifactId = acceptedMatchesItem(owner.accepted, owner.item) ? owner.accepted!.baselineArtifactId : baseArtifact(draft);
    const task = enqueue(owner, "render", async () => {
      if (draftIdentity(owner.draft) !== identity || owner.draft?.currentRevisionId !== revision || owner.editVersion !== editVersion) return;
      const result = await renderMutation.mutateAsync({ jobId: owner.item.jobKey, draftId: draft.draftId,
        body: { draftRevisionId: revision } });
      if (!active(owner)) return;
      sync(owner);
      if (draftIdentity(owner.draft) !== identity || owner.draft?.currentRevisionId !== revision) return;
      receive(owner, result.draft);
      owner.renderResult = result;
      if (result.ok) owner.accepted = {
        result, baselineArtifactId,
      };
      return result;
    });
    owner.renderTask = task;
    return task;
  }, [active, enqueue, receive, renderMutation.mutateAsync, session, sync]);

  const render = useCallback(() => session.pending.has("decision") ? Promise.resolve(undefined) : renderSavedRevision(), [renderSavedRevision, session]);

  const decide = useCallback(async (value: ApplyReviewDecisionValue, reason: string, partialOverrideRunId?: string) => {
    const owner = session;
    if (!active(owner)) return;
    if (owner.pending.has("decision")) return;
    const identity = draftIdentity(owner.draft);
    const editVersion = owner.editVersion;
    const approving = value.startsWith("approve_");
    const initialItem = owner.item;
    let preparedRender: AcceptedRender | undefined;
    const waitingForRender = owner.pending.has("render") ? owner.renderTask : null;
    const waitingForSave = owner.pending.has("save");
    let expectedRevision = owner.draft?.currentRevisionId;
    const stillCurrent = () => {
      if (!active(owner)) return false;
      sync(owner);
      return draftIdentity(owner.draft) === identity && owner.editVersion === editVersion && !dirty(owner)
        && !owner.pending.has("load") && owner.draft?.currentRevisionId === expectedRevision && draftMatchesItem(owner);
    };
    begin(owner, "decision");
    delete owner.errors.decision;
    publish(owner);
    try {
      if (approving) {
        await owner.tail;
        if (waitingForSave) expectedRevision = owner.draft?.currentRevisionId;
        if (waitingForRender) {
          const result = await waitingForRender;
          if (!result?.ok) return;
          preparedRender = result;
        }
        if (!stillCurrent()) throw new Error("Review changed during preparation. Review the current draft and try again.");
        if (owner.errors.save || owner.errors.load) throw new Error(owner.errors.save ?? owner.errors.load);
        if (owner.draft?.latestRevision && (owner.draft.state === "active" || owner.errors.render)) {
          const result = await renderSavedRevision();
          if (!stillCurrent()) throw new Error("Review changed during preparation. Review the current draft and try again.");
          if (!result?.ok) return;
          preparedRender = result;
        }
        if (owner.renderResult && !owner.renderResult.ok) return;
      }
      // Read canonical bindings after preparation. Never send a pre-render
      // materials generation, profile version, URL or email candidate.
      const queue = approving ? await queryClient.fetchQuery({
        queryKey: applyReviewKeys.queue(tenantId), queryFn: () => api.applyReviewQueue(), staleTime: 0,
      }) : null;
      if (!active(owner)) return;
      if (approving && !stillCurrent()) throw new Error("Review changed during preparation. Review the current draft and try again.");
      const canonical = queue?.items.find((entry) => entry.jobKey === owner.item.jobKey) ?? (approving ? null : owner.item);
      if (!canonical) throw new Error("Review inputs changed. Reload the review queue and try again.");
      if (approving && (
        canonical.approvalGate.profileVersion !== initialItem.approvalGate.profileVersion
        || canonical.approvalGate.applicationUrl !== initialItem.approvalGate.applicationUrl
        || canonical.emailApplication?.recipient !== initialItem.emailApplication?.recipient
        || (canonical.emailApplication?.attachmentArtifactId !== initialItem.emailApplication?.attachmentArtifactId
          && canonical.emailApplication?.attachmentArtifactId !== preparedRender?.artifacts.resumePdf.artifactId)
        || (!preparedRender && (canonical.approvalGate.materialsGeneration !== initialItem.approvalGate.materialsGeneration
          || canonical.materialsPreview.resumeTextArtifactId !== initialItem.materialsPreview.resumeTextArtifactId
          || canonical.materialsPreview.resumePdfArtifactId !== initialItem.materialsPreview.resumePdfArtifactId))
      )) throw new Error("Approval inputs changed during preparation. Review the current inputs and try again.");
      if (value === "approve_submit") {
        const repeat = canonical.repeatApplication.status;
        if (repeat !== "clear" && repeat !== "override_ready") throw new Error(canonical.repeatApplication.summary);
        if (partialOverrideRunId ? canonical.approvalGate.partialDryRunEvidence?.runId !== partialOverrideRunId : !canonical.approvalGate.dryRunEvidence) {
          throw new Error("Dry-run evidence changed. Review the current evidence before authorizing.");
        }
      }
      const accepted = preparedRender;
      if (approving && accepted && (canonical.materialsPreview.resumeTextArtifactId !== accepted.artifacts.resumeText.artifactId
        || canonical.materialsPreview.resumePdfArtifactId !== accepted.artifacts.resumePdf.artifactId)) {
        throw new Error("Rendered materials are not current in the review queue. Refresh and try again.");
      }
      await decisionMutation.mutateAsync({ jobId: canonical.jobKey, body: {
        decision: value, reason, decidedBy: "user",
        ...(value === "approve_submit" ? {
          materialsGeneration: canonical.approvalGate.materialsGeneration,
          profileVersion: canonical.approvalGate.profileVersion,
          applicationUrl: canonical.approvalGate.applicationUrl,
          ...(canonical.emailApplication ? { emailRecipient: canonical.emailApplication.recipient,
            emailAttachmentArtifactId: canonical.emailApplication.attachmentArtifactId } : {}),
        } : {}),
        ...(partialOverrideRunId ? { partialOverrideRunId } : {}),
      } });
    } catch (error) { if (active(owner)) owner.errors.decision = message(error); }
    finally { finish(owner, "decision"); publish(owner); }
  }, [active, api, decisionMutation.mutateAsync, publish, queryClient, renderSavedRevision, session, sync, tenantId]);

  const documentSignature = signature(session.document);
  const isDirty = dirty(session);
  const saving = session.pending.has("save");
  const loading = session.pending.has("load") || (!session.loadKey && Boolean(item.materialsPreview.resumePdfArtifactId));
  const sourceChanged = !draftMatchesItem(session);
  const canSave = Boolean(session.draft && session.document && (isDirty || session.errors.save) && !saving && !loading && !sourceChanged);
  useEffect(() => {
    // Recovery can restore eligibility without changing the document or revision.
    if (!autosaveDelayMs || !isDirty || !canSave || session.errors.save) return;
    const timer = window.setTimeout(() => { void save(); }, autosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [autosaveDelayMs, canSave, documentSignature, isDirty, save, session, session.draft?.draftId, session.errors.save]);
  const rendered = session.draft?.state === "rendered" || session.draft?.state === "promoted";
  const needsRender = Boolean(session.draft?.latestRevision && !rendered);
  const rendering = session.pending.has("render");
  const reason = isDirty || saving ? "Save and render the edited resume before approval."
    : loading || session.errors.load || sourceChanged ? "Load the resume draft before approval."
    : rendering ? "Rendering saved resume draft before approval."
    : session.renderResult && !session.renderResult.ok ? "Resolve draft validation errors before approval."
    : session.errors.render && needsRender ? "Resume render failed; retry render before approval."
    : session.errors.save ?? null;
  const notice = needsRender && !reason ? "Saved draft will render automatically before approval." : null;
  const accepted = session.accepted;
  const comparisonMatches = accepted && acceptedMatchesItem(accepted, item);
  return {
    identity: key, draft: session.draft, document: session.document, documentVersion: `${key}:${session.documentVersion}`,
    canSave,
    canRender: Boolean(session.draft?.latestRevision && !isDirty && !saving && !rendering && !loading && !session.errors.save && !sourceChanged && !session.pending.has("decision")),
    dirty: isDirty, loading, saving, rendering, replying: session.pending.has("reply"),
    preparing: session.pending.has("decision"), errors: session.errors,
    renderResult: session.renderResult, reason, notice,
    status: loading ? session.draft ? "refreshing draft" : "loading draft" : rendering ? "rendering saved draft" : saving ? "saving draft"
      : session.errors.save || session.errors.load || session.errors.render || (session.renderResult && !session.renderResult.ok) ? "draft save issue"
      : isDirty ? "unsaved changes" : rendered ? "replacement rendered"
      : session.draft?.latestRevision ? `saved revision ${session.draft.latestRevision.revisionNumber}` : session.draft ? "draft ready" : "draft unavailable",
    comparison: comparisonMatches ? { acceptedArtifactId: accepted.baselineArtifactId,
      artifactId: accepted.result.artifacts.resumeText.artifactId,
      riskLabels: [...new Set((session.draft?.draftId === accepted.result.draft.draftId ? session.draft : accepted.result.draft).commentThreads.flatMap((thread) => thread.riskLabel ? [thread.riskLabel] : []))],
    } : null,
    initializeDocument, edit, save, render, seed, reply, decide, retrySeed, retryLoad: load,
  };
}

export type ApplyReviewSession = ReturnType<typeof useApplyReviewSession>;
