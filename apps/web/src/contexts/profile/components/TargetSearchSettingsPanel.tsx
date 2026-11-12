import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ProfileForm } from "../forms/profile-form.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";

export function TargetSearchSettingsPanel({ defaultOpen = true }: { readonly defaultOpen?: boolean } = {}) {
  const profileQuery = useProfileQuery();

  return (
    <DisclosureSection
      className="target-search-settings"
      defaultOpen={defaultOpen}
      collapsedSummary="Roles, locations, seniority, and work models"
      description="Suggest roles and locations, then review your Search preferences before saving"
      title="Search preference suggestions"
    >
      {profileQuery.error ? <div className="banner inline">{profileQuery.error.message}</div> : null}
      {profileQuery.data ? (
        <ProfileForm
          initial={profileQuery.data}
          section="target-search"
          showSectionHeading={false}
        />
      ) : (
        <Empty title="Loading discovery settings." />
      )}
    </DisclosureSection>
  );
}
