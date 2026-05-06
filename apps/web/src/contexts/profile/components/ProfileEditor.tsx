import type { ProfileConfigResponse, SettingsResponse } from "@jobhunter/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Editor } from "./Editor.js";
import { ResumePreviewIframe } from "./ResumePreviewIframe.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

type ProfileMode = "fields" | "source";

export function ProfileEditor() {
  const ports = usePorts();
  const [profile, setProfile] = useState<ProfileConfigResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [profileText, setProfileText] = useState("");
  const [styleText, setStyleText] = useState("");
  const [templateText, setTemplateText] = useState("");
  const [originalProfileText, setOriginalProfileText] = useState("");
  const [originalStyleText, setOriginalStyleText] = useState("");
  const [originalTemplateText, setOriginalTemplateText] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [profileMode, setProfileMode] = useState<ProfileMode>("fields");

  const applyProfileResponse = useCallback((profileResponse: ProfileConfigResponse) => {
    const nextProfileText = JSON.stringify(profileResponse.profile, null, 2);
    const nextStyleText = JSON.stringify(profileResponse.style, null, 2);
    setProfile(profileResponse);
    setProfileText(nextProfileText);
    setStyleText(nextStyleText);
    setTemplateText(profileResponse.templateText);
    setOriginalProfileText(nextProfileText);
    setOriginalStyleText(nextStyleText);
    setOriginalTemplateText(profileResponse.templateText);
    setPreviewVersion((version) => version + 1);
  }, []);

  const load = useCallback(async () => {
    setLoadError("");
    setSaveStatus("");
    try {
      const [profileResponse, settingsResponse] = await Promise.all([
        ports.api.profile(),
        ports.api.settings(),
      ]);
      applyProfileResponse(profileResponse);
      setSettings(settingsResponse);
    } catch (requestError) {
      setLoadError(
        requestError instanceof Error ? requestError.message : "Unable to load profile.",
      );
    }
  }, [applyProfileResponse, ports.api]);

  useEffect(() => {
    void load();
  }, [load]);

  const profileDirty = profileText !== originalProfileText;
  const styleDirty = styleText !== originalStyleText;
  const templateDirty = templateText !== originalTemplateText;
  const anyDirty = profileDirty || styleDirty || templateDirty;

  const savePatch = async (
    label: string,
    patch: Parameters<typeof ports.api.updateProfile>[0],
  ) => {
    setBusy(label);
    setSaveStatus("");
    setLoadError("");
    try {
      const response = await ports.api.updateProfile(patch);
      applyProfileResponse(response);
      setSaveStatus(`${label} saved`);
    } catch (requestError) {
      setLoadError(
        requestError instanceof Error ? requestError.message : `Unable to save ${label}.`,
      );
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="profile-layout">
      <section className="card">
        <CardHeader
          title="Profile"
          meta={settings ? `min fit ${settings.settings.minFitScore}` : "loading"}
        />
        {loadError ? <div className="banner inline">{loadError}</div> : null}
        {saveStatus ? <div className="status-line">{saveStatus}</div> : null}
        <div className="editor-bulk-actions">
          <Link className="tab on" to="/profile/import/upload">
            import resume
          </Link>
          <button
            className="tab on"
            type="button"
            disabled={!anyDirty || Boolean(busy)}
            onClick={() =>
              void savePatch("profile files", { profileText, styleText, templateText })
            }
          >
            save all
          </button>
          <button
            className="tab"
            type="button"
            disabled={!anyDirty || Boolean(busy)}
            onClick={() => {
              setProfileText(originalProfileText);
              setStyleText(originalStyleText);
              setTemplateText(originalTemplateText);
            }}
          >
            discard all
          </button>
          <button className="tab" type="button" disabled={Boolean(busy)} onClick={() => void load()}>
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
          profile ? (
            <StructuredProfileEditor
              profileText={profileText}
              styleText={styleText}
              onProfileTextChange={setProfileText}
              onStyleTextChange={setStyleText}
            />
          ) : (
            <Empty title="Loading profile." />
          )
        ) : (
          <>
            <Editor
              dirty={profileDirty}
              label="profile.json"
              saving={busy === "profile.json"}
              value={profileText}
              onChange={setProfileText}
              onDiscard={() => setProfileText(originalProfileText)}
              onSave={() => void savePatch("profile.json", { profileText })}
            />
            <Editor
              dirty={styleDirty}
              label="resume_style.json"
              saving={busy === "resume_style.json"}
              value={styleText}
              onChange={setStyleText}
              onDiscard={() => setStyleText(originalStyleText)}
              onSave={() => void savePatch("resume_style.json", { styleText })}
            />
            <Editor
              dirty={templateDirty}
              label="resume_template.tex"
              saving={busy === "resume_template.tex"}
              value={templateText}
              onChange={setTemplateText}
              onDiscard={() => setTemplateText(originalTemplateText)}
              onSave={() => void savePatch("resume_template.tex", { templateText })}
            />
          </>
        )}
      </section>
      <aside className="preview pdf-preview">
        <ResumePreviewIframe cacheKey={previewVersion} />
      </aside>
    </div>
  );
}
