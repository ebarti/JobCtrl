import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ProfileEditor } from "../contexts/profile/index.js";
import { prefetchProfileEditor } from "../contexts/profile/readQueries.js";
import { SearchPreferencesWorkspace } from "../views/search-preferences/SearchPreferencesWorkspace.js";

export const Route = createFileRoute("/preferences")({
  loader: ({ context }) => prefetchProfileEditor(context),
  component: PreferencesPage,
});

const legacySections = new Set(["preferences-application", "preferences-tailoring", "preferences-style", "preferences-templates"]);

function PreferencesPage() {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const requestedSection = legacySections.has(hash) ? hash : "";
  const [defaultsOpen, setDefaultsOpen] = useState(Boolean(requestedSection));
  const [defaultsMounted, setDefaultsMounted] = useState(Boolean(requestedSection));
  useEffect(() => {
    if (!requestedSection) return;
    setDefaultsMounted(true);
    setDefaultsOpen(true);
    const frame = requestAnimationFrame(() => document.getElementById(requestedSection)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [requestedSection]);
  return <>
    <SearchPreferencesWorkspace />
    <details className="preferences-existing-defaults" open={defaultsOpen} onToggle={(event) => {
      const open = event.currentTarget.open;
      setDefaultsOpen(open);
      if (open) setDefaultsMounted(true);
    }}>
      <summary>Application and resume defaults</summary>
      {defaultsMounted ? <ProfileEditor section="preferences" /> : null}
    </details>
  </>;
}
