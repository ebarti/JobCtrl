import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconArrowLeft, IconCheck } from "@tabler/icons-react";

import {
  DiscoveryAutomationSettingsPanel, DiscoveryExplicitTargets, DiscoveryProductControls,
  DiscoveryRunsPanel, DiscoveryRuntimeSettingsPanel, DiscoverySearchSettings, DiscoveryTargetPlan,
  useSavedDiscoverySearchSettingsState,
} from "../../contexts/discovery/index.js";
import type { DiscoverySourceTableControls } from "../../contexts/discovery/components/DiscoveryProductControls.js";
import { SearchPreferencesEditor, TargetSearchSettingsPanel, useSavedSearchPreferencesState } from "../../contexts/profile/index.js";
import { useRuntimeHealth } from "../../contexts/runtime/index.js";
import { Alert, AlertDescription } from "../../shared/ui/alert.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { PageHead } from "../../shared/ui/page-head.js";

import { useSearchReadiness } from "./useSearchReadiness.js";
import { renderSearchFeedback } from "./SearchFeedbackComposition.js";
import "./search-preferences.css";

/** The shared, connected task reached from both Preferences and Search for jobs. */
export function SearchPreferencesWorkspace({ sourceTable, returnAction, connectionAction, spendingAction, purpose = "preferences" }: {
  readonly sourceTable?: DiscoverySourceTableControls | undefined;
  readonly returnAction?: ReactNode;
  readonly connectionAction?: ReactNode;
  readonly spendingAction?: ReactNode;
  readonly purpose?: "search" | "preferences";
} = {}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourcesMounted, setSourcesMounted] = useState(false);
  const [toolsMounted, setToolsMounted] = useState(false);
  const sourcesRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const runtime = useRuntimeHealth();
  const savedPreferences = useSavedSearchPreferencesState(runtime.data?.databaseInstanceId);
  const savedSettings = useSavedDiscoverySearchSettingsState(runtime.data?.databaseInstanceId);
  const preferences = savedPreferences.state;
  const settings = savedSettings.state;
  const { currentPlan, needsConnectionReview, disabledReason, accountingSetupReason, sources } = useSearchReadiness({
    preferences, settings, runtime, preferencesLoading: savedPreferences.loading, settingsLoading: savedSettings.loading,
    preferencesError: savedPreferences.error, settingsError: savedSettings.error,
  });

  useEffect(() => { if (sourcesOpen) sourcesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [sourcesOpen]);
  const openSources = () => { setSourcesMounted(true); setSourcesOpen(true); };
  const returnToSearch = () => { setSourcesOpen(false); searchRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); };

  return <div className="search-preferences-workspace">
    <PageHead eyebrow={purpose === "search" ? "Jobs" : "My profile"} title={purpose === "search" ? "Search for jobs" : "Search preferences"} subtitle="The work you want, and where to look for it." actions={<>{returnAction}<span className="search-preferences-autosave"><IconCheck aria-hidden="true" />Changes save automatically</span></>} />
    <div className="search-preferences-launch" ref={searchRef}>
        <DiscoveryRunsPanel compact renderFeedback={renderSearchFeedback} workspaceIdentity={runtime.data?.databaseInstanceId} profileVersion={preferences.profileVersion} disabledReason={disabledReason} accountingSetupReason={accountingSetupReason} spendingAction={spendingAction ?? <Link to="/settings/budgets" search={{ returnTo: "preferences" }}>Review spending setup</Link>} readiness={<div className="search-launch-helper">
          <p>{currentPlan ? "Uses your current saved search plan." : preferences.needsModel ? "Preparing additional search queries may use your model and spending budget. Connection and spending limits are checked when you start." : preferences.hasTargets ? "Uses your exact saved role titles." : "Add the criteria for your next search."}</p>
          {needsConnectionReview ? connectionAction ?? <Link to="/settings" search={{ returnTo: "preferences" }}>Review connections</Link> : null}
          {runtime.error ? <Button type="button" size="sm" variant="ghost" onClick={() => { void runtime.refetch(); }}>Retry connection check</Button> : null}
          {savedPreferences.error || savedSettings.error ? <Button type="button" size="sm" variant="ghost" onClick={() => { void savedPreferences.refetch(); void savedSettings.refetch(); }}>Retry saved preferences</Button> : null}
          {sources.error ? <Button type="button" size="sm" variant="ghost" onClick={() => { void sources.refetch(); }}>Retry source check</Button> : null}
        </div>} />
        <p className="search-preferences-help">Saving preferences does not start a search or update existing matches.</p>
    </div>
    <div className="search-preferences-columns">
      <div className="search-preferences-main">{runtime.isPending && !runtime.data ? <Empty title="Checking the search workspace" /> : <SearchPreferencesEditor workspaceIdentity={runtime.data?.databaseInstanceId} />}</div>
      <div className="search-preferences-search">
        {runtime.isPending && !runtime.data ? <Empty title="Loading saved search settings" /> : <DiscoverySearchSettings onManageSources={openSources} workspaceIdentity={runtime.data?.databaseInstanceId} />}
      </div>
    </div>
    <section ref={sourcesRef} className="search-source-details" hidden={!sourcesOpen} aria-labelledby="search-source-heading">
      <header><div><h2 id="search-source-heading">Search sources</h2><p>Manage source enablement, proposals, captured postings and review queues for this search.</p></div><Button type="button" variant="outline" size="sm" onClick={returnToSearch}><IconArrowLeft data-icon="inline-start" />Back to Search preferences</Button></header>
      {sourcesMounted ? <DiscoveryProductControls layout="tabs" {...(sourceTable ? { sourceTable } : {})} /> : null}
    </section>
    <details className="search-context-tools" onToggle={(event) => { if (event.currentTarget.open) setToolsMounted(true); }}>
      <summary>Search plans, schedules and source behavior</summary>
      <p>Choose a tool to inspect or change. The Start search action above uses your saved Search preferences; independent targets and schedules have their own controls.</p>
      {toolsMounted ? <div className="search-context-tools-content"><DiscoveryTargetPlan defaultOpen={false} /><TargetSearchSettingsPanel defaultOpen={false} /><DiscoveryExplicitTargets defaultOpen={false} /><details className="search-one-off search-tool-disclosure"><summary>One-off search with temporary criteria</summary><div><p>Use literal queries and locations for one run, including before you save a profile. Empty overrides use Discovery's independently saved explicit targets.</p><DiscoveryRunsPanel renderFeedback={renderSearchFeedback} /></div></details><DiscoveryRuntimeSettingsPanel defaultOpen={false} includeSearchSettings={false} /><DiscoveryAutomationSettingsPanel defaultOpen={false} /></div> : null}
    </details>
    {preferences.pending ? <Alert><AlertDescription>New preference edits are waiting to save. The last saved criteria remain in effect until those changes are confirmed.</AlertDescription></Alert> : null}
  </div>;
}
