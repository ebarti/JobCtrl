import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconArrowLeft, IconCheck } from "@tabler/icons-react";

import {
  DiscoveryAutomationSettingsPanel, DiscoveryExplicitTargets, DiscoveryProductControls,
  DiscoveryRunsPanel, DiscoveryRuntimeSettingsPanel, DiscoverySearchSettings, DiscoveryTargetPlan,
  useSourceRegistryQuery, useDiscoveryTargetPlanQuery, type DiscoverySearchSettingsState,
} from "../../contexts/discovery/index.js";
import type { DiscoverySourceTableControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { SearchPreferencesEditor, TargetSearchSettingsPanel, type SearchPreferencesState } from "../../contexts/profile/index.js";
import { useRuntimeHealth } from "../../contexts/runtime/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { Alert, AlertDescription } from "../../shared/ui/alert.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { PageHead } from "../../shared/ui/page-head.js";

import "./search-preferences.css";

const EMPTY_PREFERENCES: SearchPreferencesState = { ready: false, pending: false, hasTargets: false, needsModel: false, profileVersion: null, hasSearchLocation: false, hasRemote: false, hasRemoteWithLocation: false, locationIssue: null };
const EMPTY_SETTINGS: DiscoverySearchSettingsState = { ready: false, pending: false, boards: [], hoursOld: 0 };

/** The shared, connected task reached from both Preferences and Search for jobs. */
export function SearchPreferencesWorkspace({ sourceTable, returnAction, connectionAction, purpose = "preferences" }: {
  readonly sourceTable?: DiscoverySourceTableControls | undefined;
  readonly returnAction?: ReactNode;
  readonly connectionAction?: ReactNode;
  readonly purpose?: "search" | "preferences";
} = {}) {
  const [preferences, setPreferences] = useState(EMPTY_PREFERENCES);
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourcesMounted, setSourcesMounted] = useState(false);
  const [toolsMounted, setToolsMounted] = useState(false);
  const sourcesRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const runtime = useRuntimeHealth();
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
  else if (!preferences.ready) disabledReason = "Save your first role in My profile before searching with Search preferences.";
  else if (preferences.pending || settings.pending) disabledReason = "Wait for your Search preferences and search settings to finish saving.";
  else if (!settings.ready || sources.isPending) disabledReason = "Checking saved search settings and sources…";
  else if (sources.error) disabledReason = "Search sources could not be checked. Retry the source read before starting.";
  else if (!preferences.hasTargets && employerSources === 0) disabledReason = "Add a target role, career track or area of interest, or enable an employer source.";
  else if (!settings.boards.length && employerSources === 0) disabledReason = "Select a job board or enable an employer source before searching.";
  else if (preferences.locationIssue) disabledReason = preferences.locationIssue;
  else if (settings.boards.length && preferences.hasTargets && !preferences.hasSearchLocation) disabledReason = "Add a location, or select Remote for a location-free target, before searching the selected boards.";
  else if (preferences.hasRemote && settings.boards.includes("indeed") && settings.hoursOld > 0) disabledReason = "Indeed cannot combine Remote with a posting-age cutoff. Remove Indeed or set Posting age to 0 hours for this search.";
  else if (preferences.hasRemoteWithLocation && settings.boards.includes("glassdoor")) disabledReason = "Glassdoor cannot combine Remote with a selected location. Remove Glassdoor or use a location-free Remote target.";
  else if (preferences.hasRemote && settings.hoursOld > 0 && settings.hoursOld % 24 !== 0 && settings.boards.some((board) => ["glassdoor", "zip_recruiter"].includes(board))) disabledReason = "Glassdoor and ZipRecruiter need whole-day posting ages for Remote searches. Use a multiple of 24 hours or remove those boards.";
  else if (preferences.needsModel && targetPlan.isPending) disabledReason = "Checking the saved search plan…";
  else if (needsFreshModelPlan && application.isPending) disabledReason = "Checking the saved model configuration for your search queries…";
  else if (needsFreshModelPlan && application.error) disabledReason = "The saved model configuration could not be checked. Review connections before starting this search.";
  else if (needsFreshModelPlan && (!application.data?.aiExecutionPolicy.enabled || !application.data.providerModels[application.data.defaultProvider])) disabledReason = "Choose a model and enable model operations to prepare queries from your selected tracks, levels and areas of interest.";
  const needsConnectionReview = !isDemo && (Boolean(runtime.error) || runtime.data?.worker.healthy === false || (needsFreshModelPlan && (Boolean(application.error) || Boolean(application.data && (!application.data.aiExecutionPolicy.enabled || !application.data.providerModels[application.data.defaultProvider])))));

  useEffect(() => { if (sourcesOpen) sourcesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [sourcesOpen]);
  const openSources = () => { setSourcesMounted(true); setSourcesOpen(true); };
  const returnToSearch = () => { setSourcesOpen(false); searchRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); };

  return <div className="search-preferences-workspace">
    <PageHead eyebrow={purpose === "search" ? "Jobs" : "My profile"} title={purpose === "search" ? "Search for jobs" : "Search preferences"} subtitle="The work you want, and where to look for it." actions={<>{returnAction}<span className="search-preferences-autosave"><IconCheck aria-hidden="true" />Changes save automatically</span></>} />
    <div className="search-preferences-launch" ref={searchRef}>
        <DiscoveryRunsPanel compact profileVersion={preferences.profileVersion} disabledReason={disabledReason} readiness={<div className="search-launch-helper">
          <p>{currentPlan ? "Uses your current saved search plan." : preferences.needsModel ? "Preparing additional search queries may use your model and spending budget. Connection and spending limits are checked when you start." : preferences.hasTargets ? "Uses your exact saved role titles." : "Add the criteria for your next search."}</p>
          {needsConnectionReview ? connectionAction ?? <Link to="/settings" search={{ returnTo: "preferences" }}>Review connections</Link> : null}
          {runtime.error ? <Button type="button" size="sm" variant="ghost" onClick={() => { void runtime.refetch(); }}>Retry connection check</Button> : null}
          {sources.error ? <Button type="button" size="sm" variant="ghost" onClick={() => { void sources.refetch(); }}>Retry source check</Button> : null}
        </div>} />
        <p className="search-preferences-help">Saving preferences does not start a search or update existing matches.</p>
    </div>
    <div className="search-preferences-columns">
      <div className="search-preferences-main">{runtime.isPending && !runtime.data ? <Empty title="Checking the search workspace" /> : <SearchPreferencesEditor onStateChange={setPreferences} workspaceIdentity={runtime.data?.databaseInstanceId} />}</div>
      <div className="search-preferences-search">
        {runtime.isPending && !runtime.data ? <Empty title="Loading saved search settings" /> : <DiscoverySearchSettings onStateChange={setSettings} onManageSources={openSources} workspaceIdentity={runtime.data?.databaseInstanceId} />}
      </div>
    </div>
    <section ref={sourcesRef} className="search-source-details" hidden={!sourcesOpen} aria-labelledby="search-source-heading">
      <header><div><h2 id="search-source-heading">Search sources</h2><p>Manage source enablement, proposals, captured postings and review queues for this search.</p></div><Button type="button" variant="outline" size="sm" onClick={returnToSearch}><IconArrowLeft data-icon="inline-start" />Back to Search preferences</Button></header>
      {sourcesMounted ? <DiscoveryProductControls layout="tabs" {...(sourceTable ? { sourceTable } : {})} /> : null}
    </section>
    <details className="search-context-tools" onToggle={(event) => { if (event.currentTarget.open) setToolsMounted(true); }}>
      <summary>Search plans, schedules and source behavior</summary>
      <p>Choose a tool to inspect or change. The Start search action above uses your saved Search preferences; independent targets and schedules have their own controls.</p>
      {toolsMounted ? <div className="search-context-tools-content"><DiscoveryTargetPlan defaultOpen={false} /><TargetSearchSettingsPanel defaultOpen={false} /><DiscoveryExplicitTargets defaultOpen={false} /><details className="search-one-off search-tool-disclosure"><summary>One-off search with temporary criteria</summary><div><p>Use literal queries and locations for one run, including before you save a profile. Empty overrides use Discovery's independently saved explicit targets.</p><DiscoveryRunsPanel /></div></details><DiscoveryRuntimeSettingsPanel defaultOpen={false} includeSearchSettings={false} /><DiscoveryAutomationSettingsPanel defaultOpen={false} /></div> : null}
    </details>
    {preferences.pending ? <Alert><AlertDescription>New preference edits are waiting to save. The last saved criteria remain in effect until those changes are confirmed.</AlertDescription></Alert> : null}
  </div>;
}
