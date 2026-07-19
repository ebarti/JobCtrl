import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "@tanstack/react-router";

import { CardHeader } from "../../../shared/ui/card-header.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { ToggleGroup, ToggleGroupItem } from "../../../shared/ui/toggle-group.js";
import { ResumeStandalonePlateEditor } from "../../materials/components/ResumeAuditPins.js";
import { ProfileForm } from "../forms/profile-form.js";
import { useProfileHtmlPreviewUrl } from "../hooks/useProfileHtmlPreviewUrl.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";
import { ResumeTemplatePanel } from "./ResumeTemplatePanel.js";

const SPLIT_STORAGE_KEY = "profile-preview-split-width";
const DEFAULT_EDITOR_WIDTH = 62;
const MIN_EDITOR_WIDTH = 38;
const MAX_EDITOR_WIDTH = 76;

type ProfileWorkspaceView = "profile-data" | "resume-editor" | "split-view";

export interface ProfileEditorProps {
  section?: "profile" | "preferences";
}

export function ProfileEditor({ section = "profile" }: ProfileEditorProps) {
  const { storage } = usePorts();
  const profileQuery = useProfileQuery();
  const { url: profileHtmlPreviewUrl } = useProfileHtmlPreviewUrl();
  const layoutRef = useRef<HTMLDivElement>(null);
  const [workspaceView, setWorkspaceView] = useState<ProfileWorkspaceView>("profile-data");
  const [editorWidth, setEditorWidth] = useState(() => {
    const saved = storage.get<number>(SPLIT_STORAGE_KEY);
    return clampEditorWidth(typeof saved === "number" ? saved : DEFAULT_EDITOR_WIDTH);
  });
  const errorMessage = profileQuery.error?.message ?? "";
  const showPreview = section === "profile";
  const layoutStyle = {
    "--profile-editor-width": `${editorWidth}%`,
  } as CSSProperties;
  const cardTitle =
    section === "preferences" ? "Configuration & templates" : "Resume data";

  const setWidthFromClientX = (clientX: number, persist = false) => {
    const rect = layoutRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const next = clampEditorWidth(((clientX - rect.left) / rect.width) * 100);
    setEditorWidth(next);
    if (persist) {
      storage.set(SPLIT_STORAGE_KEY, next);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const onPointerMove = (moveEvent: PointerEvent) => {
      setWidthFromClientX(moveEvent.clientX);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      setWidthFromClientX(upEvent.clientX, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const nudgeResize = (direction: -1 | 1) => {
    const next = clampEditorWidth(editorWidth + direction * 4);
    setEditorWidth(next);
    storage.set(SPLIT_STORAGE_KEY, next);
  };

  const sectionLinks = section === "profile"
    ? [
        ["profile-personal", "Personal"],
        ["profile-baseline", "Resume baseline"],
        ["profile-experience", "Experience"],
        ["profile-education", "Education"],
        ["profile-skills", "Skills"],
        ["profile-eeo", "Voluntary EEO"],
      ]
    : [
        ["preferences-application", "Application"],
        ["preferences-tailoring", "Tailoring"],
        ["preferences-style", "Resume style"],
        ["preferences-templates", "Templates"],
      ];

  const profileData = (
      <section className="card profile-data-workspace">
        <CardHeader
          title={cardTitle}
          meta={profileQuery.data ? undefined : errorMessage ? "unavailable" : "loading"}
        />
        <nav
          aria-label={`${section === "profile" ? "Profile" : "Preferences"} sections`}
          className="profile-section-nav"
        >
          <span data-typography="label">Jump to</span>
          <div className="profile-section-nav__links">
            {sectionLinks.map(([target, label]) => (
              <a data-typography="control" href={`#${target}`} key={target}>{label}</a>
            ))}
          </div>
        </nav>
        {section === "profile" ? (
          <div className="toolbar profile-evidence-toolbar">
            <Link className="tab" to="/evidence-map">
              Open evidence map
            </Link>
          </div>
        ) : null}
        {profileQuery.data ? (
          section === "preferences" ? (
            <>
              <ProfileForm initial={profileQuery.data} section={section} />
              <div id="preferences-templates" className="profile-template-section">
                <ResumeTemplatePanel profileHtmlPreviewUrl={profileHtmlPreviewUrl} />
              </div>
            </>
          ) : (
            <ProfileForm initial={profileQuery.data} section={section} />
          )
        ) : errorMessage ? (
          <div className="profile-editor-state" role="alert">
            <Empty
              title={section === "preferences" ? "Preferences unavailable" : "Profile unavailable"}
              description={errorMessage}
              action={
                <Button type="button" variant="outline" onClick={() => void profileQuery.refetch()}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : (
          <div className="profile-editor-state" aria-busy="true">
            <Empty
              title={section === "preferences" ? "Loading preferences" : "Loading profile"}
              description="The editor will appear when the saved configuration is ready."
            />
          </div>
        )}
      </section>
  );

  if (!showPreview) {
    return <div className="profile-layout profile-layout-single">{profileData}</div>;
  }

  return (
    <div className="profile-workspace">
      <ToggleGroup
        aria-label="Profile workspace views"
        className="profile-workspace-tabs"
        spacing={0}
        type="single"
        value={workspaceView}
        variant="outline"
        onValueChange={(value) => {
          if (value === "profile-data" || value === "resume-editor" || value === "split-view") {
            setWorkspaceView(value);
          }
        }}
      >
        <ToggleGroupItem value="profile-data">Profile data</ToggleGroupItem>
        <ToggleGroupItem value="resume-editor">Resume editor</ToggleGroupItem>
        <ToggleGroupItem value="split-view">Split view</ToggleGroupItem>
      </ToggleGroup>
      <div
        className={`profile-layout profile-workspace-content ${
          workspaceView === "split-view" ? "" : "profile-layout-single"
        }`}
        data-view={workspaceView}
        ref={layoutRef}
        style={layoutStyle}
      >
        <div className="profile-workspace-data" hidden={workspaceView === "resume-editor"}>
          {profileData}
        </div>
        {workspaceView === "split-view" ? (
          <Button
            className="profile-resizer"
            type="button"
            aria-label="Resize profile and resume editor panes"
            size="icon"
            title="Drag to resize profile and resume editor panes"
            variant="ghost"
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                nudgeResize(-1);
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                nudgeResize(1);
              }
            }}
          >
            <span aria-hidden="true" />
          </Button>
        ) : null}
          <aside
            aria-label="Baseline resume editor workspace"
            className="preview resume-editor-preview"
            hidden={workspaceView === "profile-data"}
            id="profile-resume-editor"
          >
            <div className="profile-resume-editor-help">
              <strong data-typography="component-title">Edit the baseline resume</strong>
              <span data-typography="body">
                Select resume text, then use the labelled bold, italic, underline, link, font,
                size, and alignment controls.
              </span>
            </div>
            <ResumeStandalonePlateEditor
              className="profile-resume-plate-editor"
              htmlUrl={profileHtmlPreviewUrl}
              title="Baseline resume editor"
            />
          </aside>
      </div>
    </div>
  );
}

function clampEditorWidth(value: number): number {
  return Math.min(MAX_EDITOR_WIDTH, Math.max(MIN_EDITOR_WIDTH, Math.round(value)));
}
