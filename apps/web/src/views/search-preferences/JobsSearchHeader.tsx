import type { ReactNode } from "react";

import { SavedDiscoverySearch, useSavedDiscoverySearchSettingsState } from "../../contexts/discovery/index.js";
import { useSavedSearchPreferencesState } from "../../contexts/profile/index.js";
import { useMountedFeatures, useRuntimeHealth } from "../../contexts/runtime/index.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { useSearchReadiness } from "./useSearchReadiness.js";

/** Jobs launches saved criteria; editing remains a separate, contextual action. */
type JobsSearchHeaderProps = {
  readonly preferencesAction: ReactNode;
  readonly connectionAction: ReactNode;
  readonly spendingAction: ReactNode;
};

export function JobsSearchHeader(props: JobsSearchHeaderProps) {
  const features = useMountedFeatures();
  if (!features.has("discovery")) return <PageHead title="Jobs" subtitle="Compare saved opportunities and choose your next step." />;
  return <ConnectedJobsSearchHeader {...props} />;
}

function ConnectedJobsSearchHeader({ preferencesAction, connectionAction, spendingAction }: JobsSearchHeaderProps) {
  const runtime = useRuntimeHealth();
  const preferences = useSavedSearchPreferencesState(runtime.data?.databaseInstanceId);
  const settings = useSavedDiscoverySearchSettingsState(runtime.data?.databaseInstanceId);
  const readiness = useSearchReadiness({
    preferences: preferences.state, settings: settings.state, runtime,
    preferencesLoading: preferences.loading, settingsLoading: settings.loading,
    preferencesError: preferences.error, settingsError: settings.error,
  });
  return <SavedDiscoverySearch workspaceIdentity={runtime.data?.databaseInstanceId} profileVersion={preferences.state.profileVersion} disabledReason={readiness.disabledReason} accountingSetupReason={readiness.accountingSetupReason} spendingAction={spendingAction}>
    {({ action, feedback }) => <>
      <PageHead title="Jobs" subtitle="Compare saved opportunities and choose your next step."
        actions={<>{preferencesAction}{action}</>} />
      {feedback}
      {readiness.needsConnectionReview || runtime.error || preferences.error || settings.error || readiness.sources.error ? <div className="flex flex-wrap items-center gap-2">
        {readiness.needsConnectionReview ? connectionAction : null}
        {runtime.error || preferences.error || settings.error || readiness.sources.error ? <Button type="button" size="sm" variant="outline" onClick={() => {
          void runtime.refetch(); void preferences.refetch(); void settings.refetch(); void readiness.sources.refetch();
        }}>Retry search checks</Button> : null}
      </div> : null}
    </>}
  </SavedDiscoverySearch>;
}
