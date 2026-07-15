import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ProfileForm } from "../forms/profile-form.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";

export function TargetSearchSettingsPanel() {
  const profileQuery = useProfileQuery();

  return (
    <section className="card full target-search-settings">
      <CardHeader title="Discovery settings" meta="roles, locations, and work models" />
      {profileQuery.error ? <div className="banner inline">{profileQuery.error.message}</div> : null}
      {profileQuery.data ? (
        <ProfileForm initial={profileQuery.data} section="target-search" />
      ) : (
        <Empty title="Loading discovery settings." />
      )}
    </section>
  );
}
