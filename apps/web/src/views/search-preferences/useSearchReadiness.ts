import { useSourceRegistryQuery, type DiscoverySearchSettingsState } from "../../contexts/discovery/index.js";
import type { SearchPreferencesState } from "../../contexts/profile/index.js";
import type { useRuntimeHealth } from "../../contexts/runtime/index.js";

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
  const sources = useSourceRegistryQuery();
  const activeBoard = sources.data?.sources.some((source) => settings.boards.some((board) => source.sourceId === `jobstreaming:${board}`) && ["active", "experimental"].includes(source.state));
  const isDemo = runtime.data?.mode === "demo";
  let disabledReason: string | undefined;
  if (isDemo) disabledReason = "Live job searches are unavailable in the demo. You can edit these local synthetic preferences and browse the sample jobs.";
  else if (runtime.isPending) disabledReason = "Checking the search connection…";
  else if (runtime.error || !runtime.data?.worker.healthy) disabledReason = runtime.data?.worker.message ?? "The search service is unavailable. Review connections, then return here to start your search.";
  else if (preferencesLoading || settingsLoading) disabledReason = "Checking saved Search preferences…";
  else if (preferencesError || settingsError) disabledReason = "Saved Search preferences could not be checked. Retry before starting a search.";
  else if (!preferences.ready) disabledReason = "Save your first role in My profile before searching with Search preferences.";
  else if (preferences.pending || settings.pending) disabledReason = "Wait for your Search preferences and search settings to finish saving.";
  else if (!settings.ready || sources.isPending) disabledReason = "Checking saved search settings and sources…";
  else if (sources.error) disabledReason = "Search sources could not be checked. Retry the source read before starting.";
  else if (!preferences.hasTargets) disabledReason = "Add a target role to search for.";
  else if (!activeBoard) disabledReason = "Select an active JobStreaming board before searching.";
  else if (preferences.locationIssue) disabledReason = preferences.locationIssue;
  else if (settings.boards.length && preferences.hasTargets && !preferences.hasSearchLocation) disabledReason = "Add a location, or select Remote for a location-free target, before searching the selected boards.";
  const needsConnectionReview = !isDemo && (Boolean(runtime.error) || runtime.data?.worker.healthy === false);
  return { needsConnectionReview, disabledReason, sources };
}
