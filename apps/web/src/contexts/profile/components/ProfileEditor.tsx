import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ProfileForm } from "../forms/profile-form.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";
import { ResumePreviewIframe } from "./ResumePreviewIframe.js";

export function ProfileEditor() {
  const profileQuery = useProfileQuery();
  const settingsQuery = useSettingsQuery();
  const errorMessage =
    profileQuery.error?.message ?? settingsQuery.error?.message ?? "";

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
        {profileQuery.data ? (
          <ProfileForm initial={profileQuery.data} />
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
