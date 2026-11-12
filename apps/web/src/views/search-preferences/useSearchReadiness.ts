import { useSourceRegistryQuery, useDiscoveryTargetPlanQuery, type DiscoverySearchSettingsState } from "../../contexts/discovery/index.js";
import type { SearchPreferencesState } from "../../contexts/profile/index.js";
import type { useRuntimeHealth } from "../../contexts/runtime/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";

/** One readiness policy for the Jobs action and the connected preferences editor. */
export function useSearchReadiness({ preferences, settings, runtime, preferencesLoading = false, settingsLoading = false, preferencesError, settingsError }: {
  readonly preferences: SearchPreferencesState;
  readonly settings: DiscoverySearchSettingsState;
  readonly runtime: ReturnType<typeof useRuntimeHealth>;
  readonly preferencesLoading?: boolean;
  readonly settingsLoading?: boolean;
  readonly preferencesError?: unknown;
  readonly settingsError?: unknown;
}) {
  const application = useApplicationSettings();
  const sources = useSourceRegistryQuery();
  const targetPlan = useDiscoveryTargetPlanQuery();
  const currentPlan = targetPlan.data?.current && targetPlan.data.profileRevision === preferences.profileVersion;
  const needsFreshModelPlan = preferences.needsModel && !currentPlan;
  const employerSources = sources.data?.sources.filter((source) => ["active", "experimental"].includes(source.state) && ["ats_api", "employer_careers_page", "smart_extract"].includes(source.kind)).length ?? 0;
  const isDemo = runtime.data?.mode === "demo";
  let disabledReason: string | undefined;
  if (isDemo) disabledReason = "Live job searches are unavailable in the demo. You can edit these local synthetic preferences and browse the sample jobs.";
  else if (runtime.isPending) disabledReason = "Checking the search connection…";
  else if (runtime.error || !runtime.data?.worker.healthy) disabledReason = "The search service is unavailable. Review connections, then return here to start your search.";
  else if (preferencesLoading || settingsLoading) disabledReason = "Checking saved Search preferences…";
  else if (preferencesError || settingsError) disabledReason = "Saved Search preferences could not be checked. Retry before starting a search.";
  else if (!preferences.ready) disabledReason = "Save your first role in My profile before searching with Search preferences.";
  else if (preferences.pending || settings.pending) disabledReason = "Wait for your Search preferences and search settings to finish saving.";
  else if (!settings.ready || sources.isPending) disabledReason = "Checking saved search settings and sources…";
  else if (sources.error) disabledReason = "Search sources could not be checked. Retry the source read before starting.";
  else if (!preferences.hasTargets && employerSources === 0) disabledReason = "Add a target role, career track or area of interest, or enable an employer source.";
  else if (!settings.boards.length && employerSources === 0) disabledReason = "Select a job board or enable an employer source before searching.";
  else if (preferences.locationIssue) disabledReason = preferences.locationIssue;
  else if (settings.boards.length && preferences.hasTargets && !preferences.hasSearchLocation) disabledReason = "Add a location, or select Remote for a location-free target, before searching the selected boards.";
  else if (preferences.needsModel && targetPlan.isPending) disabledReason = "Checking the saved search plan…";
  else if (needsFreshModelPlan && application.isPending) disabledReason = "Checking the saved model configuration for your search queries…";
  else if (needsFreshModelPlan && application.error) disabledReason = "The saved model configuration could not be checked. Review connections before starting this search.";
  else if (needsFreshModelPlan && (!application.data?.aiExecutionPolicy.enabled || !application.data.providerModels[application.data.defaultProvider])) disabledReason = "Choose a model and enable model operations to prepare queries from your selected tracks, levels and areas of interest.";
  const needsConnectionReview = !isDemo && (Boolean(runtime.error) || runtime.data?.worker.healthy === false || (needsFreshModelPlan && (Boolean(application.error) || Boolean(application.data && (!application.data.aiExecutionPolicy.enabled || !application.data.providerModels[application.data.defaultProvider])))));
  return { currentPlan, needsConnectionReview, disabledReason, sources };
}
