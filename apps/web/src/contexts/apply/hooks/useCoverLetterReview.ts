import { useCallback, useEffect, useReducer, useRef } from "react";
import { CoverLetterSettingsSchema, DEFAULT_COVER_LETTER_SETTINGS, type ApplyReviewQueueItem, type CoverLetterAccepted, type CoverLetterPreview, type CoverLetterSettings } from "@jobctrl/contracts";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useCoverLetterMutations } from "./useApplyReviewMutations.js";

const signature = (settings: CoverLetterSettings) => JSON.stringify(CoverLetterSettingsSchema.safeParse(settings).data ?? settings);
interface State {
  key: string; accepted: CoverLetterAccepted | null; propVersion: string | null;
  settings: CoverLetterSettings; preview: CoverLetterPreview | null;
  edit: number; request: number; rendering: boolean; saving: boolean; error: string | null;
  submittedEdit: number | null; retiredVersions: Set<string>;
  uncertainSave: boolean;
}
/** All async publications belong to the initiating tenant/job/source/edit. */
export function useCoverLetterReview(item: ApplyReviewQueueItem) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const { render, save } = useCoverLetterMutations();
  const [, update] = useReducer(n => n + 1, 0);
  const current = useRef<State | null>(null);
  const mounted = useRef(true);
  const incoming = item.materialsPreview.coverLetter ?? null;
  const unavailableReason = item.materialsPreview.coverLetterPdfError ?? null;
  const key = JSON.stringify([tenantId, item.jobKey, incoming?.source]);
  if (current.current?.key !== key) current.current = {
    key, accepted: incoming, propVersion: incoming?.acceptedVersion ?? null,
    settings: incoming?.settings ?? DEFAULT_COVER_LETTER_SETTINGS, preview: null,
    edit: 0, request: 0, rendering: false, saving: false, error: null,
    submittedEdit: null, retiredVersions: new Set(),
    uncertainSave: false,
  };
  const owner = current.current;
  if (incoming && incoming.acceptedVersion === owner.accepted?.acceptedVersion
    && incoming.pdfSourceCurrent !== owner.accepted.pdfSourceCurrent) owner.accepted = incoming;
  if (incoming && owner.propVersion !== incoming.acceptedVersion && !owner.retiredVersions.has(incoming.acceptedVersion)) {
    const clean = owner.submittedEdit !== null ? owner.edit === owner.submittedEdit
      : signature(owner.settings) === signature(owner.accepted?.settings ?? DEFAULT_COVER_LETTER_SETTINGS);
    if (owner.accepted && owner.accepted.acceptedVersion !== incoming.acceptedVersion) owner.retiredVersions.add(owner.accepted.acceptedVersion);
    owner.propVersion = incoming.acceptedVersion;
    owner.accepted = incoming;
    if (clean) owner.settings = incoming.settings;
    owner.preview = null;
    owner.error = null;
    owner.uncertainSave = false;
    owner.request++;
    owner.rendering = false;
  }
  const active = useCallback((state: State) => mounted.current && current.current === state, []);
  const publish = useCallback((state: State) => { if (active(state)) update(); }, [active]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const editSettings = useCallback((settings: CoverLetterSettings) => {
    owner.settings = settings;
    owner.edit++;
    owner.request++;
    owner.rendering = false;
    owner.error = null;
    publish(owner);
  }, [owner, publish]);
  const restoreAccepted = useCallback(() => {
    if (!active(owner) || !owner.accepted) return;
    owner.preview = null;
    editSettings(owner.accepted.settings);
  }, [active, editSettings, owner]);
  const renderPreview = useCallback(async () => {
    const parsed = CoverLetterSettingsSchema.safeParse(owner.settings);
    const accepted = owner.accepted;
    if (!active(owner) || !accepted || !parsed.success || owner.saving) return;
    const request = ++owner.request;
    owner.rendering = true; owner.error = null; publish(owner);
    try {
      const result = await render.mutateAsync({ jobId: item.jobKey, body: {
        source: accepted.source, expectedAcceptedVersion: accepted.acceptedVersion, settings: parsed.data,
      } });
      if (JSON.stringify(result.preview.source) !== JSON.stringify(accepted.source)
        || result.preview.expectedAcceptedVersion !== accepted.acceptedVersion
        || signature(result.preview.settings) !== signature(parsed.data)) throw new Error("Cover-letter preview identity changed. Reload and retry.");
      if (active(owner) && owner.request === request && owner.accepted?.acceptedVersion === accepted.acceptedVersion) owner.preview = result.preview;
    } catch (error) {
      if (active(owner) && owner.request === request) owner.error = error instanceof Error ? error.message : "Cover-letter rendering failed. Retry the preview.";
    } finally {
      if (owner.request === request) owner.rendering = false;
      publish(owner);
    }
  }, [active, item.jobKey, owner, publish, render.mutateAsync]);
  const savePreview = useCallback(async () => {
    const preview = owner.preview;
    if (!active(owner) || !preview || owner.saving || owner.rendering
      || preview.expectedAcceptedVersion !== owner.accepted?.acceptedVersion
      || signature(owner.settings) !== signature(preview.settings)) return;
    const submittedEdit = owner.edit;
    owner.submittedEdit = submittedEdit;
    owner.uncertainSave = false;
    owner.saving = true; owner.error = null; publish(owner);
    try {
      const result = await save.mutateAsync({ jobId: item.jobKey, body: {
        previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion,
      } });
      if (JSON.stringify(result.accepted.source) !== JSON.stringify(preview.source)
        || result.accepted.pdfSha256 !== preview.pdfSha256
        || signature(result.accepted.settings) !== signature(preview.settings)
        || result.accepted.rendererVersion !== preview.rendererVersion) throw new Error("Cover-letter save identity changed. Reload to reconcile the accepted version.");
      if (active(owner) && owner.accepted?.acceptedVersion === preview.expectedAcceptedVersion) {
        owner.retiredVersions.add(preview.expectedAcceptedVersion);
        owner.accepted = result.accepted;
        owner.preview = null;
        // Acknowledgement advances acceptance only; edits made while saving
        // remain local, even when the user has undone to an earlier value.
      }
    } catch (error) {
      if (active(owner) && owner.accepted?.acceptedVersion === preview.expectedAcceptedVersion) {
        // A transport failure may follow a committed write. Retain the edit
        // fence until a canonical refresh reconciles that uncertain result.
        owner.uncertainSave = true;
        if (owner.edit === submittedEdit) owner.error = error instanceof Error ? error.message : "Saving failed. Reload to reconcile, or retry this preview.";
      }
    } finally { owner.saving = false; if (!owner.uncertainSave) owner.submittedEdit = null; publish(owner); }
  }, [active, item.jobKey, owner, publish, save.mutateAsync]);
  const previewCurrent = Boolean(owner.preview && owner.preview.expectedAcceptedVersion === owner.accepted?.acceptedVersion && signature(owner.preview.settings) === signature(owner.settings));
  const dirty = Boolean(owner.accepted && signature(owner.settings) !== signature(owner.accepted.settings));
  const unacceptedPreview = () => Boolean(owner.preview && owner.preview.pdfSha256 !== owner.accepted?.pdfSha256);
  const url = owner.preview ? api.coverLetterPreviewPdfUrl(item.jobKey, owner.preview.previewId)
    : owner.accepted?.pdfArtifactId ? api.artifactPreviewPdfUrl(owner.accepted.pdfArtifactId, owner.accepted.pdfSha256 ?? owner.accepted.acceptedVersion) : null;
  return {
    identity: key, available: Boolean(owner.accepted), unavailableReason, accepted: owner.accepted, settings: owner.settings,
    preview: owner.preview, previewCurrent, dirty, rendering: owner.rendering, saving: owner.saving, error: owner.error, url,
    valid: CoverLetterSettingsSchema.safeParse(owner.settings).success,
    canSave: previewCurrent && !owner.saving && !owner.rendering,
    readyForApproval: () => active(owner) && !unavailableReason && !owner.saving && !owner.rendering && !owner.uncertainSave && !unacceptedPreview()
      && (!owner.accepted || (owner.accepted.pdfSourceCurrent && signature(owner.settings) === signature(owner.accepted.settings))),
    approvalReason: unavailableReason ?? (owner.saving || owner.rendering ? "Wait for the cover-letter operation before approval."
      : owner.uncertainSave ? "Reload to reconcile the cover-letter save before approval."
      : owner.accepted && !owner.accepted.pdfSourceCurrent ? "Render and save a PDF for the current cover-letter source before approval."
      : unacceptedPreview() ? "Save the displayed cover-letter preview or restore the accepted PDF before approval."
      : dirty ? "Save the cover-letter preview or restore accepted settings before approval." : null),
    editSettings, restoreAccepted, renderPreview, savePreview,
  };
}
export type CoverLetterReview = ReturnType<typeof useCoverLetterReview>;
