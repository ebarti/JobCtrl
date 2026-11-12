import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  ResumeStandalonePlateEditor,
  type ResumePlateSemanticTextChange,
} from "../../materials/components/ResumeStandalonePlateEditor.js";
import {
  ProfileForm,
  type ProfilePlateTextController,
} from "../forms/profile-form.js";
import { ProfileImportReview } from "./ProfileImportReview.js";
import { ProfileTransferExport } from "./ProfileTransferExport.js";
import { ProfileRecoveryPanel } from "./ProfileRecoveryPanel.js";
import type { ProfileActiveSection } from "./StructuredProfileEditor.js";
import { useProfilePlateRecovery } from "../hooks/useProfilePlateRecovery.js";
import { useProfileHtmlPreviewUrl } from "../hooks/useProfileHtmlPreviewUrl.js";
import { profileHtmlPreviewPath } from "../client.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";
import { useResumeTemplatesQuery } from "../hooks/useResumeTemplatesQuery.js";
import { bindProfilePreviewFields } from "../lib/profile-preview-fields.js";
import {
  resolveEffectiveResumeTemplateVersion,
  resumeTemplatePreviewStyle,
  ResumeTemplatePanel,
} from "./ResumeTemplatePanel.js";
import {
  profileSessionIdentity,
  useProfileDraftGeneration,
} from "../lib/profile-draft-state.js";
import "../../../styles/redesign-profile-workspace.css";

export interface ProfileEditorProps {
  section?: "profile" | "preferences";
  activeSection?: ProfileActiveSection;
  roleId?: string;
  achievementId?: string;
  achievementContent?: (achievementId: string, roleId: string) => ReactNode;
  achievementWordings?: (achievementId: string, roleId: string) => ReactNode;
  affectedMatches?: ReactNode;
}

export function ProfileEditor(props: ProfileEditorProps) {
  const tenantId = useTenantId();
  const { session } = usePorts();
  const generation = useProfileDraftGeneration(session);
  return (
    <TenantProfileEditor
      key={`${profileSessionIdentity(session)}:${tenantId}:${props.section ?? "profile"}:${generation}`}
      {...props}
    />
  );
}

function TenantProfileEditor({
  section = "profile",
  activeSection = "experience",
  roleId,
  achievementId,
  achievementContent,
  achievementWordings,
  affectedMatches,
}: ProfileEditorProps) {
  const tenantId = useTenantId();
  const documentDirtyRef = useRef(false);
  const [, setDocumentDirty] = useState(false);
  const [pendingSource, setPendingSource] =
    useState<ProfileConfigResponse | null>(null);
  const profileQuery = useProfileQuery();

  const templates = useResumeTemplatesQuery();
  const { url: previewUrl } = useProfileHtmlPreviewUrl();
  const controller = useRef<ProfilePlateTextController | null>(null);
  const [resumeLayout, setResumeLayout] = useState<"document" | "split">(
    "document",
  );
  const [formDirty, setFormDirty] = useState(false);
  const [profileRecoveryPending, setProfileRecoveryPending] = useState(true);
  const [previewSource, setPreviewSource] = useState<{
    profile: ProfileConfigResponse["profile"];
    profileVersion: number | null;
    revision: number;
  } | null>(null);
  const documentRecovery = useProfilePlateRecovery(
    previewSource?.profileVersion,
  );
  const template = resolveEffectiveResumeTemplateVersion(templates.data);
  const previewStyle = useMemo(
    () => (template ? resumeTemplatePreviewStyle(template.theme) : undefined),
    [template],
  );
  const updatePreview = useCallback((saved: ProfileConfigResponse) => {
    if (documentDirtyRef.current) {
      setPendingSource(saved);
      setPreviewSource(
        (previous) =>
          previous ?? {
            profile: saved.profile,
            profileVersion: saved.profileVersion,
            revision: 0,
          },
      );
      return;
    }
    setPreviewSource((previous) => ({
      profile: saved.profile,
      profileVersion: saved.profileVersion,
      revision: (previous?.revision ?? -1) + 1,
    }));
  }, []);
  const bindFields = useCallback(
    (html: string) => bindProfilePreviewFields(html, previewSource?.profile),
    [previewSource?.profile],
  );
  const connectController = useCallback(
    (value: ProfilePlateTextController | null) => {
      controller.current = value;
    },
    [],
  );
  const applyDocumentText = useCallback(
    (changes: readonly ResumePlateSemanticTextChange[]) =>
      controller.current?.apply(changes),
    [],
  );
  const handleDocumentDirty = useCallback((dirty: boolean) => {
    documentDirtyRef.current = dirty;
    setDocumentDirty(dirty);
  }, []);

  if (!profileQuery.data)
    return (
      <div className="profile-editor-state" aria-busy={profileQuery.isPending}>
        <Empty
          title={profileQuery.error ? "Profile unavailable" : "Loading Profile"}
          description={
            profileQuery.error?.message ?? "Loading your saved information."
          }
          {...(profileQuery.error
            ? {
                action: (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void profileQuery.refetch()}
                  >
                    Retry
                  </Button>
                ),
              }
            : {})}
        />
      </div>
    );

  if (section === "preferences")
    return (
      <div className="profile-layout profile-layout-single">
        <ProfileForm initial={profileQuery.data} section="preferences" />
        <div id="preferences-templates">
          <ResumeTemplatePanel
            profileHtmlPreviewUrl={
              profileQuery.data.profileVersion === null ? null : previewUrl
            }
          />
        </div>
      </div>
    );

  const resumeOpen = activeSection === "resume";
  return (
    <div className="profile-workspace profile-peer-workspace">
      <ProfileImportReview />
      {resumeOpen ? (
        <div
          className="toolbar profile-resume-tools"
          aria-label="Resume workspace tools"
        >
          <Button
            type="button"
            variant={resumeLayout === "document" ? "secondary" : "ghost"}
            aria-pressed={resumeLayout === "document"}
            onClick={() => setResumeLayout("document")}
          >
            Document
          </Button>
          <Button
            type="button"
            variant={resumeLayout === "split" ? "secondary" : "ghost"}
            aria-pressed={resumeLayout === "split"}
            onClick={() => setResumeLayout("split")}
          >
            Document and Profile data
          </Button>
        </div>
      ) : null}
      <div
        className={`profile-peer-content${resumeOpen && resumeLayout === "split" ? " profile-peer-content--split" : ""}`}
      >
        <div
          className="profile-peer-data"
          hidden={
            resumeOpen && resumeLayout === "document" && !profileRecoveryPending
          }
        >
          <ProfileForm
            initial={profileQuery.data}
            section="profile"
            activeSection={resumeOpen ? "experience" : activeSection}
            {...(roleId ? { roleId } : {})}
            {...(achievementId ? { achievementId } : {})}
            {...(achievementContent ? { achievementContent } : {})}
            {...(achievementWordings ? { achievementWordings } : {})}
            onPlateTextControllerChange={connectController}
            onPreviewSourceChange={updatePreview}
            onDirtyChange={setFormDirty}
            onRecoveryPendingChange={setProfileRecoveryPending}
          />
          {activeSection === "experience" ? (
            <ProfileRecoveryPanel
              disabled={formDirty || profileRecoveryPending}
            />
          ) : null}
        </div>
        <aside
          className="profile-peer-resume"
          aria-label="Baseline resume editor workspace"
          id="profile-resume-editor"
          hidden={!resumeOpen}
        >
          {documentRecovery.restoredVersion !== undefined ? (
            <p role="status">
              A resume draft retained in this browser is open
              {documentRecovery.restoredVersion !==
              profileQuery.data.profileVersion
                ? ". Its Profile source has changed; review before using it"
                : ""}
              .
            </p>
          ) : null}
          {pendingSource ? (
            <div className="profile-draft-recovery" role="status">
              <p>
                Saved Profile information changed. Your edited resume draft is
                preserved.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={profileRecoveryPending || documentRecovery.pending}
                onClick={async () => {
                  if (!(await documentRecovery.discard())) return;
                  documentDirtyRef.current = false;
                  setDocumentDirty(false);
                  setPreviewSource((previous) => ({
                    profile: pendingSource.profile,
                    profileVersion: pendingSource.profileVersion,
                    revision: (previous?.revision ?? 0) + 1,
                  }));
                  setPendingSource(null);
                }}
              >
                Replace draft with saved Profile
              </Button>
            </div>
          ) : null}
          {documentRecovery.pending ? (
            <div className="profile-draft-recovery" role="status">
              <p>
                {documentRecovery.error ??
                  (documentRecovery.hasRetainedDraft
                    ? "A retained resume draft needs a recovery decision before editing."
                    : "Checking retained resume changes…")}
              </p>
              {documentRecovery.hasRetainedDraft &&
              !documentRecovery.hasLocalEdits ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void documentRecovery.restore()}
                >
                  Restore retained resume draft
                </Button>
              ) : null}
              {documentRecovery.hasRetainedDraft || documentRecovery.error ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void documentRecovery.discard()}
                >
                  Discard retained resume draft
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={() => void documentRecovery.retry()}
              >
                Retry resume recovery
              </Button>
            </div>
          ) : null}
          {profileRecoveryPending ? (
            <p role="status">
              Restore or discard the retained Profile draft before editing the
              resume.
            </p>
          ) : null}
          <div
            inert={profileRecoveryPending || documentRecovery.pending}
            className="profile-document-editing-boundary"
          >
            <ResumeStandalonePlateEditor
              {...(template ? { transformKey: template.versionId } : {})}
              className="profile-resume-plate-editor"
              htmlUrl={
                previewSource?.profileVersion != null
                  ? profileHtmlPreviewPath(previewSource.revision)
                  : null
              }
              htmlTransform={bindFields}
              pdfFilename="baseline-resume.pdf"
              previewStyle={previewStyle}
              title="Baseline resume editor"
              onSemanticTextChange={applyDocumentText}
              initialDraftValue={documentRecovery.initialDraftValue}
              onDirtyChange={handleDocumentDirty}
              onPlateValueChange={documentRecovery.retain}
            />
            <details className="profile-resume-template-tools">
              <summary>Resume template and style</summary>
              <ResumeTemplatePanel
                profileHtmlPreviewUrl={
                  profileQuery.data.profileVersion === null ? null : previewUrl
                }
              />
            </details>
          </div>
        </aside>
      </div>
      {activeSection === "experience" && affectedMatches ? (
        <div className="profile-match-tools">{affectedMatches}</div>
      ) : null}
      <details className="profile-transfer-tools">
        <summary>Profile export and transfer</summary>
        <ProfileTransferExport />
      </details>
    </div>
  );
}
