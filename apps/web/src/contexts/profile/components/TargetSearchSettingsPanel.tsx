import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ProfileForm } from "../forms/profile-form.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";

export function TargetSearchSettingsPanel() {
  const profileQuery = useProfileQuery();

  return (
    <DisclosureSection
      className="target-search-settings"
      title="Target search"
      description="Roles, locations, work models, and target search defaults"
      collapsedSummary="Roles, locations, seniority, and work models"
    >
      {profileQuery.error ? <div className="banner inline">{profileQuery.error.message}</div> : null}
      {profileQuery.data ? (
        <ProfileForm initial={profileQuery.data} section="target-search" />
      ) : (
        <Empty title="Loading discovery settings." />
      )}
    </DisclosureSection>
  );
}
