import { Link, Outlet, createFileRoute, useBlocker, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { BrowserCapabilitiesPanel, ExtensionPairingPanel } from "../contexts/browser/index.js";
import { CompensationSourcePolicyPanel } from "../contexts/compensation/index.js";
import { DiscoveryAutomationSettingsPanel, DiscoveryRuntimeSettingsPanel } from "../contexts/discovery/index.js";
import { CredentialsPanel } from "../contexts/profile/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { AppearanceSettingsPanel, ApplicationSettingsPanel } from "../contexts/settings/index.js";
import { PageHead } from "../shared/ui/page-head.js";
import { Button } from "../shared/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../shared/ui/dialog.js";
import { discoverySearchSchema } from "./-discovery.search.js";

type SettingsPane = "connections" | "budgets" | "automation" | "appearance" | "data";

const settingsSearchSchema = z.object({
  returnTo: z.enum(["preferences", "discovery"]).optional().catch(undefined),
  returnDiscovery: discoverySearchSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/settings")({
  validateSearch: (search) => settingsSearchSchema.parse(search),
  component: SettingsLayout,
});

function paneForPath(pathname: string): SettingsPane {
  if (pathname === "/settings/budgets") return "budgets";
  if (pathname === "/settings/automation") return "automation";
  if (pathname === "/settings/appearance") return "appearance";
  if (pathname === "/settings/data") return "data";
  return "connections";
}

function SettingsLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = Route.useSearch();
  const pane = paneForPath(pathname);
  const [visited, setVisited] = useState<ReadonlySet<SettingsPane>>(() => new Set([pane]));
  const [hasSecretDraft, setHasSecretDraft] = useState(false);
  const features = useMountedFeatures();
  const blocker = useBlocker({
    disabled: !hasSecretDraft,
    enableBeforeUnload: hasSecretDraft,
    withResolver: true,
    shouldBlockFn: ({ next }) => hasSecretDraft && next.pathname !== "/settings" && !next.pathname.startsWith("/settings/"),
  });
  useEffect(() => {
    setVisited((previous) => previous.has(pane) ? previous : new Set([...previous, pane]));
  }, [pane]);
  const mounted = (name: SettingsPane) => pane === name || visited.has(name);

  return <>
    <PageHead eyebrow="Settings" title="Settings" subtitle="Connections, preferences and workspace controls."
      actions={search.returnTo === "preferences" ? <Link className="tab" to="/preferences">← Back to search preferences</Link>
        : search.returnTo === "discovery" ? <Link className="tab" to="/discovery" search={search.returnDiscovery}>← Back to search for jobs</Link>
          : undefined} />
    <div className="config-layout">
      <nav className="workspace-tabs settings-workspace-tabs" aria-label="Settings sections">
        <Link to="/settings" search={search} activeOptions={{ exact: true }} aria-current={pane === "connections" ? "page" : undefined}>Connections</Link>
        <Link to="/settings/budgets" search={search} activeOptions={{ exact: true }} aria-current={pane === "budgets" ? "page" : undefined}>Budgets</Link>
        <Link to="/settings/automation" search={search} activeOptions={{ exact: true }} aria-current={pane === "automation" ? "page" : undefined}>Automation</Link>
        <Link to="/settings/appearance" search={search} activeOptions={{ exact: true }} aria-current={pane === "appearance" ? "page" : undefined}>Appearance</Link>
        <Link to="/settings/data" search={search} activeOptions={{ exact: true }} aria-current={pane === "data" ? "page" : undefined}>Data &amp; diagnostics</Link>
      </nav>
      {mounted("connections") ? <div className="settings-pane" hidden={pane !== "connections"}>
        <ConnectionsWorkspace active={pane === "connections"} pathname={pathname} onSecretDraftChange={setHasSecretDraft} />
      </div> : null}
      {mounted("budgets") ? <div className="settings-pane" hidden={pane !== "budgets"}>
        <ApplicationSettingsPanel section="budgets" active={pane === "budgets"} />
      </div> : null}
      {mounted("automation") ? <div className="settings-pane" hidden={pane !== "automation"}>
        <ApplicationSettingsPanel section="automation" active={pane === "automation"} />
        {features.has("discovery") ? <><DiscoveryAutomationSettingsPanel /><DiscoveryRuntimeSettingsPanel /></> : null}
        {features.has("compensation") ? <CompensationSourcePolicyPanel /> : null}
      </div> : null}
      {mounted("appearance") ? <div className="settings-pane" hidden={pane !== "appearance"}><AppearanceSettingsPanel /></div> : null}
      {mounted("data") ? <div className="settings-pane" hidden={pane !== "data"}><SettingsData features={features} /></div> : null}
      <Outlet />
    </div>
    <Dialog open={blocker.status === "blocked"} onOpenChange={(open) => {
      if (!open && blocker.status === "blocked") blocker.reset();
    }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Unsaved connection credential</DialogTitle>
          <DialogDescription>Your credential has not been saved. Stay in Settings to save or clear it, or discard it and leave.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { if (blocker.status === "blocked") blocker.reset(); }}>Stay in Settings</Button>
          <Button type="button" variant="destructive" onClick={() => { if (blocker.status === "blocked") blocker.proceed(); }}>Discard and leave</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function ConnectionsWorkspace({ active, pathname, onSecretDraftChange }: {
  readonly active: boolean;
  readonly pathname: string;
  readonly onSecretDraftChange: (hasSecret: boolean) => void;
}) {
  const initiallyBrowser = pathname === "/settings/browser";
  const [browserOpen, setBrowserOpen] = useState(initiallyBrowser);
  const [browserMounted, setBrowserMounted] = useState(initiallyBrowser);
  const modelsRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (pathname === "/settings/browser") { setBrowserMounted(true); setBrowserOpen(true); }
  }, [pathname]);
  useEffect(() => {
    const target = pathname === "/settings/models" ? modelsRef.current : pathname === "/settings/browser" ? browserRef.current : null;
    if (!target || !active) return;
    const frame = requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [active, pathname]);
  return <>
    <CredentialsPanel onSecretDraftChange={onSecretDraftChange} />
    <div ref={modelsRef}><ApplicationSettingsPanel section="models" active={active} /></div>
    <details ref={browserRef} className="settings-connection-details" open={browserOpen} onToggle={(event) => {
      const open = event.currentTarget.open;
      setBrowserOpen(open);
      if (open) setBrowserMounted(true);
    }}>
      <summary>Browser and extension</summary>
      {browserMounted ? <><BrowserCapabilitiesPanel /><ExtensionPairingPanel /></> : null}
    </details>
  </>;
}

function SettingsData({ features }: { readonly features: ReadonlySet<string> }) {
  return <section className="card settings-data-links" aria-labelledby="settings-data-title">
    <h2 id="settings-data-title">Workspace and diagnostics</h2>
    <p>Review your saved work or inspect a task when you need more detail.</p>
    <ul>
      <li><Link to="/dashboard">Dashboard</Link> — an overview of your workspace</li>
      {features.has("resumes") ? <li><Link to="/artifacts">Accepted materials</Link> — saved resume files</li> : null}
      {features.has("fit") ? <li><Link to="/evidence-map">Career evidence</Link> — profile sources and comparisons</li> : null}
      {features.has("preparation") ? <li><Link to="/pipelines">Preparation</Link> — inspect and manage preparation tasks</li> : null}
      <li><Link to="/runs">Task history</Link> — review work and its outcomes</li>
      <li><Link to="/debug">Recorded events</Link> — inspect detailed activity</li>
    </ul>
  </section>;
}
