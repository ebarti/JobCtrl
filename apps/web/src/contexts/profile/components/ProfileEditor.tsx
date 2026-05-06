import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { ProfileConfigResponse } from "../../operations/types.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Editor } from "./Editor.js";
import { ResumePreviewIframe } from "./ResumePreviewIframe.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

type ProfileMode = "fields" | "source";

interface ProfileDraft {
  profileText: string;
  styleText: string;
  templateText: string;
}

function toDraft(profile: ProfileConfigResponse): ProfileDraft {
  return {
    profileText: JSON.stringify(profile.profile, null, 2),
    styleText: JSON.stringify(profile.style, null, 2),
    templateText: profile.templateText,
  };
}

export function ProfileEditor() {
  const profileQuery = useProfileQuery();
  const settingsQuery = useSettingsQuery();
  const updateProfile = useUpdateProfileMutation();

  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [original, setOriginal] = useState<ProfileDraft | null>(null);
  const [busyLabel, setBusyLabel] = useState("");
  const [profileMode, setProfileMode] = useState<ProfileMode>("fields");
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    if (profileQuery.data && !draft) {
      const next = toDraft(profileQuery.data);
      setDraft(next);
      setOriginal(next);
    }
  }, [profileQuery.data, draft]);

  const errorMessage =
    profileQuery.error?.message ??
    settingsQuery.error?.message ??
    updateProfile.error?.message ??
    "";

  const profileDirty = Boolean(draft && original && draft.profileText !== original.profileText);
  const styleDirty = Boolean(draft && original && draft.styleText !== original.styleText);
  const templateDirty = Boolean(
    draft && original && draft.templateText !== original.templateText,
  );
  const anyDirty = profileDirty || styleDirty || templateDirty;
  const busy = Boolean(busyLabel) || updateProfile.isPending;

  const savePatch = (label: string, patch: Parameters<typeof updateProfile.mutate>[0]) => {
    setBusyLabel(label);
    setStatusMessage("");
    updateProfile.mutate(patch, {
      onSuccess: (response) => {
        const next = toDraft(response);
        setDraft(next);
        setOriginal(next);
        setStatusMessage(`${label} saved`);
      },
      onSettled: () => setBusyLabel(""),
    });
  };

  const reload = async () => {
    setStatusMessage("");
    const result = await profileQuery.refetch();
    if (result.data) {
      const next = toDraft(result.data);
      setDraft(next);
      setOriginal(next);
    }
  };

  const updateField = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  return (
    <div className="profile-layout">
      <section className="card">
        <CardHeader
          title="Profile"
          meta={
            settingsQuery.data
              ? `min fit ${settingsQuery.data.settings.minFitScore}`
              : "loading"
          }
        />
        {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
        {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
        <div className="editor-bulk-actions">
          <Link className="tab on" to="/profile/import/upload">
            import resume
          </Link>
          <button
            className="tab on"
            type="button"
            disabled={!anyDirty || busy || !draft}
            onClick={() => {
              if (!draft) return;
              savePatch("profile files", {
                profileText: draft.profileText,
                styleText: draft.styleText,
                templateText: draft.templateText,
              });
            }}
          >
            save all
          </button>
          <button
            className="tab"
            type="button"
            disabled={!anyDirty || busy || !original}
            onClick={() => {
              if (original) {
                setDraft(original);
              }
            }}
          >
            discard all
          </button>
          <button
            className="tab"
            type="button"
            disabled={busy}
            onClick={() => void reload()}
          >
            reload
          </button>
        </div>
        <div className="profile-mode-tabs">
          <button
            className={`tab ${profileMode === "fields" ? "on" : ""}`}
            type="button"
            onClick={() => setProfileMode("fields")}
          >
            fields
          </button>
          <button
            className={`tab ${profileMode === "source" ? "on" : ""}`}
            type="button"
            onClick={() => setProfileMode("source")}
          >
            source
          </button>
        </div>
        {profileMode === "fields" ? (
          draft ? (
            <StructuredProfileEditor
              profileText={draft.profileText}
              styleText={draft.styleText}
              onProfileTextChange={(value) => updateField("profileText", value)}
              onStyleTextChange={(value) => updateField("styleText", value)}
            />
          ) : (
            <Empty title="Loading profile." />
          )
        ) : draft ? (
          <>
            <Editor
              dirty={profileDirty}
              label="profile.json"
              saving={busyLabel === "profile.json"}
              value={draft.profileText}
              onChange={(value) => updateField("profileText", value)}
              onDiscard={() => original && updateField("profileText", original.profileText)}
              onSave={() => savePatch("profile.json", { profileText: draft.profileText })}
            />
            <Editor
              dirty={styleDirty}
              label="resume_style.json"
              saving={busyLabel === "resume_style.json"}
              value={draft.styleText}
              onChange={(value) => updateField("styleText", value)}
              onDiscard={() => original && updateField("styleText", original.styleText)}
              onSave={() => savePatch("resume_style.json", { styleText: draft.styleText })}
            />
            <Editor
              dirty={templateDirty}
              label="resume_template.tex"
              saving={busyLabel === "resume_template.tex"}
              value={draft.templateText}
              onChange={(value) => updateField("templateText", value)}
              onDiscard={() =>
                original && updateField("templateText", original.templateText)
              }
              onSave={() => savePatch("resume_template.tex", { templateText: draft.templateText })}
            />
          </>
        ) : (
          <Empty title="Loading profile." />
        )}
      </section>
      <aside className="preview pdf-preview">
        <ResumePreviewIframe />
      </aside>
    </div>
  );
}
