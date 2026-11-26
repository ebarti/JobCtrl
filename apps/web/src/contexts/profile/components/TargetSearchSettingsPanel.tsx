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
      description="Select suggestions to add to your saved search preferences."
      title="Search preference suggestions"
    >
      {profileQuery.error ? <div className="banner inline">{profileQuery.error.message}</div> : null}
      {profileQuery.data ? (
        <ProfileForm
          initial={profileQuery.data}
          section="target-search"
        />
      ) : (
        <Empty title="Loading discovery settings." />
      )}
    </DisclosureSection>
  );
}
