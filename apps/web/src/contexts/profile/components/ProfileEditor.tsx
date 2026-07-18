import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "@tanstack/react-router";

import { CardHeader } from "../../../shared/ui/card-header.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { ResumeStandalonePlateEditor } from "../../materials/components/ResumeAuditPins.js";
import { ProfileForm } from "../forms/profile-form.js";
import { useProfileHtmlPreviewUrl } from "../hooks/useProfileHtmlPreviewUrl.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";
import { ResumeTemplatePanel } from "./ResumeTemplatePanel.js";

const SPLIT_STORAGE_KEY = "profile-preview-split-width";
const DEFAULT_EDITOR_WIDTH = 62;
const MIN_EDITOR_WIDTH = 38;
const MAX_EDITOR_WIDTH = 76;

export interface ProfileEditorProps {
  section?: "profile" | "preferences";
}

export function ProfileEditor({ section = "profile" }: ProfileEditorProps) {
  const { storage } = usePorts();
  const profileQuery = useProfileQuery();
  const { url: profileHtmlPreviewUrl } = useProfileHtmlPreviewUrl();
  const layoutRef = useRef<HTMLDivElement>(null);
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

  return (
    <div
      className={`profile-layout ${showPreview ? "" : "profile-layout-single"}`}
      ref={layoutRef}
      style={layoutStyle}
    >
      <section className="card">
        <CardHeader
          title={cardTitle}
          meta={profileQuery.data ? undefined : "loading"}
        />
        {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
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
              <ResumeTemplatePanel profileHtmlPreviewUrl={profileHtmlPreviewUrl} />
            </>
          ) : (
            <ProfileForm initial={profileQuery.data} section={section} />
          )
        ) : (
          <Empty title={section === "preferences" ? "Loading preferences." : "Loading profile."} />
        )}
      </section>
      {showPreview ? (
        <>
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
          <aside className="preview resume-editor-preview">
            <ResumeStandalonePlateEditor
              className="profile-resume-plate-editor"
              htmlUrl={profileHtmlPreviewUrl}
              title="Baseline resume editor"
            />
          </aside>
        </>
      ) : null}
    </div>
  );
}

function clampEditorWidth(value: number): number {
  return Math.min(MAX_EDITOR_WIDTH, Math.max(MIN_EDITOR_WIDTH, Math.round(value)));
}
